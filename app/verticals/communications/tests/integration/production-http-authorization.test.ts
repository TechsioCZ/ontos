import { createHash, randomUUID } from 'node:crypto';

import {
  applicationCompositionContentRevision,
  closeApplicationCompositionDurableAdmission,
  drainApplicationCompositionAuthority,
  loadDatabaseConnectionPair,
  lockApplicationCompositionPublication,
  OntosModuleDeploymentContractSchema,
  publishApplicationCompositionAuthority,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import type { ApplicationComposition } from '@app/core-runtime';
import { ActiveApplicationCompositionSnapshotSchema } from '@app/core-runtime/modules/active-application-composition';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { environmentTestAccessTarget, grantTestTenantRoleAccess } from '@app/core-runtime/testing/tenant-access';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION, GATEWAY_ASSERTION_TTL_SECONDS } from '@app/shared-contracts';
import { NodeCrypto, NodeHttpServer, NodeServices } from '@effect/platform-node';
import { eq, sql } from 'drizzle-orm';
import { ConfigProvider, Context, DateTime, Effect, FileSystem, Layer, Option, Redacted, Schema } from 'effect';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { NetAddress } from 'effect/net';
import { Reactivity } from 'effect/reactivity';
import { describe, expect, it } from 'effect-rstest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { CryptoKey, JWK } from 'jose';

import { applicationCompositionAuthority, coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import { loadSpiceDbConfig } from '../../../../packages/core-runtime/src/permissions/config.ts';
import { makeTestTenantRoleAccess } from '../../../../packages/core-runtime/src/testing/tenant-access-roles.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { makeCommunicationsApiRuntime } from '../../api/index.ts';
import type { LanguagePolicyRequestSchema } from '../../shared/apis/language-policy.ts';
import type { SetLanguagePolicyPayloadSchema } from '../../shared/language-policy.ts';
import { EffectiveLanguagePolicySchema, SetLanguagePolicyResultSchema } from '../../shared/language-policy.ts';
import type { MessageHistoryListRequestFieldsSchema } from '../../shared/message-history-read.ts';
import { MessageHistoryListResultSchema } from '../../shared/message-history-read.ts';
import { communicationRequest, originalRecipient } from '../support/intake-fixtures.ts';
import { decided, intakeWorld } from '../support/intake-world.ts';
import { makeRuntimeDatabase } from '../support/persistence.fixture.ts';
import { ultramodernApiMarker, ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';

/*
 * Q-AUTHZ (#1408, E01/E10/E12/E17): Communications Actions and Reads through the PRODUCTION HTTP assembly of the module
 * (`makeCommunicationsApiRuntime`, the same layers as the default export) with a Shell-shaped Ed25519 gateway assertion,
 * the production durable assertion redemption, the production access decision against the REAL SpiceDB of the test
 * environment (Core access intent written by Core's own bootstrap and projection writer) and native PostgreSQL.
 *
 * What this does NOT cover: the Shell process itself issuing the assertion (the assertion is signed here with a test key
 * the runtime is configured to trust, exactly as other owners' production HTTP acceptance tests do).
 */

const ORIGIN = 'http://communications.production-http.test';
const ISSUER = 'https://shell.communications-production-http.test';
const KEY_ID = 'communications-production-http';
const LANGUAGE_READ = 'communications.core.language-policy.read';
const LANGUAGE_SET = 'communications.core.language-policy.set';
const HISTORY_LIST = 'communications.core.message-history.list';

interface Gateway {
  readonly privateKey: CryptoKey;
  readonly publicJwk: JWK;
}

interface Principal {
  readonly authBindingId: string;
  readonly authContextRef: string;
  readonly authMethod: string;
  readonly legalEntityId?: string;
  readonly principalId: string;
  readonly tenantId: string;
}

const makeGateway = Effect.fnUntraced(function* makeGateway() {
  const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519'));
  const publicJwk: JWK = {
    ...(yield* Effect.promise(() => exportJWK(publicKey))),
    alg: 'EdDSA',
    kid: KEY_ID,
    use: 'sig',
  };
  return { privateKey, publicJwk } satisfies Gateway;
});

const digest = (value: string) => createHash('sha256').update(value, 'utf-8').digest('hex');

const ContractDocumentSchema = Schema.fromJsonString(OntosModuleDeploymentContractSchema);

/**
 * One composition module from the actual Codesmith deployment artifact of this workspace. Its deployment identity is the
 * release under test: these source-mode runtime layers always run as the workspace build marker, while the generator stamps
 * a promotable release marker whenever the Git tree is clean, so the approved release is pinned to the runtime's own.
 */
const publishedModule = Effect.fnUntraced(function* publishedModule(
  manifestPath: URL,
  requiredShellAbi: ApplicationComposition['modules'][number]['requiredShellAbi'],
) {
  const filesystem = yield* FileSystem.FileSystem;
  const generated = yield* Schema.decodeUnknownEffect(ContractDocumentSchema)(
    yield* filesystem.readFileString(manifestPath.pathname),
  );
  const contract = {
    ...generated,
    deployment: { ...generated.deployment, buildMarker: ultramodernDeliveryUnit.buildMarker },
  };
  const document = yield* Schema.encodeEffect(ContractDocumentSchema)(contract);
  return {
    allowedContributions: [],
    backend: { baseUrl: `https://${contract.deployment.appId}.native-tests.example/`, transport: 'node-http' },
    contract: {
      sha256: digest(document),
      url: `https://${contract.deployment.appId}.native-tests.example/.well-known/ontos-module-manifest.json`,
    },
    contractDocument: document,
    dependencies: [],
    deployment: contract.deployment,
    federation: { execution: 'server' },
    moduleId: contract.manifest.module.id,
    publicContract: { id: contract.manifest.module.id, sha256: digest(document), version: contract.schemaVersion },
    requiredCoreCapabilities: [],
    requiredShellAbi,
    sharedSingletons: [],
  } satisfies ApplicationComposition['modules'][number];
});

/** The active composition with the actual Communications deployment, published as the Core authority and served. */
const publishComposition = Effect.fnUntraced(function* publishComposition() {
  const base = yield* makeApplicationCompositionSnapshotFixture([]);
  const communications = yield* publishedModule(
    new URL('../../dist/public/.well-known/ontos-module-manifest.json', import.meta.url),
    base.composition.shell.contributionAbi,
  );
  const input = { ...base.composition, modules: [communications] };
  const snapshot = yield* validateActiveApplicationCompositionSnapshot({
    composition: { ...input, revision: yield* applicationCompositionContentRevision(input) },
    observedAt: base.observedAt,
    validUntil: base.validUntil,
  });
  const { admin } = yield* testDatabaseClients;
  const core = yield* makeTestDatabaseFromClient(admin, coreRelations);
  yield* core.transaction((transaction) =>
    Effect.gen(function* publish() {
      yield* lockApplicationCompositionPublication(transaction);
      const [predecessor] = yield* transaction
        .select({ revision: applicationCompositionAuthority.revision })
        .from(applicationCompositionAuthority)
        .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
      if (predecessor !== undefined && predecessor.revision !== snapshot.composition.revision) {
        yield* closeApplicationCompositionDurableAdmission(transaction, predecessor.revision);
        yield* drainApplicationCompositionAuthority(transaction, predecessor.revision);
      }
      yield* publishApplicationCompositionAuthority(transaction, snapshot);
    }),
  );
  const document = yield* Schema.encodeEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema))(
    snapshot,
  );
  return { core, document, snapshot };
});

