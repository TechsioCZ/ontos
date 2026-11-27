import { createHash, randomUUID } from 'node:crypto';

import {
  ActiveApplicationCompositionSnapshotSchema,
  OntosModuleDeploymentContractSchema,
  OntosShellRuntimeContractSchema,
  applicationCompositionContentRevision,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makePublishedApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { grantTestTenantRoleAccess, liveFixtureSpiceDb } from '@app/core-runtime/testing/tenant-access';
import { makeApiKeyGatewayNativeFixture } from '@app/shell-super-app/testing/api-key-gateway-native';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { assert, expect, it } from 'effect-rstest';
import { Config, Duration, Effect, FileSystem, Layer, Option, Redacted, Schema } from 'effect';
import { FetchHttpClient, HttpBody, HttpClient } from 'effect/http';
import type { HttpClientResponse } from 'effect/http';
import { Reactivity } from 'effect/reactivity';

import {
  buildProductOwner,
  c14AppRoot,
  nativePortList,
  startProductOwner,
} from './support/symmy-c14-product-runtime.mts';

/*
 * D20 acceptance statement 7 of #1428 (#1446 D.12): Catalog's existing document Current read gets its answer from Core.
 *
 * Real, each in its own process: the compiled Catalog server (its own read, owner adapter, assignment tables, module
 * credential and delegation client), the production Shell (session upload routes, the delegated gateway route, the hosted
 * `asset-current` receiver and Core's Current read), PostgreSQL, SpiceDB, and the S3 adapter against an S3-compatible
 * EMULATOR (not a real provider). Nothing of Catalog or the Shell is imported: this test speaks their HTTP routes.
 * The Product and its Product and Variant assignments are written by Catalog's own Actions.
 *
 * Fixtures, not a claim: identities, grants, module activation and API-key bindings are seeded as an install would, and
 * the requester's Catalog assertion comes from the Shell fixture's setup key.
 *
 * Not run without an emulator (`CORE_MEDIA_S3_*`): it is skipped, or fails under `D20_E2E_REQUIRED=1`. It needs the
 * built Catalog, Market Catalog and Shell artifacts. Market Catalog is only the Shell fixture's second enrolled module
 * credential; its server is not started.
 */

const catalogApp = 'catalog';
const marketApp = 'commerce-market-catalog';
const catalogModule = 'commerce.catalog';
const capabilityKeys = [
  'commerce.catalog.product.create',
  'commerce.catalog.catalog-media.assign',
  'commerce.catalog.catalog-media.remove',
  'commerce.catalog.catalog-document-current.read',
  'core.media.asset.upload',
  'core.media.asset.confirm',
  'core.media.asset-current.read',
];

const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(Reactivity.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);

class HandoffStepRefused extends Schema.TaggedError<HandoffStepRefused>()('HandoffStepRefused', {
  message: Schema.String,
}) {}

const ModuleIdSchema = Schema.String.pipe(Schema.brand('ModuleId'));
const ResourceIdSchema = Schema.String.pipe(Schema.brand('ResourceId'));
const TenantIdSchema = Schema.String.pipe(Schema.brand('TenantId'));
const VariantIdSchema = Schema.String.pipe(Schema.brand('VariantId'));
const RevisionIdSchema = Schema.String.pipe(Schema.brand('RevisionId'));
const AssetRefSchema = Schema.Struct({
  moduleId: ModuleIdSchema,
  resourceId: ResourceIdSchema,
  resourceType: Schema.String,
  tenantId: TenantIdSchema,
});
/** A ref as it goes on the wire. */
type WireRef = typeof AssetRefSchema.Encoded;
const ReservationSchema = Schema.Struct({ mediaAssetRef: AssetRefSchema });
const UploadedSchema = Schema.Struct({ processingStatus: Schema.Literal('ready') });
const CreatedProductSchema = Schema.Struct({
  product: Schema.Struct({ productRef: AssetRefSchema }),
  variantId: VariantIdSchema,
});
const AssignedSchema = Schema.Struct({ setRevision: Schema.Int });
/** What Catalog's history keeps of one assignment, oldest first. */
const AssignmentHistorySchema = Schema.Array(Schema.Struct({ resource: Schema.String, state: Schema.String }));
const CurrentAnswerSchema = Schema.Struct({
  assignments: Schema.Array(
    Schema.Struct({
      assignment: Schema.Struct({ resourceRef: AssetRefSchema }),
      current: Schema.optionalKey(
        Schema.Struct({
          resourceRef: AssetRefSchema,
          revision: Schema.Int,
          revisionId: Schema.optionalKey(RevisionIdSchema),
        }),
      ),
      kind: Schema.String,
    }),
  ),
  setRevision: Schema.Int,
});

/** One request that must succeed; a refusal fails the test with the step, the status and the answered body. */
const accepted = Effect.fn('CoreMediaHandoff.accepted')(function* accepted<A, I, E, R>(
  step: string,
  schema: Schema.Codec<A, I>,
  request: Effect.Effect<HttpClientResponse.HttpClientResponse, E, R>,
) {
  const response = yield* request;
  const body = yield* response.text;
  if (response.status !== 200) {
    return yield* new HandoffStepRefused({ message: `${step} answered ${response.status}: ${body.slice(0, 600)}` });
  }
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(body);
});

/** A sealed composition of the published deployment documents; no owner's runtime source is read. */
const publishedComposition = Effect.fn('CoreMediaHandoff.composition')(function* publishedComposition(
  catalogOrigin: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const contracts = yield* Effect.forEach(
    [catalogApp, marketApp],
    (vertical) =>
      fs
        .readFileString(`${c14AppRoot}/verticals/${vertical}/dist/public/.well-known/ontos-module-manifest.json`)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema)))),
    { concurrency: 2 },
  );
  const runtimeDocument = yield* fs.readFileString(
    `${c14AppRoot}/apps/shell-super-app/dist/public/.well-known/ontos-shell-runtime.json`,
  );
  const runtime = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OntosShellRuntimeContractSchema))(
    runtimeDocument,
  );
  const base = yield* makePublishedApplicationCompositionSnapshotFixture({
    contractInputs: contracts,
    publishedShellRuntime: { document: runtimeDocument, receiverDeployment: runtime.deployment },
    validityMs: Duration.toMillis(Duration.minutes(30)),
  });
  const composition = {
    ...base.composition,
    modules: base.composition.modules.map((module) => ({
      ...module,
      backend: {
        baseUrl:
          module.deployment.appId === catalogApp ? catalogOrigin : `https://${module.deployment.appId}.example.test/`,
        transport: 'node-http' as const,
      },
    })),
  };
  const snapshot = yield* validateActiveApplicationCompositionSnapshot({
    ...base,
    composition: { ...composition, revision: yield* applicationCompositionContentRevision(composition) },
  });
  const catalog = contracts.find(({ deployment }) => deployment.appId === catalogApp);
  assert.isOk(catalog);
  return { catalog, snapshot };
});

