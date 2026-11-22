import { createHash, randomUUID } from 'node:crypto';

import {
  ActiveApplicationCompositionService,
  applicationCompositionContentRevision,
  closeApplicationCompositionDurableAdmission,
  drainApplicationCompositionAuthority,
  loadDatabaseConnectionPair,
  lockApplicationCompositionPublication,
  makeActiveApplicationCompositionService,
  OntosModuleDeploymentContractSchema,
  OutboxRepositoryLive,
  OutboxRuntime,
  OutboxRuntimeLive,
  publishApplicationCompositionAuthority,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import type {
  ApplicationComposition,
  OutboxCycleError,
  OutboxCycleResult,
  OutboxRuntimeService,
  OutboxWorkerHandlerContext,
} from '@app/core-runtime';
import { ActiveApplicationCompositionSnapshotSchema } from '@app/core-runtime/modules/active-application-composition';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import {
  defineOutboxWorkerEntry,
  extractOutboxWorkerSubscriptions,
  OutboxWorkerTenantScope,
} from '@app/core-runtime/outbox/worker';
import { communicationsRegistration } from '../../vertical.registration.ts';
import { outboxWorkers } from '../../src/workers/index.ts';
import { CoreDatabase, makeCoreDatabase } from '@app/core-runtime/db/client';
import type { OutboxWorkerTenantScopeView } from '@app/core-runtime/outbox/worker';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import {
  createPrivacyMeasureDispatch,
  OwnerExecutionOutcomeRequestSchema,
  PrivacyMeasureHandoffSchema,
  prepareOwnerActionRequest,
  recordOwnerExecutionOutcome,
  validateOwnerExecutionAuthorityResult,
} from '@app/privacy/domain/privacy-measure-handoff';
import type { PrivacyMeasureHandoff } from '@app/privacy/domain/privacy-measure-handoff';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { environmentTestAccessTarget, grantTestTenantRoleAccess } from '@app/core-runtime/testing/tenant-access';
import {
  DELEGATED_GATEWAY_ASSERTION_VERSION,
  EXTERNAL_GATEWAY_ASSERTION_VERSION,
  GATEWAY_ASSERTION_TTL_SECONDS,
  GatewayDelegatedContextRequestSchema,
  privacyDispatchConsumers,
} from '@app/shared-contracts';
import { NodeCrypto, NodeHttpServer, NodeServices } from '@effect/platform-node';
import { eq, sql } from 'drizzle-orm';
import {
  ConfigProvider,
  Context,
  Crypto,
  DateTime,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Ref,
  Schema,
} from 'effect';
import type { Exit } from 'effect';
import { FetchHttpClient, HttpClient, HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
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
import { PrivacyOwnerCoverageResponseSchema } from '../../shared/apis/privacy-owner-coverage.ts';
import type { PrivacyOwnerCoverageRequestSchema } from '../../shared/apis/privacy-owner-coverage.ts';
import { PrivacyOwnerExecutionOutcomeResponseSchema } from '../../shared/apis/privacy-owner-execution-outcome.ts';
import type { PrivacyOwnerExecutionOutcomeRequestSchema } from '../../shared/apis/privacy-owner-execution-outcome.ts';
import { OutboxPayloadSchema as ContinuationPayloadSchema } from '../../shared/outbox/communications-core-owner-execution-evidence-recorded-v1.ts';
import { RecordOwnerExecutionEvidenceResultSchema } from '../../shared/owner-execution-evidence.ts';
import type { RecordOwnerExecutionEvidencePayloadSchema } from '../../shared/owner-execution-evidence.ts';
import { scopePartRefs } from '../../shared/privacy-owner/inventory.ts';
import { fingerprintCommunicationsHandoff } from '../../shared/privacy-owner/measure-handoff.ts';
import { PrepareTemplateRevisionResultSchema } from '../../shared/template-revision.ts';
import type {
  ActivateTemplateRevisionPayloadSchema,
  PrepareTemplateRevisionPayloadSchema,
} from '../../shared/template-revision.ts';
import { PrivacyMeasureReporter, privacyMeasureReporterService } from '../../src/services/privacy-measure-reporter.ts';
import type { PrivacyMeasureReporterService } from '../../src/services/privacy-measure-reporter.ts';
import { handleReceivePrivacyMeasure } from '../../src/workers/receive-privacy-measure.worker.ts';
import { reportPrivacyOwnerOutcomeWorker } from '../../src/workers/report-privacy-owner-outcome.worker.ts';
import { decideOne, step } from '../support/history-world.ts';
import { communicationRequest, handoffDouble, originalRecipient } from '../support/intake-fixtures.ts';
import type { SetLanguagePolicyPayloadSchema } from '../../shared/language-policy.ts';
import { EffectiveLanguagePolicySchema, SetLanguagePolicyResultSchema } from '../../shared/language-policy.ts';
import type { MessageHistoryListRequestFieldsSchema } from '../../shared/message-history-read.ts';
import { MessageHistoryListResultSchema } from '../../shared/message-history-read.ts';
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
  pinToThisRuntime: boolean,
) {
  const filesystem = yield* FileSystem.FileSystem;
  const generated = yield* Schema.decodeUnknownEffect(ContractDocumentSchema)(
    yield* filesystem.readFileString(manifestPath.pathname),
  );
  // only the release under test runs here; another module keeps the deployment its generated contract names
  const contract = pinToThisRuntime
    ? { ...generated, deployment: { ...generated.deployment, buildMarker: ultramodernDeliveryUnit.buildMarker } }
    : generated;
  const document = yield* Schema.encodeEffect(ContractDocumentSchema)(contract);
  // the composition entry is derived from the contract's own public surface, exactly as Core's published fixture does
  const { components, shellContributions } = contract.manifest.publicSurface;
  const [component] = components;
  const origin = `https://${contract.deployment.appId}.native-tests.example`;
  return {
    allowedContributions: Object.values(shellContributions).flatMap((items) =>
      items.map(({ contributionKey }) => contributionKey),
    ),
    backend: { baseUrl: `${origin}/`, transport: 'node-http' },
    contract: { sha256: digest(document), url: `${origin}/.well-known/ontos-module-manifest.json` },
    contractDocument: document,
    dependencies: (contract.manifest.requirements?.intrinsic ?? []).map(({ moduleId }) => moduleId).toSorted(),
    deployment: contract.deployment,
    federation:
      component === undefined
        ? { execution: 'server' }
        : {
            execution: 'browser',
            exposes: components.map(({ expose }) => expose),
            manifest: {
              sha256: digest(`${contract.deployment.buildMarker}-manifest`),
              url: `${origin}/releases/${contract.deployment.buildMarker}/mf-manifest.json`,
            },
            remoteName: component.mfBoundaryId,
          },
    moduleId: contract.manifest.module.id,
    publicContract: { id: contract.manifest.module.id, sha256: digest(document), version: contract.schemaVersion },
    requiredCoreCapabilities: contract.manifest.requirements?.coreCapabilities ?? [],
    requiredShellAbi,
    sharedSingletons: [],
  } satisfies ApplicationComposition['modules'][number];
});