const activateCommunications = (
  core: Effect.Success<ReturnType<typeof publishComposition>>['core'],
  tenantId: string,
) =>
  core.transaction((transaction) =>
    transaction.execute(
      sql`insert into core.tenant_module_states (tenant_id, module_key, state)
          values (${tenantId}::uuid, 'communications.core', 'active')
          on conflict (tenant_id, module_key) do update set state = excluded.state`,
      'objects',
    ),
  );

/** The composition document served the way the Node composition source reads it: one loopback HTTP endpoint. */
const serveComposition = Effect.fnUntraced(function* serveComposition(compositionDocument: string) {
  const server = Context.get(yield* Layer.build(NodeHttpServer.layerTest), HttpServer.HttpServer);
  yield* server.serve(
    HttpServerRequest.HttpServerRequest.use((request) =>
      Effect.succeed(
        request.method === 'GET' && request.url === '/active'
          ? HttpServerResponse.text(compositionDocument, {
              contentType: 'application/json',
              headers: { 'cache-control': 'no-store' },
            })
          : HttpServerResponse.empty({ status: 404 }),
      ),
    ),
  );
  if (!NetAddress.isInetAddress(server.address)) {
    return yield* Effect.die('The composition source must bind one loopback TCP server');
  }
  return `http://127.0.0.1:${server.address.port}/active`;
});