const seedPrincipal = Effect.fn('CoreMediaHandoff.principal')(function* seedPrincipal(
  admin: PgClient.PgClient,
  tenantId: string,
  kind: 'human' | 'integration' | 'service',
  providerUserId?: string,
) {
  const principalId = randomUUID();
  yield* admin`insert into core.principals(principal_id,tenant_id,kind,status,display_name) values(${principalId},${tenantId},${kind},'active','D20 handoff fixture')`;
  if (providerUserId !== undefined) {
    yield* admin`insert into core.principal_auth_bindings(principal_auth_binding_id,tenant_id,principal_id,authentication_namespace_id,provider,subject_type,provider_subject_id,status)
      values(${randomUUID()},${tenantId},${principalId},${STAFF_AUTHENTICATION_NAMESPACE_ID},'better_auth','user',${providerUserId},'active')`;
  }
  return { principalId, tenantId };
});

const bindProviderKey = (
  admin: PgClient.PgClient,
  principal: { readonly principalId: string; readonly tenantId: string },
  providerKeyId: string,
) => admin`insert into core.principal_auth_bindings(principal_auth_binding_id,tenant_id,principal_id,authentication_namespace_id,provider,subject_type,provider_subject_id,status)
  values(${randomUUID()},${principal.tenantId},${principal.principalId},${STAFF_AUTHENTICATION_NAMESPACE_ID},'better_auth','api_key',${providerKeyId},'active')`;

type ShellFixture = Effect.Success<ReturnType<typeof makeApiKeyGatewayNativeFixture>>;

/**
 * Enrols the tenant's person and one module credential per source app; returns Catalog's own credential. Demo line:
 * each source module's key is provisioned by the platform for its own module principal, as the Shell fixture does it.
 */