/**
 * The active composition with the actual Communications deployment and Privacy's actual published contract (both generated
 * by this package's `test:integration` script), published as the Core authority and served. Privacy is an approved release
 * only (no Privacy process runs here), so a Privacy-delegated assertion names a real calling module and Communications'
 * conditional requirement to report to Privacy resolves against Privacy's genuine `record-owner-execution-outcome` contract.
 */
const publishComposition = Effect.fnUntraced(function* publishComposition() {
  const base = yield* makeApplicationCompositionSnapshotFixture([]);
  const { contributionAbi } = base.composition.shell;
  const privacy = yield* publishedModule(
    new URL('../../../privacy/dist/public/.well-known/ontos-module-manifest.json', import.meta.url),
    contributionAbi,
    false,
  );
  const communications = yield* publishedModule(
    new URL('../../dist/public/.well-known/ontos-module-manifest.json', import.meta.url),
    contributionAbi,
    true,
  );
  const modules = [...base.composition.modules, privacy, communications];
  // the receiving Shell offers every Core capability the composed contracts require (Privacy's dependency contracts)
  const coreCapabilities = [...new Set(modules.flatMap(({ requiredCoreCapabilities }) => requiredCoreCapabilities))];
  const input = { ...base.composition, modules, shell: { ...base.composition.shell, coreCapabilities } };
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

/** The calling module of a delegated assertion: only the Shell signs it, for an approved release of the composition. */
interface DelegatedActor {
  readonly appId: string;
  readonly buildMarker: string;
  readonly principalId: string;
}

/**
 * A fresh Shell-shaped staff assertion (new JTI, staff namespace) for exactly this principal and company selection; with an
 * actor it is the delegated form a calling module presents for its verified requester.
 */
const assertionFor = Effect.fnUntraced(function* assertionFor(
  gateway: Gateway,
  compositionRevision: string,
  principal: Principal,
  actor?: DelegatedActor,
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
  const external = {
    compositionRevision,
    principal: principal.legalEntityId === undefined ? claims : { ...claims, legalEntityId: principal.legalEntityId },
    targetBuildMarker: ultramodernApiMarker.buildMarker,
    ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
  };
  return yield* Effect.promise(() =>
    new SignJWT(actor === undefined ? external : { ...external, act: actor, ver: DELEGATED_GATEWAY_ASSERTION_VERSION })
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
  | typeof ActivateTemplateRevisionPayloadSchema.Encoded
  | typeof LanguagePolicyRequestSchema.Encoded
  | typeof MessageHistoryListRequestFieldsSchema.Encoded
  | typeof PrepareTemplateRevisionPayloadSchema.Encoded
  | typeof PrivacyOwnerCoverageRequestSchema.Encoded
  | typeof PrivacyOwnerExecutionOutcomeRequestSchema.Encoded
  | typeof RecordOwnerExecutionEvidencePayloadSchema.Encoded
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

/** Sends one public request as exactly this staff principal, under a fresh assertion each time. */
const staffSender =
  (gateway: Gateway, compositionRevision: string, runtime: Runtime) =>
  (principal: Principal, path: string, body: RequestBody, idempotent = false) =>
    assertionFor(gateway, compositionRevision, principal).pipe(
      Effect.flatMap((token) => post(runtime, token, path, body, idempotent)),
    );

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
          const send = staffSender(gateway, revision, runtime);
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

const TEMPLATE = (operation: 'activate' | 'deactivate' | 'invalidate' | 'prepare') =>
  `communications.core.template-revision.${operation}`;
const TEMPLATE_CAPABILITIES = [
  TEMPLATE('prepare'),
  TEMPLATE('activate'),
  TEMPLATE('deactivate'),
  TEMPLATE('invalidate'),
] as const;
const COVERAGE_READ = 'communications.core.privacy-owner-coverage.read';
const RECEIPT_READ = 'communications.core.privacy-owner-execution-outcome.read';
const EVIDENCE_RECORD = 'communications.core.owner-execution-evidence.record';
const PRIVACY_CAPABILITIES = [COVERAGE_READ, RECEIPT_READ, EVIDENCE_RECORD];
const lookup = {
  _tag: 'SUBJECT_REFERENCE' as const,
  lookupRef: 'lookup-customer-1',
  moduleId: 'fixture.party',
  resourceId: 'customer-1',
  resourceType: 'fixture.recipient',
};

/** FICTIONAL labelled template copy: no production wording, recipient or secret. */
const fictionalTemplate = (messageType: string): typeof PrepareTemplateRevisionPayloadSchema.Encoded => ({
  body: '[FICTIONAL TEST COPY] Purpose: {{purpose}}.',
  channel: 'email',
  language: 'cs',
  messageType,
  optionalPlaceholders: [],
  reason: 'Fictional draft for the authorization tests',
  requiredPlaceholders: ['purpose'],
  scope: { kind: 'tenant' },
  subject: '[FICTIONAL TEST COPY] {{purpose}}',
});

/** One RESTRICT measure Privacy dispatched to Communications over this Tenant's real own records. */
const measureOver = (tenantId: string, targets: readonly string[]): PrivacyMeasureHandoff =>
  Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({
    contentScopeRefs: ['communications.core.history'],
    controllerObligationRef: null,
    dispositionDecision: 'RESTRICT',
    expectedEvidenceRefs: [],
    idempotencyKey: `FICTIONAL-idempotency-${tenantId}`,
    kind: 'RESTRICT',
    measureId: `FICTIONAL-measure-${tenantId}`,
    ownerScope: {
      blockerAssessment: { assessedByRef: 'FICTIONAL-privacy-assessment', blockers: [] },
      controllerRef: 'FICTIONAL-controller',
      requestedScopePartRefs: [...scopePartRefs],
      requestedScopeRef: 'FICTIONAL-requested-scope',
      trustedLookups: [lookup],
    },
    owningCapability: 'communications.core',
    preconditionRefs: [],
    requestedAt: '2026-11-19T10:00:00.000Z',
    requestedResult: 'restrict message metadata',
    resourceRefs: targets,
    right: 'ERASURE',
    sourceDecisionRef: 'FICTIONAL-decision-1',
    sourceDecisionRevision: 1,
    subjectRef: 'FICTIONAL-subject-1',
    taskId: `FICTIONAL-task-${tenantId}`,
    tenantId,
  });

/** A Core-attested worker context of one Communications delivery: what Core's worker loop hands the handler. */
const deliveryContext = (
  tenantId: string,
  fields: Pick<OutboxWorkerHandlerContext, 'producerModuleKey' | 'topic' | 'workerKey'> & {
    readonly originatorInvocationId?: string;
  },
): OutboxWorkerHandlerContext =>
  attestOutboxWorkerHandlerContext({
    attemptNumber: 1,
    claimId: `claim-${randomUUID()}`,
    compositionRevision: 'a'.repeat(64),
    consumerModuleKey: 'communications.core',
    deliveryId: randomUUID(),
    domainEventId: randomUUID(),
    legalEntityScope: 'forbidden',
    messageId: randomUUID(),
    tenantId,
    tenantSequenceNo: 1n,
    ...fields,
  });

const SHELL_PREFIX = '/shell-super-app-api';
const DELEGATION_PATH = `${SHELL_PREFIX}/auth/delegated/gateway-context`;
const OUTCOME_ACTION_PATH = '/actions/record-owner-execution-outcome';
const ReceivedJsonSchema = Schema.fromJsonString(Schema.Unknown);
const OutcomeReportBodySchema = Schema.Struct({ request: OwnerExecutionOutcomeRequestSchema });
/** Only the Tenant a delegated request's source names, to tell this suite's pushes from any other delivery's. */
const decodeDelegatedSourceTenant = Schema.decodeUnknownOption(
  Schema.Struct({
    subject: Schema.Struct({ source: Schema.Struct({ tenantId: Schema.String.pipe(Schema.brand('PushedTenantId')) }) }),
  }),
);

/** One request the loopback Shell/Privacy peer of the push received, with the transport headers that matter. */
interface PeerRequest {
  readonly authorization: string | undefined;
  readonly body: unknown;
  readonly idempotencyKey: string | undefined;
  readonly path: string;
}

/**
 * LABELLED loopback peer for the receipt push: the Shell's delegated-context issuance (it records the exact delegated
 * request the REAL reporter sends and answers a FICTIONAL token for the admitted release) and Privacy's
 * `record-owner-execution-outcome` Action (it answers with the receipt Privacy reads ITSELF for the requested attempt, from
 * the real Communications HTTP runtime). Neither the Shell's admission nor Privacy's persistence runs here.
 */
const servePushPeer = Effect.fnUntraced(function* servePushPeer(
  readReceipt: (attempt: number) => Effect.Effect<unknown>,
) {
  const received = yield* Ref.make<readonly PeerRequest[]>([]);
  const server = Context.get(yield* Layer.build(NodeHttpServer.layerTest), HttpServer.HttpServer);
  yield* server.serve(
    HttpServerRequest.HttpServerRequest.use((request) =>
      Effect.gen(function* answer() {
        const path = new URL(request.url, 'http://peer.test').pathname;
        const body = Schema.decodeUnknownOption(ReceivedJsonSchema)(yield* request.text).pipe(Option.getOrUndefined);
        const { authorization } = request.headers;
        yield* Ref.update(received, (all) => [
          ...all,
          { authorization, body, idempotencyKey: request.headers['idempotency-key'], path },
        ]);
        if (path === DELEGATION_PATH) {
          const delegated = yield* Schema.decodeUnknownEffect(GatewayDelegatedContextRequestSchema)(body);
          return yield* HttpServerResponse.json({
            apiBaseUrl: '/privacy-api',
            compositionRevision: delegated.compositionRevision,
            // a fixed far-future expiry (2099-01-01): the token never depends on this live test's clock
            expiresAt: 4_070_908_800,
            token: 'fictional-privacy-dispatch-continuation-token',
          });
        }
        if (path.endsWith(OUTCOME_ACTION_PATH)) {
          const report = yield* Schema.decodeUnknownEffect(OutcomeReportBodySchema)(body);
          return yield* HttpServerResponse.json(yield* readReceipt(report.request.attempt));
        }
        return HttpServerResponse.empty({ status: 404 });
      }).pipe(Effect.orDie),
    ),
  );
  if (!NetAddress.isInetAddress(server.address)) {
    return yield* Effect.die('The push peer must bind one loopback TCP server');
  }
  return { origin: `http://127.0.0.1:${server.address.port}`, received };
});

/** The REAL reporter, bound to this process's Crypto and HTTP client exactly as the worker host binds it. */
const realPrivacyReporter = Effect.gen(function* bindRealPrivacyReporter() {
  const crypto = yield* Crypto.Crypto;
  const httpClient = Context.get(yield* Layer.build(FetchHttpClient.layer), HttpClient.HttpClient);
  const operations = yield* privacyMeasureReporterService();
  return PrivacyMeasureReporter.of({
    report: (handoff, attempt, context) =>
      operations
        .report(handoff, attempt, context)
        .pipe(Effect.provideService(Crypto.Crypto, crypto), Effect.provideService(HttpClient.HttpClient, httpClient)),
    reportRecorded: (continuation, context) =>
      operations
        .reportRecorded(continuation, context)
        .pipe(Effect.provideService(Crypto.Crypto, crypto), Effect.provideService(HttpClient.HttpClient, httpClient)),
  });
});

/**
 * One match + claim/handle/settle cycle of Core's own outbox runtime under the Communications worker binding, running only
 * the continuation worker (the binding still checks every approved Communications subscription).
 */
const deliverContinuationCycle = (input: {
  /** The worker host's configuration: the Shell gateway origin and the module credential the reporter reads per call. */
  readonly configuration: ConfigProvider.ConfigProvider;
  readonly outbox: OutboxRuntimeService;
  readonly reporter: PrivacyMeasureReporterService;
  readonly snapshot: typeof ActiveApplicationCompositionSnapshotSchema.Type;
}) =>
  Effect.gen(function* deliverContinuationCycleEffect() {
    const { configuration, outbox, reporter, snapshot } = input;
    const compositionRevision = snapshot.composition.revision;
    const claimOwner = `communications-continuation-${randomUUID()}`;
    const registrations = [reportPrivacyOwnerOutcomeWorker];
    const subscriptions = extractOutboxWorkerSubscriptions(outboxWorkers);
    const completed = yield* Deferred.make<OutboxCycleResult, OutboxCycleError>();
    const settle = (exit: Exit.Exit<OutboxCycleResult, OutboxCycleError>) => Deferred.done(completed, exit);
    yield* outbox.matchMessages({ compositionRevision });
    const entry = defineOutboxWorkerEntry({
      claimOwnerPrefix: 'communications-continuation',
      expectedDeployment: { appId: 'communications', buildMarker: ultramodernDeliveryUnit.buildMarker },
      layer: Layer.mergeAll(
        Layer.succeed(PrivacyMeasureReporter, reporter),
        Layer.succeed(
          ActiveApplicationCompositionService,
          makeActiveApplicationCompositionService(Effect.succeed(snapshot)),
        ),
        Layer.succeed(OutboxRuntime, {
          ...outbox,
          runCycle: () =>
            outbox
              .runCycle({
                claimOwner,
                compositionRevision,
                registrations,
                subscriptions: extractOutboxWorkerSubscriptions(registrations),
              })
              .pipe(
                Effect.provideService(PrivacyMeasureReporter, reporter),
                Effect.provideService(ConfigProvider.ConfigProvider, configuration),
                Effect.onExit(settle),
              ),
        }),
      ),
      ownerRegistration: communicationsRegistration,
      registrations,
      subscriptions,
    });
    return yield* Deferred.await(completed).pipe(
      Effect.raceFirst(
        entry
          .runLoop({ config: { claimOwner, maxDeliveries: 50, pollIntervalMs: 1000 } })
          .pipe(Effect.andThen(Effect.never)),
      ),
    );
  }).pipe(Effect.scoped);

describe('Communications templates, Privacy owner Reads and the owner evidence loop with the real authorization engine', () => {
  it.live(
    'allows, denies, revokes and isolates every remaining operation and pushes a later human confirmation to Privacy',
    () =>
      Effect.scoped(
        Effect.gen(function* remainingOperations() {
          const { core, document, snapshot } = yield* publishComposition();
          const { revision } = snapshot.composition;
          const privacyDeployment = Option.getOrThrow(
            Option.fromNullishOr(snapshot.composition.modules.find((module) => module.deployment.appId === 'privacy')),
          ).deployment;
          const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
          const fixtureOf = Effect.fnUntraced(function* fixtureOf() {
            const fixture = yield* makeLiveOperationFixture({
              access: 'allowed',
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
          // The manager holds every remaining Communications capability Tenant-wide; the reader holds none of them;
          // the foreign manager holds them all in the foreign Tenant only.
          for (const scope of [tenant, foreign]) {
            yield* grantTestTenantRoleAccess({
              ...target,
              holders: [
                {
                  capabilityKeys: [...TEMPLATE_CAPABILITIES, ...PRIVACY_CAPABILITIES],
                  principalId: scope.manager.principalId,
                },
                { capabilityKeys: ['party.registry.party.read'], principalId: scope.reader.principalId },
              ],
              legalEntityIds: [scope.legalEntityId],
              tenantId: scope.tenantId,
            });
          }
          const gateway = yield* makeGateway();
          const runtime = yield* mountRuntime(gateway, document);
          const send = staffSender(gateway, revision, runtime);
          // Privacy asks for its verified requester: the delegated form with Privacy as the calling module.
          const privacyActor = {
            appId: 'privacy',
            buildMarker: privacyDeployment.buildMarker,
            principalId: randomUUID(),
          };
          const askAsPrivacy = (principal: Principal, path: string, body: RequestBody) =>
            assertionFor(gateway, revision, principal, privacyActor).pipe(
              Effect.flatMap((token) => post(runtime, token, path, body, false)),
            );
          const { manager, reader } = tenant;
          const { manager: foreignManager } = foreign;
          const roles = yield* makeTestTenantRoleAccess({
            ...target,
            legalEntityIds: [tenant.legalEntityId],
            principalId: reader.principalId,
            tenantId: tenant.tenantId,
          });

          // ---- Template revisions: prepare, activate, deactivate, invalidate ----
          const templateAction = (
            principal: Principal,
            operation: 'activate' | 'deactivate' | 'invalidate',
            revisionId: string,
          ) =>
            send(
              principal,
              `/communications/actions/${operation}-template-revision`,
              { reason: `Fictional ${operation} for the authorization tests`, revisionId },
              true,
            );
          const prepare = (principal: Principal, messageType: string) =>
            send(principal, '/communications/actions/prepare-template-revision', fictionalTemplate(messageType), true);
          // ALLOWED: the whole lifecycle under the manager's grants
          const prepared = yield* prepare(manager, 'fixture.authorization-notice');
          expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
          const { revisionId } = Schema.decodeUnknownSync(PrepareTemplateRevisionResultSchema)(prepared.body);
          for (const operation of ['activate', 'deactivate'] as const) {
            const allowed = yield* templateAction(manager, operation, revisionId);
            expect(allowed.status, `${operation} ${JSON.stringify(allowed.body)}`).toBe(200);
          }
          // DENIED: a member without any template capability changes nothing
          expect((yield* prepare(reader, 'fixture.authorization-notice')).status).toBe(403);
          for (const operation of ['activate', 'deactivate', 'invalidate'] as const) {
            expect((yield* templateAction(reader, operation, revisionId)).status).toBe(403);
          }
          // CROSS-TENANT: the foreign manager's grant never reaches this Tenant's revision, and a forged Tenant claim fails
          for (const operation of ['activate', 'deactivate', 'invalidate'] as const) {
            const crossed = yield* templateAction(foreignManager, operation, revisionId);
            // the revision does not exist in the foreign Tenant: a not-found refusal, never a decision about it
            expect(crossed.status, `${operation} ${JSON.stringify(crossed.body)}`).toBe(404);
            expect(crossed.body).toMatchObject({ code: 'template_revision_not_found' });
          }
          expect([401, 403]).toContain(
            (yield* prepare({ ...foreignManager, tenantId: tenant.tenantId }, 'fixture.authorization-notice')).status,
          );
          const invalidated = yield* templateAction(manager, 'invalidate', revisionId);
          expect(invalidated.status, JSON.stringify(invalidated.body)).toBe(200);
          // GRANTED THEN REVOKED: a role of exactly the four template capabilities admits each, then none
          const templateRole = yield* roles.capabilityRole(TEMPLATE_CAPABILITIES);
          yield* templateRole.grant();
          const readerPrepared = yield* prepare(reader, 'fixture.revocation-notice');
          expect(readerPrepared.status, JSON.stringify(readerPrepared.body)).toBe(200);
          const readerRevision = Schema.decodeUnknownSync(PrepareTemplateRevisionResultSchema)(readerPrepared.body);
          expect((yield* templateAction(reader, 'activate', readerRevision.revisionId)).status).toBe(200);
          expect((yield* templateAction(reader, 'deactivate', readerRevision.revisionId)).status).toBe(200);
          yield* templateRole.revoke();
          expect((yield* prepare(reader, 'fixture.revocation-notice')).status).toBe(403);
          for (const operation of ['activate', 'deactivate', 'invalidate'] as const) {
            expect((yield* templateAction(reader, operation, readerRevision.revisionId)).status).toBe(403);
          }

          // ---- The owner evidence loop over this Tenant's real own records ----
          const world = yield* intakeWorld(yield* makeRuntimeDatabase(), { tenantId: tenant.tenantId });
          const { intentId, requestId } = yield* decideOne(world);
          yield* step(world, handoffDouble(), intentId);
          const targets = [`communications.core.request:${requestId}`, `communications.core.intent:${intentId}`];
          const handoff = measureOver(tenant.tenantId, targets);
          const fingerprint = yield* fingerprintCommunicationsHandoff(handoff);
          const dispatchInvocationId = randomUUID();
          const tenantScope = {
            run: <Failure, Requirements>(
              context: OutboxWorkerHandlerContext,
              observe: (scope: OutboxWorkerTenantScopeView) => Effect.Effect<void, Failure, Requirements>,
            ) =>
              world.database
                .inTenant(context.tenantId, (transaction) =>
                  observe({
                    completionPublisher: { publish: () => Effect.die('Completion belongs to Core delivery') },
                    readOriginalActionInvocation: () => Effect.succeed(Option.none()),
                    readWorkloadPrincipalEligibility: () => Effect.die('Not used by this worker'),
                    routineInvoker: transaction,
                    tenantId: context.tenantId,
                  }),
                )
                .pipe(Effect.orDie),
          };
          // LABELLED: the take-over report of step 1 runs outside a Core delivery here, so it is recorded by a double; the
          // later push (step 5) runs the REAL reporter inside Core's own claimed continuation delivery
          const takeOvers: number[] = [];
          const reporter = PrivacyMeasureReporter.of({
            report: (_handoff, attempt) =>
              Effect.sync(() => {
                takeOvers.push(attempt);
              }),
            reportRecorded: () => Effect.die('the continuation push runs the real reporter'),
          });
          // 1. Communications receives the measure Privacy dispatched and reports only that it took it over
          yield* handleReceivePrivacyMeasure(
            { handoff },
            deliveryContext(tenant.tenantId, {
              originatorInvocationId: dispatchInvocationId,
              producerModuleKey: 'privacy.core',
              topic: 'privacy.measure.dispatched',
              workerKey: 'communications.core.receive-privacy-measure',
            }),
          ).pipe(
            Effect.provideService(OutboxWorkerTenantScope, tenantScope),
            Effect.provideService(PrivacyMeasureReporter, reporter),
          );
          expect(takeOvers).toEqual([1]);
          const receipt = Effect.fnUntraced(function* receipt(
            principal: Principal,
            attempt: number,
            measure = handoff,
          ) {
            const reply = yield* askAsPrivacy(principal, '/reads/privacy-owner-execution-outcome', {
              attempt,
              handoff: Schema.encodeSync(PrivacyMeasureHandoffSchema)(measure),
            });
            return {
              receipt:
                reply.status === 200
                  ? Schema.decodeUnknownSync(PrivacyOwnerExecutionOutcomeResponseSchema)(reply.body)
                  : Option.none(),
              status: reply.status,
            };
          });
          // 2. Privacy reads the owner receipt: received, awaiting a human, never a result
          const received = yield* receipt(manager, 1);
          expect(received.status).toBe(200);
          expect(Option.getOrThrow(received.receipt).outcome).toMatchObject({
            reason: 'AWAITING_HUMAN_CONFIRMED_OWNER_ACTION',
            status: 'RECEIVED',
          });
          const coverage = yield* askAsPrivacy(manager, '/reads/privacy-owner-coverage', {
            scope: {
              controllerRef: 'FICTIONAL-controller',
              ownerCapability: 'communications.core',
              requestedScopePartRefs: [...scopePartRefs],
              requestedScopeRef: 'FICTIONAL-requested-scope',
              subject: { _tag: 'RESOLVED_DATA_SUBJECT', subjectRef: 'FICTIONAL-subject-1' },
              tenantId: tenant.tenantId,
              trustedLookupRefs: [lookup.lookupRef],
            },
            trustedLookups: [lookup],
          });
          expect(coverage.status, JSON.stringify(coverage.body)).toBe(200);
          const found = Schema.decodeUnknownSync(PrivacyOwnerCoverageResponseSchema)(coverage.body);
          expect(found.coverage.coverageParts.flatMap(({ foundContentRefs }) => foundContentRefs)).toEqual(
            expect.arrayContaining(targets),
          );
          // 3. A human records the owner execution evidence; nobody else can
          const evidence = (principal: Principal, evidenceRef = 'FICTIONAL-evidence-1') =>
            send(
              principal,
              '/communications/actions/record-owner-execution-evidence',
              {
                evidenceRef,
                handoffFingerprint: fingerprint,
                idempotencyKey: handoff.idempotencyKey,
                phase: 'COMPLETED',
                results: targets.map((contentRef) => ({ contentRef, result: 'RESTRICTED' as const })),
              },
              true,
            );
          const continuationMessages = core.transaction((transaction) =>
            transaction.execute<{ readonly payload: unknown; readonly tenant: string }>(
              sql`select m.payload_json as payload, m.tenant_id::text as tenant from core.outbox_messages m
                   where m.topic = 'communications.core.owner-execution-evidence-recorded.v1'
                     and m.tenant_id in (${tenant.tenantId}::uuid, ${foreign.tenantId}::uuid)`,
              'objects',
            ),
          );
          const coreRuntime = yield* makeCoreDatabase(connections.runtime);
          const outboxServices = yield* Layer.build(
            OutboxRuntimeLive.pipe(
              Layer.provide(OutboxRepositoryLive),
              Layer.provide(Layer.succeed(CoreDatabase, coreRuntime)),
            ),
          );
          const outbox = Context.get(outboxServices, OutboxRuntime);
          const peer = yield* servePushPeer((attempt) =>
            receipt(manager, attempt).pipe(
              Effect.flatMap(({ receipt: answered }) => Effect.fromOption(answered)),
              Effect.map(({ outcome }) => outcome),
              Effect.orDie,
            ),
          );
          const pushConfiguration = ConfigProvider.fromUnknown({
            ONTOS_GATEWAY_MODULE_API_KEY: 'fictional-communications-module-api-key',
            ONTOS_SHELL_GATEWAY_BASE_URL: `${peer.origin}${SHELL_PREFIX}`,
          });
          const deliverContinuations = Effect.fnUntraced(function* deliverContinuations() {
            return yield* deliverContinuationCycle({
              configuration: pushConfiguration,
              outbox,
              reporter: yield* realPrivacyReporter,
              snapshot,
            });
          });
          const continuation = Option.getOrThrow(
            Option.fromNullishOr(privacyDispatchConsumers['communications.core']?.continuation),
          );
          const continuationDeliveries = core.transaction((transaction) =>
            transaction.execute<{ readonly delivery: string }>(
              sql`select d.outbox_delivery_id::text as delivery from core.outbox_deliveries d
                   join core.outbox_messages m on m.outbox_message_id = d.outbox_message_id
                  where m.tenant_id = ${tenant.tenantId}::uuid and d.worker_key = ${continuation.workerKey}
                  order by m.created_at`,
              'objects',
            ),
          );
          /**
           * The outcome reports the REAL reporter sent to Privacy for THIS Tenant's measure, and the delegated requests that
           * carried them. Core's cycle claims every due continuation delivery of the database, so another suite's leftover
           * delivery may reach the peer too; it is never this Tenant's.
           */
          const pushedReports = Ref.get(peer.received).pipe(
            Effect.map((all) => ({
              delegations: all
                .filter(
                  ({ body, path }) =>
                    path === DELEGATION_PATH &&
                    Option.exists(
                      decodeDelegatedSourceTenant(body),
                      ({ subject }) => subject.source.tenantId === tenant.tenantId,
                    ),
                )
                .map(({ body }) => Schema.decodeUnknownSync(GatewayDelegatedContextRequestSchema)(body)),
              reports: all.filter(
                ({ body, path }) =>
                  path.endsWith(OUTCOME_ACTION_PATH) &&
                  Schema.decodeUnknownSync(OutcomeReportBodySchema)(body).request.measureId === handoff.measureId,
              ),
            })),
          );
          const pendingContinuationWork = core.transaction((transaction) =>
            transaction.execute<{ readonly work: string }>(
              sql`select w.work_id as work from core.application_composition_durable_work w
                   join core.outbox_messages m on w.work_id = 'outbox:' || m.outbox_message_id::text || ':communications.core'
                  where m.tenant_id = ${tenant.tenantId}::uuid`,
              'objects',
            ),
          );
          expect((yield* evidence(reader)).status).toBe(403);
          expect([401, 403]).toContain((yield* evidence({ ...foreignManager, tenantId: tenant.tenantId })).status);
          // the foreign manager in its own Tenant has no such handoff: refused, and nothing continues anywhere
          const foreignEvidence = yield* evidence(foreignManager);
          expect(foreignEvidence.status).toBe(422);
          expect(foreignEvidence.body).toMatchObject({ code: 'owner_execution_evidence_rejected' });
          expect(yield* continuationMessages).toEqual([]);
          const recorded = yield* evidence(manager);
          expect(recorded.status, JSON.stringify(recorded.body)).toBe(200);
          expect(Schema.decodeUnknownSync(RecordOwnerExecutionEvidenceResultSchema)(recorded.body)).toEqual({
            destructiveActionPerformed: false,
            evidenceRef: 'FICTIONAL-evidence-1',
            outcome: 'RECORDED',
          });
          // 4. Exactly ONE continuation message, naming only the original dispatch and the next attempt: no outcome
          const [message, ...extra] = yield* continuationMessages;
          expect(extra).toEqual([]);
          expect(message?.tenant).toBe(tenant.tenantId);
          const pushed = Schema.decodeUnknownSync(ContinuationPayloadSchema, { onExcessProperty: 'error' })(
            message?.payload,
          );
          expect(pushed).toEqual({
            attempt: 2,
            dispatchInvocationId,
            measureId: handoff.measureId,
            taskId: handoff.taskId,
          });
          // DUPLICATE: the same confirmation again is a replay; it stores and continues nothing more
          const replayed = yield* evidence(manager);
          expect(Schema.decodeUnknownSync(RecordOwnerExecutionEvidenceResultSchema)(replayed.body).outcome).toBe(
            'EXISTS',
          );
          expect(yield* continuationMessages).toHaveLength(1);
          // 5. Core's own outbox runtime matches the message, claims it for the continuation worker and settles it: the
          // worker reports exactly that message to Privacy from its real claimed delivery, and no durable work remains
          const delivered = yield* deliverContinuations();
          expect(delivered.succeeded).toBeGreaterThanOrEqual(1);
          expect(yield* pendingContinuationWork).toEqual([]);
          // the REAL reporter asked the Shell for exactly ONE outcome report of the original dispatch, carried by this very
          // Core continuation delivery, in the subject shape the Shell's continuation admission is proven to admit (the
          // published consumer contract both sides read): a reporter/admission mismatch fails here
          const [deliveryRow] = yield* continuationDeliveries;
          const firstPush = yield* pushedReports;
          expect(firstPush.delegations).toHaveLength(1);
          expect(firstPush.delegations[0]).toMatchObject({
            audience: 'privacy',
            compositionRevision: revision,
            legalEntityScope: 'subject',
            subject: {
              _tag: 'PrivacyDispatch',
              operation: { _tag: 'PrivacyOutcome', attempt: pushed.attempt },
              operationRequirementKey: continuation.requirementKey,
              source: {
                _tag: 'Continuation',
                deliveryId: deliveryRow?.delivery,
                tenantId: tenant.tenantId,
                workerKey: continuation.workerKey,
              },
            },
          });
          // and Privacy was asked, under that delegated token, for the pushed attempt of the measure, and nothing else
          expect(firstPush.reports).toHaveLength(1);
          expect(firstPush.reports[0]?.authorization).toBe('Bearer fictional-privacy-dispatch-continuation-token');
          expect(Schema.decodeUnknownSync(OutcomeReportBodySchema)(firstPush.reports[0]?.body)).toEqual({
            request: { attempt: pushed.attempt, measureId: pushed.measureId, taskId: pushed.taskId },
          });
          // 6. Privacy reads the receipt of the pushed attempt ITSELF, and its published state machine transitions
          const after = Option.getOrThrow((yield* receipt(manager, pushed.attempt)).receipt);
          expect(after.handoffFingerprint).toBe(fingerprint);
          expect(after.outcome).toMatchObject({ attempt: 2, status: 'SUCCEEDED' });
          const before = Option.getOrThrow(received.receipt);
          const request = { attempt: 2, measureId: handoff.measureId, taskId: handoff.taskId };
          const authorityOf = (outcome: typeof after.outcome) => ({
            authorityRef: 'communications.core.api.privacy-owner-execution-outcome',
            contentScopeRefs: handoff.contentScopeRefs,
            evidenceRefs: outcome.evidenceRefs,
            outcome,
            receiptRef: outcome.outcomeId,
            resourceRefs: handoff.resourceRefs,
            subjectRef: handoff.subjectRef,
            tenantId: handoff.tenantId,
          });
          expect(validateOwnerExecutionAuthorityResult(handoff, request, authorityOf(after.outcome))).toBeUndefined();
          const dispatched = yield* createPrivacyMeasureDispatch(handoff, '2026-11-19T10:00:00.000Z');
          const ownerRequest = prepareOwnerActionRequest(dispatched, 'communications.core.public-action');
          const takenOver = yield* recordOwnerExecutionOutcome(
            dispatched,
            ownerRequest,
            before.outcome,
            '2026-11-19T10:00:01.000Z',
          );
          expect(takenOver.status).toBe('RECEIVED');
          const settled = yield* recordOwnerExecutionOutcome(
            takenOver,
            ownerRequest,
            after.outcome,
            '2026-11-19T10:00:02.000Z',
          );
          expect(settled.status).toBe('SUCCEEDED');
          // a receipt for another measure is a rejection, never this measure's result
          const otherMeasure = Option.getOrThrow(
            (yield* receipt(manager, 2, { ...handoff, measureId: 'FICTIONAL-other' })).receipt,
          );
          expect(otherMeasure.outcome).toMatchObject({
            includedResourceRefs: [],
            reason: 'HANDOFF_DOES_NOT_MATCH_THE_RECORDED_HANDOFF',
            status: 'BUSINESS_REJECTED',
          });
          // CROSS-TENANT: the foreign Tenant has no such receipt; the owner says so and proves nothing
          const foreignReceipt = yield* receipt(foreignManager, 2);
          expect(foreignReceipt.status).toBe(200);
          expect(Option.isNone(foreignReceipt.receipt)).toBe(true);
          // DENIED: these Reads declare `accessActor.subject: 'identity'`, so only Privacy as the calling module may ask;
          // a direct staff call, even with the capability, and another calling module are refused.
          const direct = yield* send(manager, '/reads/privacy-owner-execution-outcome', {
            attempt: 2,
            handoff: Schema.encodeSync(PrivacyMeasureHandoffSchema)(handoff),
          });
          expect(direct.status).toBe(403);
          const asCommunications = yield* assertionFor(gateway, revision, manager, {
            appId: 'communications',
            buildMarker: ultramodernDeliveryUnit.buildMarker,
            principalId: privacyActor.principalId,
          }).pipe(
            Effect.flatMap((token) =>
              post(
                runtime,
                token,
                '/reads/privacy-owner-execution-outcome',
                { attempt: 2, handoff: Schema.encodeSync(PrivacyMeasureHandoffSchema)(handoff) },
                false,
              ),
            ),
          );
          expect([401, 403]).toContain(asCommunications.status);
          const directCoverage = yield* send(manager, '/reads/privacy-owner-coverage', {
            scope: {
              controllerRef: 'FICTIONAL-controller',
              ownerCapability: 'communications.core',
              requestedScopePartRefs: [...scopePartRefs],
              requestedScopeRef: 'FICTIONAL-requested-scope',
              subject: { _tag: 'RESOLVED_DATA_SUBJECT', subjectRef: 'FICTIONAL-subject-1' },
              tenantId: tenant.tenantId,
              trustedLookupRefs: [lookup.lookupRef],
            },
            trustedLookups: [lookup],
          });
          expect(directCoverage.status).toBe(403);
          // Under the identity subject the Privacy-delegated Read does not consult the member's own grant (pre-existing
          // contract): a member without the receipt capability is still answered through Privacy.
          expect((yield* receipt(reader, 2)).status).toBe(200);
          // REVOKED: the identity itself ends, and the very next Privacy-delegated Read for it is refused
          const setPrincipalStatus = (status: 'active' | 'disabled') =>
            core.transaction((transaction) =>
              transaction.execute(
                sql`update core.principals set status = ${status} where principal_id = ${reader.principalId}::uuid`,
                'objects',
              ),
            );
          yield* setPrincipalStatus('disabled');
          expect([401, 403]).toContain((yield* receipt(reader, 2)).status);
          yield* setPrincipalStatus('active');
          // The evidence Action is rights-based: a role of exactly that capability admits it, revoking it refuses it
          const evidenceRole = yield* roles.capabilityRole([EVIDENCE_RECORD]);
          yield* evidenceRole.grant();
          const readerEvidence = yield* evidence(reader, 'FICTIONAL-evidence-2');
          expect(readerEvidence.status, JSON.stringify(readerEvidence.body)).toBe(200);
          expect(yield* continuationMessages).toHaveLength(2);
          yield* evidenceRole.revoke();
          expect((yield* evidence(reader, 'FICTIONAL-evidence-3')).status).toBe(403);
          expect(yield* continuationMessages).toHaveLength(2);
          // the second confirmation is pushed too, as the next attempt, and leaves no unfinished work behind
          yield* deliverContinuations();
          const secondPush = yield* pushedReports;
          expect(
            secondPush.reports.map(
              ({ body }) => Schema.decodeUnknownSync(OutcomeReportBodySchema)(body).request.attempt,
            ),
          ).toEqual([2, 3]);
          expect(secondPush.delegations).toHaveLength(2);
          expect(yield* pendingContinuationWork).toEqual([]);
        }),
      ).pipe(Effect.provide(services)),
    180_000,
  );
});