/** The production HTTP assembly over this environment's database, SpiceDB and the test gateway's public key. */
const mountRuntime = Effect.fnUntraced(function* mountRuntime(gateway: Gateway, compositionDocument: string) {
  const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
  const spiceDb = yield* loadSpiceDbConfig({ envPath: '/dev/null' });
  // SpiceDB is reached over TLS only; the test environment pins its development certificate.
  const caCertificate = yield* Effect.fromOption(Option.fromUndefinedOr(spiceDb.caCertificate));
  const configuration = {
    DATABASE_URL: connections.runtime.connectionString,
    ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: yield* serveComposition(compositionDocument),
    ONTOS_GATEWAY_ISSUER: ISSUER,
    ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [gateway.publicJwk] }),
    SPICEDB_CA_CERT: caCertificate,
    SPICEDB_ENDPOINT: spiceDb.endpoint,
    SPICEDB_PRESHARED_KEY: spiceDb.preSharedKey,
  };
  const assembled = makeCommunicationsApiRuntime(ConfigProvider.fromUnknown(configuration));
  return yield* Effect.acquireRelease(
    Effect.sync(() => assembled.createHandler()),
    (runtime) => Effect.promise(() => runtime.dispose()).pipe(Effect.orDie),
  );
});

type Runtime = Effect.Success<ReturnType<typeof mountRuntime>>;