const enrolIdentities = Effect.fn('CoreMediaHandoff.enrol')(function* enrolIdentities(
  admin: PgClient.PgClient,
  shell: ShellFixture,
  tenantId: string,
) {
  const person = yield* seedPrincipal(admin, tenantId, 'human', shell.providerUserId);
  const integration = yield* seedPrincipal(admin, tenantId, 'integration');
  const key = yield* shell.issueFixtureProviderKey({ ...integration, issuerPrincipalId: person.principalId });
  yield* bindProviderKey(admin, integration, key.providerKeyId);
  yield* key.acknowledgeBinding;
  yield* shell.provisionRelaySource();
  const catalogKey = yield* shell.provisionModuleSource(catalogApp);
  const setupKey = yield* shell.issueFixtureSetupActorKey();
  yield* bindProviderKey(admin, person, setupKey.providerKeyId);
  yield* setupKey.acknowledgeBinding;
  return { catalogCredential: catalogKey.secret, person };
});

/** The person's own session on the Shell: reserve a Media Asset, and optionally store its bytes until `ready`. */
const mediaAssets = Effect.fn('CoreMediaHandoff.mediaAssets')(function* mediaAssets(shell: ShellFixture) {
  const session = yield* shell.fixtureHumanSession();
  const client = yield* HttpClient.HttpClient;
  const api = `${shell.baseUrl}/shell-super-app-api`;
  const headers = { cookie: Redacted.value(session.cookie), origin: session.origin };
  const reserve = Effect.fn('CoreMediaHandoff.reserve')(function* reserve(bytes: Uint8Array, name: string) {
    const body = yield* HttpBody.json({
      declaredByteSize: bytes.byteLength,
      declaredContentSha256: createHash('sha256').update(bytes).digest('hex'),
      displayFilename: `${name}.pdf`,
      ingestionSource: 'user',
      mimeType: 'application/pdf',
    });
    const reserved = yield* accepted(
      `reserve ${name}`,
      ReservationSchema,
      client.post(`${api}/core/actions/upload-asset`, {
        body,
        headers: { ...headers, 'idempotency-key': `d20-handoff-reserve-${name}` },
      }),
    );
    return reserved.mediaAssetRef;
  });
  const store = (mediaAssetId: string, bytes: Uint8Array) =>
    accepted(
      `store ${mediaAssetId}`,
      UploadedSchema,
      client.put(`${api}/core/media/assets/${mediaAssetId}/bytes`, {
        body: HttpBody.uint8Array(bytes, 'application/octet-stream'),
        headers,
      }),
    );
  return { reserve, store };
});

/** Catalog's public routes, each call under its own fresh assertion of the person. */
const catalogClient = Effect.fn('CoreMediaHandoff.catalogClient')(function* catalogClient(
  shell: ShellFixture,
  origin: string,
  compositionRevision: string,
) {
  const client = yield* HttpClient.HttpClient;
  const post = Effect.fn('CoreMediaHandoff.catalogPost')(function* post<A, I>(
    path: string,
    schema: Schema.Codec<A, I>,
    payload: Schema.Json,
    idempotencyKey?: string,
  ) {
    const gateway = yield* shell.issueFixtureSetupGateway({ audience: catalogApp });
    const headers = {
      authorization: `Bearer ${gateway.token}`,
      'x-correlation-id': randomUUID(),
      'x-ontos-composition-revision': compositionRevision,
    };
    return yield* accepted(
      path,
      schema,
      client.post(`${origin}/catalog-api${path}`, {
        body: yield* HttpBody.json(payload),
        headers: idempotencyKey === undefined ? headers : { ...headers, 'idempotency-key': idempotencyKey },
      }),
    );
  });
  return { post };
});

const available = (ref: WireRef) => ({
  assigned: ref.resourceId,
  kind: 'AVAILABLE',
  revision: { resourceRef: ref, revision: 1 },
});
const without = (ref: WireRef, kind: string) => ({ assigned: ref.resourceId, kind, revision: null });

it.live(
  "D20 handoff: Catalog's own document Current read is answered by Core through the real Shell receiver",
  (ctx) =>
    Effect.scoped(
      Effect.gen(function* realCatalogHandoff() {
        const emulator = yield* Config.option(Config.String('CORE_MEDIA_S3_ENDPOINT'));
        if (Option.isNone(emulator)) {
          const required = yield* Config.option(Config.String('D20_E2E_REQUIRED'));
          assert.isFalse(Option.contains(required, '1'), 'D20_E2E_REQUIRED is set but there is no S3 emulator');
          // BLOCKED, not passed: the run is not configured with an object-store emulator.
          return yield* Effect.sync(() => ctx.skip());
        }
        const [catalogPort] = yield* nativePortList(1);
        assert.isDefined(catalogPort);
        const catalogOrigin = `http://127.0.0.1:${catalogPort}`;
        const { catalog, snapshot } = yield* publishedComposition(`${catalogOrigin}/`);
        const database = yield* makeIsolatedNativeDatabaseFixture({
          compositionSnapshot: snapshot,
          mode: 'schema-only',
          purpose: 'implementation-1096-registered-workload-gateway',
        });
        const admin = yield* PgClient.make({ url: Redacted.make(database.connections.admin.connectionString) });
        const shell = yield* makeApiKeyGatewayNativeFixture({
          additionalRelaySources: [{ sourceAppId: catalogApp }],
          ownedDatabase: database,
          productionGate: true,
          relaySource: { sourceAppId: marketApp },
          snapshotJson: yield* Schema.encodeEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema))(
            snapshot,
          ),
        });

        const tenantId = randomUUID();
        const legalEntityId = randomUUID();
        const slug = `d20-handoff-${tenantId}`;
        yield* admin`insert into core.tenants(tenant_id,name,slug,status,default_locale) values(${tenantId},'D20 handoff fixture',${slug},'active','en')`;
        yield* admin`insert into core.legal_entities(legal_entity_id,tenant_id,legal_name,registration_country,registration_number,status) values(${legalEntityId},${tenantId},'D20 handoff company','CZ','D20-HANDOFF','active')`;
        for (const moduleKey of [...snapshot.composition.modules.map(({ moduleId }) => moduleId), 'core.media']) {
          yield* admin`insert into core.tenant_module_states(tenant_id,module_key,state) values(${tenantId},${moduleKey},'active')`;
        }
        const { catalogCredential, person } = yield* enrolIdentities(admin, shell, tenantId);
        yield* grantTestTenantRoleAccess({
          holders: [{ capabilityKeys, principalId: person.principalId }],
          legalEntityIds: [legalEntityId],
          spiceDb: yield* liveFixtureSpiceDb(
            yield* Config.all({
              SPICEDB_CA_CERT: Config.String('SPICEDB_CA_CERT'),
              SPICEDB_ENDPOINT: Config.String('SPICEDB_ENDPOINT'),
              SPICEDB_PRESHARED_KEY: Config.Redacted('SPICEDB_PRESHARED_KEY'),
            }),
          ),
          tenantId,
          // Demo line: the role rows are written through the clone's runtime login, as every demo caller writes them.
          writerConnectionString: Redacted.make(database.connections.runtime.connectionString),
        });

        const owner = yield* startProductOwner({
          artifacts: yield* buildProductOwner(catalog),
          contract: catalog,
          environment: {
            APP_ENV_PATH: '/dev/null',
            // Catalog holds no object store: it can only learn about a stored file by asking Core.
            CORE_MEDIA_S3_ACCESS_KEY_ID: '',
            CORE_MEDIA_S3_BUCKET: '',
            CORE_MEDIA_S3_ENDPOINT: '',
            CORE_MEDIA_S3_SECRET_ACCESS_KEY: '',
            DATABASE_ADMIN_URL: database.connections.admin.connectionString,
            DATABASE_URL: database.connections.runtime.connectionString,
            ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: shell.compositionSourceUrl,
            ONTOS_C14_TRACE_PROBLEMS: 'true',
            ONTOS_GATEWAY_ISSUER: shell.issuer,
            ONTOS_GATEWAY_MODULE_API_KEY: Redacted.value(catalogCredential),
            ONTOS_GATEWAY_PUBLIC_JWKS: shell.publicJwks,
            ONTOS_SHELL_GATEWAY_BASE_URL: `${shell.baseUrl}/shell-super-app-api`,
          },
          port: catalogPort,
          prefix: '/catalog-api',
        });

        // Two real assets in Core: one stored until `ready`, one only reserved. The third id was never issued.
        const media = yield* mediaAssets(shell);
        const readyBytes = new TextEncoder().encode('D20 handoff: the confirmed document');
        const pendingBytes = new TextEncoder().encode('D20 handoff: the not yet confirmed document');
        const ready = yield* media.reserve(readyBytes, 'ready');
        yield* media.store(ready.resourceId, readyBytes);
        const pending = yield* media.reserve(pendingBytes, 'pending');
        const unknown = { ...ready, resourceId: randomUUID() };

        const catalogApi = yield* catalogClient(shell, catalogOrigin, snapshot.composition.revision);
        const created = yield* catalogApi.post(
          '/catalog/actions/create-product',
          CreatedProductSchema,
          { name: 'D20 handoff product' },
          'd20-handoff-product',
        );
        const { productRef } = created.product;
        const variantRef = {
          moduleId: catalogModule,
          resourceId: created.variantId,
          resourceType: 'commerce.catalog.variant',
          tenantId,
        };
        const assign = (
          subjectRef: WireRef,
          resourceRef: WireRef,
          order: number,
          { assignmentId = randomUUID(), expectedSetRevision = order - 1 } = {},
        ) =>
          catalogApi.post(
            '/catalog/actions/assign-catalog-media',
            AssignedSchema,
            {
              assignmentId,
              evidenceRefs: [],
              expectedSetRevision,
              order,
              purpose: `document ${order}`,
              reason: 'D20 handoff assignment',
              resourceKind: 'DOCUMENT',
              resourceRef,
              subjectRef,
            },
            `d20-handoff-assign-${assignmentId}`,
          );
        const originalAssignmentId = randomUUID();
        yield* assign(productRef, ready, 1, { assignmentId: originalAssignmentId });
        yield* assign(productRef, pending, 2);
        yield* assign(productRef, unknown, 3);
        yield* assign(variantRef, pending, 1);

        const current = (target: WireRef) =>
          catalogApi.post('/reads/catalog-document-current', CurrentAnswerSchema, { target }).pipe(
            Effect.map(({ assignments }) =>
              assignments.map(({ assignment, current: revision, kind }) => ({
                assigned: assignment.resourceRef.resourceId,
                kind,
                revision: revision ?? null,
              })),
            ),
            Effect.catchTag('HandoffStepRefused', (refused) =>
              owner.diagnostic.pipe(
                Effect.flatMap((diagnostic) =>
                  Effect.fail(new HandoffStepRefused({ message: `${refused.message}\n${diagnostic}` })),
                ),
              ),
            ),
          );
        const delegated = shell.gatewayDiagnostics().pipe(Effect.map((outcomes) => outcomes.length));
        const delegatedBefore = yield* delegated;

        expect(yield* current(productRef)).toEqual([
          available(ready),
          without(pending, 'CURRENT_UNVERIFIED'),
          without(unknown, 'ABSENT'),
        ]);
        expect(yield* current(variantRef)).toEqual([without(pending, 'CURRENT_UNVERIFIED')]);

        // Only Core's own state changes: the same Catalog assignments now answer AVAILABLE.
        yield* media.store(pending.resourceId, pendingBytes);
        expect(yield* current(variantRef)).toEqual([available(pending)]);
        expect(yield* current(productRef)).toEqual([available(ready), available(pending), without(unknown, 'ABSENT')]);

        // Storing another file changes no assignment: the Product stays on what it was given (#1446 D.15).
        const replacementBytes = new TextEncoder().encode('D20 handoff: the replacement document');
        const replacement = yield* media.reserve(replacementBytes, 'replacement');
        yield* media.store(replacement.resourceId, replacementBytes);
        expect(yield* current(productRef)).toEqual([available(ready), available(pending), without(unknown, 'ABSENT')]);

        // Each read made Catalog fetch its own delegated credential from the Shell: nothing was answered locally.
        const outcomes = yield* shell.gatewayDiagnostics();
        expect(outcomes.slice(delegatedBefore)).toEqual(
          Array.from({ length: 5 }, () => ({ problem: 'success', status: 200 })),
        );

        // Replacing is Catalog's own explicit choice: remove the old assignment, then assign the new file.
        const removed = yield* catalogApi.post(
          '/catalog/actions/remove-catalog-media',
          AssignedSchema,
          {
            assignmentId: originalAssignmentId,
            evidenceRefs: [],
            expectedSetRevision: 3,
            reason: 'D20 handoff replacement',
            subjectRef: productRef,
          },
          `d20-handoff-remove-${originalAssignmentId}`,
        );
        yield* assign(productRef, replacement, 1, { expectedSetRevision: removed.setRevision });
        expect(yield* current(productRef)).toEqual([
          available(replacement),
          available(pending),
          without(unknown, 'ABSENT'),
        ]);

        // The history still says which file the removed assignment named, and Core still holds that file.
        const history = yield* admin`select owner_resource_id::text as resource, state
          from catalog.catalog_media_assignment_revisions
          where tenant_id = ${tenantId} and assignment_id = ${originalAssignmentId}
          order by revision`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(AssignmentHistorySchema)));
        expect(history).toEqual([
          { resource: ready.resourceId, state: 'ACTIVE' },
          { resource: ready.resourceId, state: 'REMOVED' },
        ]);
        expect(yield* current(variantRef)).toEqual([available(pending)]);
        const kept = yield* admin`select processing_status as status from core.media_assets
          where tenant_id = ${tenantId} and media_asset_id = ${ready.resourceId}`;
        expect(kept).toEqual([{ status: 'ready' }]);
        return yield* Effect.void;
      }),
    ).pipe(Effect.provide(services)),
  { timeout: 600_000 },
);