/** A fresh Shell-shaped staff assertion (new JTI, staff namespace) for exactly this principal and company selection. */
const assertionFor = Effect.fnUntraced(function* assertionFor(
  gateway: Gateway,
  compositionRevision: string,
  principal: Principal,
) {
  const issuedAt = Math.floor((yield* DateTime.nowAsDate).getTime() / 1000);
  const claims = {
    authBindingId: principal.authBindingId,
    authContextRef: principal.authContextRef,
    authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
    authMethod: principal.authMethod,
    principalId: principal.principalId,
    tenantId: principal.tenantId,
  };
  return yield* Effect.promise(() =>
    new SignJWT({
      compositionRevision,
      principal: principal.legalEntityId === undefined ? claims : { ...claims, legalEntityId: principal.legalEntityId },
      targetBuildMarker: ultramodernApiMarker.buildMarker,
      ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: KEY_ID, typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience('communications')
      .setSubject(principal.principalId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + GATEWAY_ASSERTION_TTL_SECONDS)
      .setJti(randomUUID())
      .sign(gateway.privateKey),
  );
});

/** Exactly the public request bodies this suite sends. */
type RequestBody =
  | typeof LanguagePolicyRequestSchema.Encoded
  | typeof MessageHistoryListRequestFieldsSchema.Encoded
  | typeof SetLanguagePolicyPayloadSchema.Encoded;

const ReplyBodySchema = Schema.fromJsonString(Schema.Unknown);

const post = Effect.fnUntraced(function* post(
  runtime: Runtime,
  token: string,
  path: string,
  body: RequestBody,
  idempotent: boolean,
) {
  const headers = new Headers({
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    origin: ORIGIN,
    'x-correlation-id': `communications-production-http-${randomUUID()}`,
  });
  if (idempotent) {
    headers.set('idempotency-key', randomUUID());
  }
  const response = yield* Effect.promise(() =>
    runtime.handler(new Request(`${ORIGIN}${path}`, { body: JSON.stringify(body), headers, method: 'POST' })),
  );
  const text = yield* Effect.promise(() => response.text());
  return { body: yield* Schema.decodeUnknownEffect(ReplyBodySchema)(text), status: response.status };
});

const services = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, Reactivity.layer);

describe('Communications production HTTP with the real authorization engine (SpiceDB) and native PostgreSQL', () => {
  it.live(
    'allows, denies, revokes and isolates Tenant language policy and history through real SpiceDB decisions',
    () =>
      Effect.scoped(
        Effect.gen(function* realEngine() {
          const { core, document, snapshot } = yield* publishComposition();
          const { revision } = snapshot.composition;
          const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
          const fixtureOf = Effect.fnUntraced(function* fixtureOf() {
            const fixture = yield* makeLiveOperationFixture({
              access: 'allowed',
              additionalLegalEntity: 'same-tenant',
              authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
              compositionRevision: revision,
              runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
            });
            yield* Effect.addFinalizer(() => fixture.close().pipe(Effect.orDie));
            yield* activateCommunications(core, fixture.tenantId);
            return fixture;
          });
          const tenant = yield* fixtureOf();
          const foreign = yield* fixtureOf();
          const target = yield* environmentTestAccessTarget;
          // The manager holds read + list in every scope of its own Tenant; the foreign manager holds everything in
          // the foreign Tenant only; the reader is a member without any Communications capability.
          yield* grantTestTenantRoleAccess({
            ...target,
            holders: [
              { capabilityKeys: [LANGUAGE_READ, HISTORY_LIST], principalId: tenant.manager.principalId },
              { capabilityKeys: ['party.registry.party.read'], principalId: tenant.reader.principalId },
            ],
            legalEntityIds: [tenant.legalEntityId],
            tenantId: tenant.tenantId,
          });
          yield* grantTestTenantRoleAccess({
            ...target,
            holders: [
              {
                capabilityKeys: [LANGUAGE_READ, LANGUAGE_SET, HISTORY_LIST],
                principalId: foreign.manager.principalId,
              },
            ],
            legalEntityIds: [foreign.legalEntityId],
            tenantId: foreign.tenantId,
          });
          // The second company of the Tenant: the manager is a genuine member there too, and the reader holds the
          // history list in the companies only (never in the Tenant context).
          const secondary = yield* Effect.fromOption(Option.fromUndefinedOr(tenant.secondaryLegalEntity));
          yield* grantTestTenantRoleAccess({
            ...target,
            assignmentScope: 'companies',
            holders: [
              { capabilityKeys: ['party.registry.party.read'], principalId: tenant.manager.principalId },
              { capabilityKeys: [HISTORY_LIST], principalId: tenant.reader.principalId },
            ],
            legalEntityIds: [tenant.legalEntityId, secondary.legalEntityId],
            tenantId: tenant.tenantId,
          });
          // Real history rows of this Tenant, decided through the owner's intake on native PostgreSQL: one of each
          // company and one of the Tenant itself. Only a Tenant or Legal Entity scope, so no source visibility applies.
          const world = yield* intakeWorld(yield* makeRuntimeDatabase(), { tenantId: tenant.tenantId });
          const submitIn = (occurrenceId: string, legalEntityId?: string) =>
            world.runner
              .submit(
                tenant.tenantId,
                communicationRequest(
                  legalEntityId === undefined
                    ? { bindings: [originalRecipient('customer-1')], occurrenceId, tenantId: tenant.tenantId }
                    : {
                        bindings: [originalRecipient('customer-1')],
                        legalEntityId,
                        occurrenceId,
                        tenantId: tenant.tenantId,
                      },
                ),
                '00000000-0000-4000-8000-0000000000a9',
                'fixture.source',
                legalEntityId,
              )
              .pipe(Effect.map(decided));
          yield* submitIn('production-http-company-one', tenant.legalEntityId);
          yield* submitIn('production-http-company-two', secondary.legalEntityId);
          yield* submitIn('production-http-tenant');
          const gateway = yield* makeGateway();
          const runtime = yield* mountRuntime(gateway, document);
          const send = (principal: Principal, path: string, body: RequestBody, idempotent = false) =>
            assertionFor(gateway, revision, principal).pipe(
              Effect.flatMap((token) => post(runtime, token, path, body, idempotent)),
            );
          // The fixture's principals carry no company selection: a request in the Tenant context.
          const { manager, reader } = tenant;

          // ALLOWED: the real gate grants the Read the manager's role carries
          const read = yield* send(manager, '/reads/language-policy', {});
          expect(read.status, JSON.stringify(read.body)).toBe(200);
          expect(Schema.decodeUnknownSync(EffectiveLanguagePolicySchema)(read.body).mode).toBe('B');

          // DENIED: the role does not carry `set`, so the real gate refuses the Action and nothing is written
          const deniedSet = yield* send(manager, '/communications/actions/set-language-policy', { mode: 'A' }, true);
          expect(deniedSet.status, JSON.stringify(deniedSet.body)).toBe(403);
          // a member of the Tenant without any Communications capability cannot even read
          const readerRead = yield* send(reader, '/reads/language-policy', {});
          expect(readerRead.status, JSON.stringify(readerRead.body)).toBe(403);

          // GRANTED THEN REVOKED: a role of exactly `set`, assigned through Core's people store and projected into
          // SpiceDB, admits the Action; ending the assignment makes the very next request fail, with no cache.
          const roles = yield* makeTestTenantRoleAccess({
            ...target,
            legalEntityIds: [tenant.legalEntityId],
            principalId: tenant.manager.principalId,
            tenantId: tenant.tenantId,
          });
          const setter = yield* roles.capabilityRole([LANGUAGE_SET]);
          yield* setter.grant();
          const granted = yield* send(manager, '/communications/actions/set-language-policy', { mode: 'A' }, true);
          expect(granted.status, JSON.stringify(granted.body)).toBe(200);
          const result = Schema.decodeUnknownSync(SetLanguagePolicyResultSchema)(granted.body);
          expect(result.changed).toBe(true);
          expect(result.effective.mode).toBe('A');
          yield* setter.revoke();
          const revoked = yield* send(manager, '/communications/actions/set-language-policy', { mode: 'B' }, true);
          expect(revoked.status, JSON.stringify(revoked.body)).toBe(403);
          const afterRevoke = yield* send(manager, '/reads/language-policy', {});
          expect(Schema.decodeUnknownSync(EffectiveLanguagePolicySchema)(afterRevoke.body).mode).toBe('A');

          // CROSS-TENANT: the foreign Tenant's choice is its own; it neither sees nor changes this Tenant's mode
          const { manager: foreignManager } = foreign;
          const foreignRead = yield* send(foreignManager, '/reads/language-policy', {});
          expect(foreignRead.status, JSON.stringify(foreignRead.body)).toBe(200);
          expect(Schema.decodeUnknownSync(EffectiveLanguagePolicySchema)(foreignRead.body).mode).toBe('B');
          // an assertion that claims the foreign manager in THIS Tenant names a principal Core does not know there
          const forgedTenant = yield* send(
            { ...foreignManager, tenantId: tenant.tenantId },
            '/reads/language-policy',
            {},
          );
          expect([401, 403]).toContain(forgedTenant.status);

          // EXACT LEGAL ENTITY SCOPE: one Tenant-wide grant, three selections, three disjoint histories. The selection is
          // Core's trusted context (never a request field) and the owner query matches it exactly, never widening.
          const occurrencesIn = Effect.fnUntraced(function* occurrencesIn(principal: Principal) {
            const reply = yield* send(principal, '/reads/message-history-list', {});
            expect(reply.status, JSON.stringify(reply.body)).toBe(200);
            return Schema.decodeUnknownSync(MessageHistoryListResultSchema)(reply.body).items.map(
              (item) => item.source.occurrence.occurrenceId,
            );
          });
          expect(yield* occurrencesIn({ ...manager, legalEntityId: tenant.legalEntityId })).toEqual([
            'production-http-company-one',
          ]);
          expect(yield* occurrencesIn(secondary.manager)).toEqual(['production-http-company-two']);
          expect(yield* occurrencesIn(manager)).toEqual(['production-http-tenant']);
          // the foreign Tenant, holding the same capability, sees none of them
          expect(yield* occurrencesIn(foreignManager)).toEqual([]);
          // A role held only in the companies does not grant this Read: Core decides it in the Tenant context.
          const companyOnly = yield* send(
            { ...reader, legalEntityId: tenant.legalEntityId },
            '/reads/message-history-list',
            {},
          );
          expect(companyOnly.status, JSON.stringify(companyOnly.body)).toBe(403);

          // Every allow and deny above is a decision the real engine recorded, with its reason, in this Tenant only.
          const decisions = yield* core.transaction((transaction) =>
            transaction.execute<{
              readonly actor: string;
              readonly capability: string;
              readonly outcome: string;
              readonly scope: string;
            }>(
              sql`select l.actor_principal_id::text as actor, l.capability_key as capability, l.outcome,
                         coalesce(s.legal_entity_id::text, 'tenant') as scope
                    from core.access_decision_logs l
                    join core.access_scopes s on s.tenant_id = l.tenant_id and s.scope_id = l.scope_id
                   where l.tenant_id = ${tenant.tenantId}::uuid and l.capability_key like 'communications.core.%'
                   order by l.decided_at, l.decision_log_id`,
              'objects',
            ),
          );
          const seen = (actor: string, capability: string, outcome: string, scope = 'tenant') =>
            decisions.some(
              (row) =>
                row.actor === actor && row.capability === capability && row.outcome === outcome && row.scope === scope,
            );
          const { principalId: managerId } = manager;
          expect(seen(managerId, LANGUAGE_READ, 'ALLOWED')).toBe(true);
          expect(seen(tenant.reader.principalId, LANGUAGE_READ, 'DENIED')).toBe(true);
          expect(
            decisions
              .filter((row) => row.capability === LANGUAGE_SET && row.actor === managerId)
              .map(({ outcome }) => outcome)
              .filter((outcome, index, all) => index === 0 || all[index - 1] !== outcome),
          ).toEqual(['DENIED', 'ALLOWED', 'DENIED']);
          expect(seen(managerId, HISTORY_LIST, 'ALLOWED')).toBe(true);
          expect(seen(tenant.reader.principalId, HISTORY_LIST, 'DENIED')).toBe(true);
          // the recipient mask is a separate capability the role does not carry, decided separately
          expect(seen(managerId, 'communications.core.message-history-recipient-mask.list', 'DENIED')).toBe(true);
          // the foreign Tenant's decisions are not this Tenant's
          expect(decisions.some((row) => row.actor === foreign.manager.principalId)).toBe(false);
        }),
      ).pipe(Effect.provide(services)),
    120_000,
  );
});
