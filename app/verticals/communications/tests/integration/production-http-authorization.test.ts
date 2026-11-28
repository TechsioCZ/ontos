import { randomUUID } from 'node:crypto';

import {
  ActiveApplicationCompositionService,
  loadDatabaseConnectionPair,
  makeActiveApplicationCompositionService,
  OutboxRepositoryLive,
  OutboxRuntime,
  OutboxRuntimeLive,
} from '@app/core-runtime';
import type {
  OutboxCycleError,
  OutboxCycleResult,
  OutboxRuntimeService,
  OutboxWorkerHandlerContext,
} from '@app/core-runtime';
import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import type { ActiveApplicationCompositionSnapshotSchema } from '@app/core-runtime/modules/active-application-composition';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import {
  defineOutboxWorkerEntry,
  extractOutboxWorkerSubscriptions,
  OutboxWorkerTenantScope,
} from '@app/core-runtime/outbox/worker';
import { communicationsRegistration } from '../../vertical.registration.ts';
import { activateCommunications, publishComposition } from '../support/production-composition.fixture.ts';
import { approvedMessageTypes } from '../../src/domain/catalog/approved-registry.ts';
import { templateContractOf } from '../../src/domain/catalog/template-contract.ts';
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
} from '@app/privacy-contracts/domain/privacy-measure-handoff';
import type { PrivacyMeasureHandoff } from '@app/privacy-contracts/domain/privacy-measure-handoff';
import {
  OutboxPayloadSchema as PrivacyMeasureDispatchedSchema,
  outboxTopic as privacyMeasureDispatchedTopic,
} from '@app/privacy-contracts/outbox/privacy-measure-dispatched';
import { environmentTestAccessTarget, grantTestTenantRoleAccess } from '@app/core-runtime/testing/tenant-access';
import {
  DELEGATED_GATEWAY_ASSERTION_VERSION,
  EXTERNAL_GATEWAY_ASSERTION_VERSION,
  GATEWAY_ASSERTION_TTL_SECONDS,
  GatewayDelegatedContextRequestSchema,
  PRIVACY_DISPATCH_GATEWAY_ASSERTION_VERSION,
  privacyDispatchConsumers,
  WORKLOAD_GATEWAY_ASSERTION_VERSION,
} from '@app/shared-contracts';
import { NodeCrypto, NodeHttpServer, NodeServices } from '@effect/platform-node';
import { sql } from 'drizzle-orm';
import { ConfigProvider, Context, DateTime, Deferred, Effect, Layer, Option, Redacted, Ref, Schema } from 'effect';
import { SecureRandom } from 'effect/crypto';
import type { Exit } from 'effect';
import { FetchHttpClient, HttpClient, HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { NetAddress } from 'effect/net';
import { Reactivity } from 'effect/reactivity';
import { describe, expect, it } from 'effect-rstest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { CryptoKey, JWK, JWTPayload } from 'jose';

import { loadSpiceDbConfig } from '../../../../packages/core-runtime/src/permissions/config.ts';
import { makeTestTenantRoleAccess } from '../../../../packages/core-runtime/src/testing/tenant-access-roles.ts';
import { makeCommunicationsApiRuntime } from '../../api/index.ts';
import type { LanguagePolicyRequestSchema } from '../../shared/apis/language-policy.ts';
import { PrivacyOwnerCoverageResponseSchema } from '@app/communications-contracts/privacy-owner-coverage';
import type { PrivacyOwnerCoverageRequestSchema } from '@app/communications-contracts/privacy-owner-coverage';
import { PrivacyOwnerExecutionOutcomeResponseSchema } from '@app/communications-contracts/privacy-owner-execution-outcome';
import type { PrivacyOwnerExecutionOutcomeRequestSchema } from '@app/communications-contracts/privacy-owner-execution-outcome';
import { OutboxPayloadSchema as ContinuationPayloadSchema } from '../../shared/outbox/communications-core-owner-execution-evidence-recorded-v1.ts';
import { RecordOwnerExecutionEvidenceResultSchema } from '../../shared/owner-execution-evidence.ts';
import type { RecordOwnerExecutionEvidencePayloadSchema } from '../../shared/owner-execution-evidence.ts';
import { scopePartRefs } from '../../shared/privacy-owner/inventory.ts';
import { fingerprintCommunicationsHandoff } from '../../shared/privacy-owner/measure-handoff.ts';
import { BuiltInTemplateDefaultsResponseSchema } from '../../shared/apis/built-in-template-defaults.ts';
import type { BuiltInTemplateDefaultsRequestSchema } from '../../shared/apis/built-in-template-defaults.ts';
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
import { makeRuntimeDatabase, nativeServices } from '../support/persistence.fixture.ts';
import { ultramodernApiMarker, ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import { communicationRequests, messageIntents } from '../../src/database/schema.ts';
import type { SubmitCommunicationRequestPayloadSchema } from '../../shared/communication-intake.ts';
import { PortalAuthIssuanceRefSchema } from '@app/portal-auth-contracts/portal-auth-issuance';
import { portalAuthVerificationRequest } from '../support/portal-auth-request.fixture.ts';

/*
 * Q-AUTHZ (#1408, E01/E10/E12/E17): Communications Actions and Reads through the PRODUCTION HTTP assembly of the module
 * (`makeCommunicationsApiRuntime`, the same layers as the default export) with a Shell-shaped Ed25519 gateway assertion,
 * the production durable assertion redemption, the production access decision against the REAL SpiceDB of the test
 * environment (Core access intent written by Core's own bootstrap and projection writer) and native PostgreSQL.
 *
 * What this does NOT cover: the Shell process itself issuing the assertion (the assertion is signed here with a test key
 * the runtime is configured to trust, exactly as other owners' production HTTP acceptance tests do).
 *
 * The last describe (T2-17) sends `submit-communication-request` through the same assembly: Shell-shaped registered-workload
 * assertions (version 4) of the Portal Auth source worker, Core's real access gate and redemption, native PostgreSQL. LABELLED
 * stubs there: the Shell issuing the workload assertion and Core's native source-admission Action are NOT run, so the rows they
 * leave (the system principal and its workload bindings, the original integration principal, the open admission fence and the
 * source's claimed Outbox delivery) are seeded by SQL as the admin role; Auth's published Read and the Shell's delegation
 * exchange are a loopback peer. Authorization of this workload-only Action is a Core registry decision in PostgreSQL, so SpiceDB
 * is exercised by the human denial control only. One scenario is marked `fails` for a KNOWN production defect (see its comment).
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
const mountRuntime = Effect.fnUntraced(function* mountRuntime(
  gateway: Gateway,
  compositionDocument: string,
  extraConfiguration: Readonly<Record<string, string>> = {},
) {
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
    ...extraConfiguration,
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

/** Signs one Shell-shaped assertion for Communications under a fresh JTI and the exact assertion lifetime. */
const signAssertion = (gateway: Gateway, claims: JWTPayload, subject: string, issuedAt: number) =>
  Effect.promise(() =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'EdDSA', kid: KEY_ID, typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience('communications')
      .setSubject(subject)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + GATEWAY_ASSERTION_TTL_SECONDS)
      .setJti(randomUUID())
      .sign(gateway.privateKey),
  );

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
  return yield* signAssertion(
    gateway,
    actor === undefined ? external : { ...external, act: actor, ver: DELEGATED_GATEWAY_ASSERTION_VERSION },
    principal.principalId,
    issuedAt,
  );
});

/** The native Core rows of one human Privacy dispatch that the receipt carrier names. */
interface NativeDispatch {
  readonly deliveryId: string;
  readonly dispatchInvocationId: string;
  readonly domainEventId: string;
  readonly messageId: string;
}

/**
 * The Shell-issued durable receipt carrier (version 5): Privacy reads the receipt of ONE dispatch it delivered, as the
 * ORIGINAL dispatching human in the governance company, with no worker claim (`sourceMode: 'dispatch'`). Signed here in
 * the shape the Shell's issuance produces; the Shell's own native admission of it is proven by the Shell's
 * `privacy-dispatch-continuation-native` suite, not here.
 */
const receiptCarrierFor = Effect.fnUntraced(function* receiptCarrierFor(input: {
  readonly actor: DelegatedActor;
  readonly attempt: number;
  readonly compositionRevision: string;
  readonly dispatch: NativeDispatch;
  readonly dispatcher: Principal;
  readonly gateway: Gateway;
  readonly governanceLegalEntityId: string;
  readonly handoff: PrivacyMeasureHandoff;
}) {
  const { attempt, dispatch, dispatcher, handoff } = input;
  const issuedAt = Math.floor((yield* DateTime.nowAsDate).getTime() / 1000);
  const claims = {
    act: input.actor,
    compositionRevision: input.compositionRevision,
    principal: {
      authBindingId: dispatcher.authBindingId,
      authContextRef: dispatcher.authContextRef,
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      authMethod: dispatcher.authMethod,
      legalEntityId: input.governanceLegalEntityId,
      principalId: dispatcher.principalId,
      tenantId: dispatcher.tenantId,
    },
    privacyDispatch: {
      deliveryId: dispatch.deliveryId,
      dispatchInvocationId: dispatch.dispatchInvocationId,
      domainEventId: dispatch.domainEventId,
      governanceLegalEntityId: input.governanceLegalEntityId,
      handoffHash: computeCanonicalValueHash(handoff),
      measureId: handoff.measureId,
      messageId: dispatch.messageId,
      operation: 'CommunicationsReceipt',
      principalId: dispatcher.principalId,
      // the Shell binds the exact Read request: this attempt of this handoff, and nothing else
      requestHash: computeCanonicalValueHash({ attempt, handoff }),
      sourceMode: 'dispatch',
      taskId: handoff.taskId,
      tenantId: dispatcher.tenantId,
    },
    targetBuildMarker: ultramodernApiMarker.buildMarker,
    ver: PRIVACY_DISPATCH_GATEWAY_ASSERTION_VERSION,
  };
  return yield* signAssertion(input.gateway, claims, dispatcher.principalId, issuedAt);
});

/** Exactly the public request bodies this suite sends. */
type RequestBody =
  | typeof ActivateTemplateRevisionPayloadSchema.Encoded
  | typeof BuiltInTemplateDefaultsRequestSchema.Encoded
  | typeof LanguagePolicyRequestSchema.Encoded
  | typeof MessageHistoryListRequestFieldsSchema.Encoded
  | typeof PrepareTemplateRevisionPayloadSchema.Encoded
  | typeof PrivacyOwnerCoverageRequestSchema.Encoded
  | typeof PrivacyOwnerExecutionOutcomeRequestSchema.Encoded
  | typeof RecordOwnerExecutionEvidencePayloadSchema.Encoded
  | typeof SetLanguagePolicyPayloadSchema.Encoded
  | typeof SubmitCommunicationRequestPayloadSchema.Encoded;

const ReplyBodySchema = Schema.fromJsonString(Schema.Unknown);

const post = Effect.fnUntraced(function* post(
  runtime: Runtime,
  token: string,
  path: string,
  body: RequestBody,
  idempotent: boolean,
) {
  const correlationId = `communications-production-http-${randomUUID()}`;
  const headers = new Headers({
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    origin: ORIGIN,
    'x-correlation-id': correlationId,
  });
  if (idempotent) {
    headers.set('idempotency-key', randomUUID());
  }
  const response = yield* Effect.promise(() =>
    runtime.handler(new Request(`${ORIGIN}${path}`, { body: JSON.stringify(body), headers, method: 'POST' })),
  );
  const text = yield* Effect.promise(() => response.text());
  return { body: yield* Schema.decodeUnknownEffect(ReplyBodySchema)(text), correlationId, status: response.status };
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
const DISPATCH_ACTION = 'privacy.core.dispatch-privacy-measure';
const DISPATCH_CAPABILITY = 'privacy.core.privacy-measure.dispatch';
const RECEIVE_WORKER = 'communications.core.receive-privacy-measure';
const lookup = {
  _tag: 'SUBJECT_REFERENCE' as const,
  lookupRef: 'lookup-customer-1',
  moduleId: 'fixture.party',
  resourceId: 'customer-1',
  resourceType: 'fixture.recipient',
};

/**
 * A revision may only be prepared for an APPROVED Transactional Message Type and must fit its placeholder contract (#1398,
 * #1399): the suite therefore prepares revisions of the approved Portal Auth verification type, carrying exactly the
 * placeholders that type requires.
 */
const approvedAuthType = Option.getOrThrow(
  Option.fromNullishOr(approvedMessageTypes.find(({ purpose }) => purpose.endsWith('.verify-email'))),
);
const APPROVED_TYPE_ID = approvedAuthType.typeId;
const requiredAuthPlaceholders = templateContractOf(approvedAuthType)
  .placeholders.filter(({ required }) => required)
  .map(({ name }) => name);

const placeholderOf = (name: string) => `{{${name}}}`;

/** FICTIONAL labelled template copy: no production wording, recipient or secret. */
const fictionalTemplate = (messageType: string): typeof PrepareTemplateRevisionPayloadSchema.Encoded => ({
  body: `[FICTIONAL TEST COPY] ${requiredAuthPlaceholders.map(placeholderOf).join(' ')}`,
  channel: 'email',
  language: 'cs',
  messageType,
  optionalPlaceholders: [],
  reason: 'Fictional draft for the authorization tests',
  requiredPlaceholders: requiredAuthPlaceholders,
  scope: { kind: 'tenant' },
  subject: '[FICTIONAL TEST COPY] verification',
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
  const crypto = yield* SecureRandom.SecureRandom;

  const httpClient = Context.get(yield* Layer.build(FetchHttpClient.layer), HttpClient.HttpClient);
  const operations = yield* privacyMeasureReporterService();
  return PrivacyMeasureReporter.of({
    report: (handoff, attempt, context) =>
      operations.report(handoff, attempt, context).pipe(
        Effect.provideService(SecureRandom.SecureRandom, crypto),

        Effect.provideService(HttpClient.HttpClient, httpClient),
      ),
    reportRecorded: (continuation, context) =>
      operations.reportRecorded(continuation, context).pipe(
        Effect.provideService(SecureRandom.SecureRandom, crypto),

        Effect.provideService(HttpClient.HttpClient, httpClient),
      ),
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

/**
 * The native Core rows of ONE human Privacy dispatch of `handoff` to Communications, as Privacy's dispatch Action leaves
 * them: the dispatcher's succeeded invocation in the governance company, its domain event and message, and the
 * Communications delivery Core's own matcher creates for it, settled long ago (no claim left). These are exactly the rows
 * Core's gate proves live for a durable receipt carrier.
 */
const recordNativeDispatch = Effect.fnUntraced(function* recordNativeDispatch(input: {
  readonly compositionRevision: string;
  readonly core: Effect.Success<ReturnType<typeof publishComposition>>['core'];
  readonly dispatcher: Principal;
  readonly governanceLegalEntityId: string;
  readonly handoff: PrivacyMeasureHandoff;
  readonly outbox: OutboxRuntimeService;
}) {
  const { core, dispatcher, governanceLegalEntityId, handoff } = input;
  const dispatchInvocationId = randomUUID();
  const domainEventId = randomUUID();
  const messageId = randomUUID();
  const payload = Schema.encodeSync(PrivacyMeasureDispatchedSchema)({ handoff });
  const payloadJson = JSON.stringify(payload);
  yield* core.transaction((transaction) =>
    Effect.gen(function* insertDispatch() {
      yield* transaction.execute(
        sql`insert into core.action_invocations (action_invocation_id, tenant_id, legal_entity_id, principal_id, auth_method,
              auth_binding_id, auth_context_ref, action_key, status, request_hash, started_at, completed_at)
            values (${dispatchInvocationId}::uuid, ${dispatcher.tenantId}::uuid, ${governanceLegalEntityId}::uuid,
              ${dispatcher.principalId}::uuid, ${dispatcher.authMethod}, ${dispatcher.authBindingId}::uuid,
              ${dispatcher.authContextRef}, ${DISPATCH_ACTION}, 'succeeded', ${computeCanonicalValueHash(payload)},
              now() - interval '1 day', now() - interval '1 day')`,
        'objects',
      );
      yield* transaction.execute(
        sql`insert into core.domain_events (domain_event_id, tenant_id, legal_entity_id, action_invocation_id,
              producer_module_key, event_type, subject_module_key, subject_resource_type, subject_resource_id, payload_json)
            values (${domainEventId}::uuid, ${dispatcher.tenantId}::uuid, ${governanceLegalEntityId}::uuid,
              ${dispatchInvocationId}::uuid, 'privacy.core', ${privacyMeasureDispatchedTopic}, 'privacy.core', 'privacy.core.privacy-measure',
              ${handoff.measureId}, ${payloadJson}::jsonb)`,
        'objects',
      );
      yield* transaction.execute(
        sql`insert into core.outbox_messages (outbox_message_id, tenant_id, domain_event_id, producer_module_key, topic,
              payload_json)
            values (${messageId}::uuid, ${dispatcher.tenantId}::uuid, ${domainEventId}::uuid, 'privacy.core', ${privacyMeasureDispatchedTopic},
              ${payloadJson}::jsonb)`,
        'objects',
      );
    }),
  );
  yield* input.outbox.matchMessages({ compositionRevision: input.compositionRevision });
  // the take-over report happened long ago: the original Communications delivery is settled and holds no claim
  const settled = yield* core.transaction((transaction) =>
    transaction.execute<{ readonly delivery: string }>(
      sql`update core.outbox_deliveries set status = 'done', claimed_by = null, claim_expires_at = null
           where outbox_message_id = ${messageId}::uuid and worker_key = ${RECEIVE_WORKER}
       returning outbox_delivery_id::text as delivery`,
      'objects',
    ),
  );
  const [delivery, ...extra] = settled;
  expect(extra).toEqual([]);
  return {
    deliveryId: Option.getOrThrow(Option.fromNullishOr(delivery?.delivery)),
    dispatchInvocationId,
    domainEventId,
    messageId,
  } satisfies NativeDispatch;
});

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
          const prepared = yield* prepare(manager, APPROVED_TYPE_ID);
          expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
          const { revisionId } = Schema.decodeUnknownSync(PrepareTemplateRevisionResultSchema)(prepared.body);
          for (const operation of ['activate', 'deactivate'] as const) {
            const allowed = yield* templateAction(manager, operation, revisionId);
            expect(allowed.status, `${operation} ${JSON.stringify(allowed.body)}`).toBe(200);
          }
          // DENIED: a member without any template capability changes nothing
          expect((yield* prepare(reader, APPROVED_TYPE_ID)).status).toBe(403);
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
            (yield* prepare({ ...foreignManager, tenantId: tenant.tenantId }, APPROVED_TYPE_ID)).status,
          );
          const invalidated = yield* templateAction(manager, 'invalidate', revisionId);
          expect(invalidated.status, JSON.stringify(invalidated.body)).toBe(200);
          // GRANTED THEN REVOKED: a role of exactly the four template capabilities admits each, then none
          const templateRole = yield* roles.capabilityRole(TEMPLATE_CAPABILITIES);
          yield* templateRole.grant();
          const readerPrepared = yield* prepare(reader, APPROVED_TYPE_ID);
          expect(readerPrepared.status, JSON.stringify(readerPrepared.body)).toBe(200);
          const readerRevision = Schema.decodeUnknownSync(PrepareTemplateRevisionResultSchema)(readerPrepared.body);
          expect((yield* templateAction(reader, 'activate', readerRevision.revisionId)).status).toBe(200);
          expect((yield* templateAction(reader, 'deactivate', readerRevision.revisionId)).status).toBe(200);
          yield* templateRole.revoke();
          expect((yield* prepare(reader, APPROVED_TYPE_ID)).status).toBe(403);
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
          // 2. Privacy reads the owner receipt: received, never a result. The production composition has NO assessment of
          // whether a hold or obligation applies to the targets (T2-13), so even the wait for a human is not yet established
          const received = yield* receipt(manager, 1);
          expect(received.status).toBe(200);
          expect(Option.getOrThrow(received.receipt).outcome).toMatchObject({
            reason: 'HOLD_APPLICABILITY_NOT_ASSESSED',
            status: 'RECEIVED',
          });
          const coverageRequest = {
            scope: {
              controllerRef: 'FICTIONAL-controller',
              ownerCapability: 'communications.core',
              requestedScopePartRefs: [...scopePartRefs],
              requestedScopeRef: 'FICTIONAL-requested-scope',
              subject: { _tag: 'RESOLVED_DATA_SUBJECT' as const, subjectRef: 'FICTIONAL-subject-1' },
              tenantId: tenant.tenantId,
              trustedLookupRefs: [lookup.lookupRef],
            },
            trustedLookups: [lookup],
          };
          const coverageFor = (principal: Principal) =>
            askAsPrivacy(principal, '/reads/privacy-owner-coverage', coverageRequest);
          // the manager holds both Read capabilities Tenant-wide: Privacy asks for it and is answered
          const coverage = yield* coverageFor(manager);
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
          // a human confirmed the owner Action, but nothing proves a RESTRICT took effect: the production owner never
          // reports the targets as achieved on the attestation alone (T1-05), it says the enforcement is not verifiable
          expect(after.outcome).toMatchObject({
            attempt: 2,
            includedResourceRefs: [],
            reason: 'OWNER_RESTRICTION_ENFORCEMENT_NOT_VERIFIABLE',
            status: 'INDETERMINATE',
          });
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
          // Privacy's own state machine takes the unverifiable enforcement as unknown, never as a success
          expect(settled.status).toBe('INDETERMINATE');
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
          // DENIED: only Privacy, as the calling module of its requester, may ask; a direct staff call, even with the
          // capability, and another calling module are refused.
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
          expect((yield* send(manager, '/reads/privacy-owner-coverage', coverageRequest)).status).toBe(403);
          // Both Reads declare `accessActor.subject: 'rights'`: a Privacy-delegated Read is decided on the requester's OWN
          // grant of that Read's declaration, never on identity alone. DENIED: a Tenant member without the capability.
          expect((yield* receipt(reader, 2)).status).toBe(403);
          expect((yield* coverageFor(reader)).status).toBe(403);
          // GRANTED THEN REVOKED, each Read separately: the receipt capability alone admits the receipt, not the coverage
          const receiptRole = yield* roles.capabilityRole([RECEIPT_READ]);
          yield* receiptRole.grant();
          const readerReceipt = yield* receipt(reader, 2);
          expect(readerReceipt.status).toBe(200);
          expect(Option.getOrThrow(readerReceipt.receipt).handoffFingerprint).toBe(fingerprint);
          expect((yield* coverageFor(reader)).status).toBe(403);
          const coverageRole = yield* roles.capabilityRole([COVERAGE_READ]);
          yield* coverageRole.grant();
          expect((yield* coverageFor(reader)).status).toBe(200);
          // even with both grants, the member's direct call is still refused: only the Privacy-delegated form is answered
          expect((yield* send(reader, '/reads/privacy-owner-coverage', coverageRequest)).status).toBe(403);
          // REVOKED: the identity itself ends, and the very next Privacy-delegated Read for it is refused despite its grants
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
          yield* receiptRole.revoke();
          yield* coverageRole.revoke();
          expect((yield* receipt(reader, 2)).status).toBe(403);
          expect((yield* coverageFor(reader)).status).toBe(403);
          // CROSS-TENANT: the foreign manager holds both capabilities in its own Tenant only; a claim naming this Tenant is
          // refused, and in its own Tenant this Tenant's scope is not found rather than answered
          const forged = { ...foreignManager, tenantId: tenant.tenantId };
          expect([401, 403]).toContain((yield* receipt(forged, 2)).status);
          expect([401, 403]).toContain((yield* coverageFor(forged)).status);
          const foreignCoverage = yield* coverageFor(foreignManager);
          expect(foreignCoverage.status, JSON.stringify(foreignCoverage.body)).toBe(404);
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

          // ---- The Shell-issued durable receipt carrier (#1406) ----
          // Privacy reads the receipt of a dispatch it delivered under the Shell's version-5 carrier: the ORIGINAL
          // dispatching human in the governance company, `sourceMode: 'dispatch'`, the exact request bound by its hash.
          // Core's gate then decides THIS registered Read declaration on that carrier: the dispatch is live, the
          // dispatcher still holds the dispatch grant in the governance company, and holds the receipt capability
          // Tenant-wide. A regression of the Read's declaration that Core's gate refuses for this carrier fails here.

          // A dispatch exists only where Privacy is installed, and only then are its capabilities projected for the Tenant.
          yield* core.transaction((transaction) =>
            transaction.execute(
              sql`insert into core.tenant_module_states (tenant_id, module_key, state)
                  values (${tenant.tenantId}::uuid, 'privacy.core', 'active')
                  on conflict (tenant_id, module_key) do update set state = excluded.state`,
              'objects',
            ),
          );
          const dispatchRole = yield* roles.capabilityRole([DISPATCH_CAPABILITY]);
          yield* dispatchRole.grant();
          const nativeDispatch = yield* recordNativeDispatch({
            compositionRevision: revision,
            core,
            dispatcher: reader,
            governanceLegalEntityId: tenant.legalEntityId,
            handoff,
            outbox,
          });
          const readThroughCarrier = Effect.fnUntraced(function* readThroughCarrier() {
            const token = yield* receiptCarrierFor({
              actor: privacyActor,
              attempt: pushed.attempt,
              compositionRevision: revision,
              dispatch: nativeDispatch,
              dispatcher: reader,
              gateway,
              governanceLegalEntityId: tenant.legalEntityId,
              handoff,
            });
            return yield* post(
              runtime,
              token,
              '/reads/privacy-owner-execution-outcome',
              { attempt: pushed.attempt, handoff: Schema.encodeSync(PrivacyMeasureHandoffSchema)(handoff) },
              false,
            );
          });
          /** The one decision Core's gate recorded for exactly this request. */
          const carrierDecision = (correlationId: string) =>
            core.transaction((transaction) =>
              transaction.execute<{
                readonly actor: string;
                readonly capability: string;
                readonly delegate: string | null;
                readonly outcome: string;
                readonly reasons: unknown;
              }>(
                sql`select actor_principal_id::text as actor, capability_key as capability, delegate_app_id as delegate,
                           outcome, reasons_json as reasons
                      from core.access_decision_logs
                     where tenant_id = ${tenant.tenantId}::uuid and correlation_id = ${correlationId}`,
                'objects',
              ),
            );
          // DENIED: the dispatch grant alone does not read the receipt; the receipt capability is rechecked Tenant-wide
          const ungranted = yield* readThroughCarrier();
          expect(ungranted.status, JSON.stringify(ungranted.body)).toBe(403);
          expect(yield* carrierDecision(ungranted.correlationId)).toMatchObject([
            { actor: reader.principalId, capability: RECEIPT_READ, delegate: 'privacy', outcome: 'DENIED' },
          ]);
          // ALLOWED on the grant: the very receipt the Privacy-delegated Read answers for the same attempt
          const carrierReceiptRole = yield* roles.capabilityRole([RECEIPT_READ]);
          yield* carrierReceiptRole.grant();
          const carried = yield* readThroughCarrier();
          expect(carried.status, JSON.stringify(carried.body)).toBe(200);
          const carriedReceipt = Option.getOrThrow(
            Schema.decodeUnknownSync(PrivacyOwnerExecutionOutcomeResponseSchema)(carried.body),
          );
          const delegatedReceipt = Option.getOrThrow((yield* receipt(manager, pushed.attempt)).receipt);
          expect(carriedReceipt.handoffFingerprint).toBe(fingerprint);
          // identical but for the moment each Read observed it
          expect(carriedReceipt).toEqual({
            ...delegatedReceipt,
            outcome: { ...delegatedReceipt.outcome, recordedAt: carriedReceipt.outcome.recordedAt },
          });
          expect(yield* carrierDecision(carried.correlationId)).toMatchObject([
            {
              actor: reader.principalId,
              capability: RECEIPT_READ,
              delegate: 'privacy',
              outcome: 'ALLOWED',
              reasons: [expect.objectContaining({ code: 'allow.granted' })],
            },
          ]);
          // REVOKED: the next carried Read is refused again
          yield* carrierReceiptRole.revoke();
          expect((yield* readThroughCarrier()).status).toBe(403);
          yield* dispatchRole.revoke();
        }),
      ).pipe(Effect.provide(services)),
    180_000,
  );
});

const DEFAULTS_LIST = 'communications.core.template-revision.list';
const VERIFY_EMAIL = 'commerce.customer-context.portal-auth.verify-email-message';

describe('Built-in template defaults with the real authorization engine (SpiceDB) and native PostgreSQL (#1398, #1406)', () => {
  it.live(
    'lets only a permitted member review the seed texts, prepare and activate one through the Actions, and refuses once revoked',
    () =>
      Effect.scoped(
        Effect.gen(function* builtInDefaults() {
          const { core, document, snapshot } = yield* publishComposition();
          const { revision } = snapshot.composition;
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
          // the manager holds the review and the existing prepare + activate Tenant-wide, the reader is a member without
          // any of them, and the foreign manager holds the review in the foreign Tenant only
          yield* grantTestTenantRoleAccess({
            ...target,
            holders: [
              {
                capabilityKeys: [DEFAULTS_LIST, TEMPLATE('prepare'), TEMPLATE('activate')],
                principalId: tenant.manager.principalId,
              },
              { capabilityKeys: ['party.registry.party.read'], principalId: tenant.reader.principalId },
            ],
            legalEntityIds: [tenant.legalEntityId],
            tenantId: tenant.tenantId,
          });
          yield* grantTestTenantRoleAccess({
            ...target,
            holders: [{ capabilityKeys: [DEFAULTS_LIST], principalId: foreign.manager.principalId }],
            legalEntityIds: [foreign.legalEntityId],
            tenantId: foreign.tenantId,
          });
          const gateway = yield* makeGateway();
          const runtime = yield* mountRuntime(gateway, document);
          const send = staffSender(gateway, revision, runtime);
          const { manager, reader } = tenant;
          const { manager: foreignManager } = foreign;
          const review = Effect.fnUntraced(function* review(principal: Principal) {
            const reply = yield* send(principal, '/reads/built-in-template-defaults', {});
            return {
              reply,
              result:
                reply.status === 200
                  ? Option.some(Schema.decodeUnknownSync(BuiltInTemplateDefaultsResponseSchema)(reply.body))
                  : Option.none(),
            };
          });
          const czechOf = Effect.fnUntraced(function* czechOf(principal: Principal) {
            const reviewed = Option.getOrThrow((yield* review(principal)).result);
            return Option.getOrThrow(
              Option.fromNullishOr(
                reviewed.entries.find(
                  (entry) => entry.identity.messageType === VERIFY_EMAIL && entry.identity.language === 'cs',
                ),
              ),
            );
          });

          // ALLOWED: day one, the manager sees every seed text with nothing in force and no own revision
          const dayOne = Option.getOrThrow((yield* review(manager)).result);
          expect(dayOne.entries).toHaveLength(6);
          expect(dayOne.entries.every((entry) => entry.inForce.source === 'NONE')).toBe(true);
          expect(dayOne.entries.every((entry) => entry.builtInDefault.approval === 'PENDING-APPROVER')).toBe(true);
          expect(dayOne.entries.every((entry) => entry.revisions.length === 0)).toBe(true);
          // DENIED: a member without the capability reads nothing
          expect((yield* review(reader)).reply.status).toBe(403);
          // PREPARE and ACTIVATE through the EXISTING Actions, under the manager's own session
          const prepared = yield* send(
            manager,
            '/communications/actions/prepare-template-revision',
            {
              body: '[FICTIONAL TEST COPY] {{verification_link}}',
              channel: 'email',
              language: 'cs',
              messageType: VERIFY_EMAIL,
              optionalPlaceholders: [],
              reason: 'Fictional replacement for the authorization tests',
              requiredPlaceholders: ['verification_link'],
              scope: { kind: 'tenant' },
              subject: '[FICTIONAL TEST COPY] Verify',
            },
            true,
          );
          expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
          const { revisionId } = Schema.decodeUnknownSync(PrepareTemplateRevisionResultSchema)(prepared.body);
          const activated = yield* send(
            manager,
            '/communications/actions/activate-template-revision',
            { reason: 'Fictional replacement for the authorization tests', revisionId },
            true,
          );
          expect(activated.status, JSON.stringify(activated.body)).toBe(200);
          const replaced = yield* czechOf(manager);
          expect(replaced).toMatchObject({
            inForce: { revisionId, source: 'TENANT_REVISION' },
          });

          // CROSS-TENANT: the foreign manager sees only the foreign Tenant, where nothing is in force
          expect((yield* czechOf(foreignManager)).inForce.source).toBe('NONE');
          // a forged Tenant claim is refused before any Communications code runs
          expect([401, 403]).toContain((yield* review({ ...foreignManager, tenantId: tenant.tenantId })).reply.status);

          // GRANTED THEN REVOKED: a role of exactly the review capability admits the reader, then refuses it again
          const roles = yield* makeTestTenantRoleAccess({
            ...target,
            legalEntityIds: [tenant.legalEntityId],
            principalId: reader.principalId,
            tenantId: tenant.tenantId,
          });
          const reviewRole = yield* roles.capabilityRole([DEFAULTS_LIST]);
          yield* reviewRole.grant();
          expect((yield* czechOf(reader)).inForce).toMatchObject({ revisionId, source: 'TENANT_REVISION' });
          yield* reviewRole.revoke();
          expect((yield* review(reader)).reply.status).toBe(403);
        }),
      ).pipe(Effect.provide(services)),
    120_000,
  );
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* submit-communication-request over the real boundary (#1406 D1, #1411 D.3, T2-17)                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The question Communications puts to Auth's published Read: the issuance and, for the recipient check, the Auth account. */
const PortalAuthIssuanceSourceRequestBodySchema = Schema.Struct({
  issuanceRef: PortalAuthIssuanceRefSchema,
  recipientSubjectId: Schema.optionalKey(Schema.String.pipe(Schema.brand('PortalAuthRecipientSubjectId'))),
});
type PortalAuthIssuanceSourceRequestBody = typeof PortalAuthIssuanceSourceRequestBodySchema.Type;

/**
 * LABELLED loopback peer of the owner the PRODUCTION Portal Auth ports reach over HTTP: the Shell's delegated-context issuance (a
 * FICTIONAL token for the admitted release) and Auth's published `portal-auth-issuance-source` Read, which answers what the
 * suite scripts. The REAL Auth answer body is proven on a real Auth store in `scripts/integration/auth-communications-*`; here
 * only the generated HTTP client of Communications and its fail-closed reading of the answer are exercised.
 */
const serveAuthOwnerPeer = Effect.fnUntraced(function* serveAuthOwnerPeer(
  readIssuance: (
    body: PortalAuthIssuanceSourceRequestBody,
  ) => Effect.Effect<{ readonly body: unknown; readonly status: number }>,
) {
  const received = yield* Ref.make<readonly PeerRequest[]>([]);
  const server = Context.get(yield* Layer.build(NodeHttpServer.layerTest), HttpServer.HttpServer);
  yield* server.serve(
    HttpServerRequest.HttpServerRequest.use((request) =>
      Effect.gen(function* answer() {
        const path = new URL(request.url, 'http://peer.test').pathname;
        const body = Schema.decodeUnknownOption(ReceivedJsonSchema)(yield* request.text).pipe(Option.getOrUndefined);
        yield* Ref.update(received, (all) => [
          ...all,
          {
            authorization: request.headers['authorization'],
            body,
            idempotencyKey: request.headers['idempotency-key'],
            path,
          },
        ]);
        if (path === DELEGATION_PATH) {
          const delegated = yield* Schema.decodeUnknownEffect(GatewayDelegatedContextRequestSchema)(body);
          // the Shell issues a ROOT-RELATIVE owner prefix (the response schema refuses an absolute URL); the caller resolves it
          return yield* HttpServerResponse.json({
            apiBaseUrl: '/commerce-customer-context-api',
            compositionRevision: delegated.compositionRevision,
            expiresAt: 4_070_908_800,
            token: 'fictional-auth-owner-token',
          });
        }
        if (path.endsWith('/reads/portal-auth-issuance-source')) {
          const asked = yield* Schema.decodeUnknownEffect(PortalAuthIssuanceSourceRequestBodySchema)(body);
          const reply = yield* readIssuance(asked);
          return yield* HttpServerResponse.json(reply.body, { status: reply.status });
        }
        return HttpServerResponse.empty({ status: 404 });
      }).pipe(Effect.orDie),
    ),
  );
  if (!NetAddress.isInetAddress(server.address)) {
    return yield* Effect.die('The Auth owner peer must bind one loopback TCP server');
  }
  return { origin: `http://127.0.0.1:${server.address.port}`, received };
});

const SUBMIT_PATH = '/communications/actions/submit-communication-request';
const REQUEST_SOURCE = 'communications.core.request-source';
const SOURCE_MODULE = 'commerce.customer-context';
const SOURCE_APP = 'commerce-customer-context';
const SOURCE_JOB = 'commerce.customer-context.submit-portal-auth-communication-request';
const SOURCE_ADMISSION_WORKLOAD = 'commerce.customer-context.source-write';

/**
 * What the Shell and Core establish when the Portal Auth source worker delivers a request, written here as the rows Core's gate
 * reads (the Shell issuing the assertion and Core's native admission Action are NOT run, so these rows are seeded):
 * - a real `system` principal of the Tenant bound to the registered workload `communications.core.request-source`
 *   (`bound: false` leaves it unregistered);
 * - the original integration principal of the source application with its admission and owner bindings, and the open
 *   execution fence of its original admission;
 * - the source's own claimed Outbox delivery that the worker runs in (`processing`, not expired).
 */
const bindWorkload = (tenantId: string, principalId: string, workload: string, incarnation: string) =>
  sql`insert into core.access_workload_bindings (binding_id, tenant_id, principal_id, workload_key, incarnation, status)
      values (${randomUUID()}::uuid, ${tenantId}::uuid, ${principalId}::uuid, ${workload}, ${incarnation}::uuid, 'active')`;

const seedSourceWorkerDelivery = (
  core: Effect.Success<ReturnType<typeof publishComposition>>['core'],
  tenantId: string,
  options: { readonly bound: boolean },
) =>
  Effect.gen(function* seedWorker() {
    const ids = {
      admissionInvocationId: randomUUID(),
      claimId: `claim-${randomUUID()}`,
      deliveryId: randomUUID(),
      domainEventId: randomUUID(),
      messageId: randomUUID(),
      originalPrincipalId: randomUUID(),
      originalWorkloadIncarnation: randomUUID(),
      ownerIncarnation: randomUUID(),
      principalId: randomUUID(),
      workerIncarnation: randomUUID(),
    };
    yield* core.transaction((transaction) =>
      Effect.gen(function* insertRows() {
        for (const [principalId, kind] of [
          [ids.principalId, 'system'],
          [ids.originalPrincipalId, 'integration'],
        ] as const) {
          yield* transaction.execute(
            sql`insert into core.principals (principal_id, tenant_id, kind, display_name, status)
                values (${principalId}::uuid, ${tenantId}::uuid, ${kind}, 'FICTIONAL source application principal', 'active')`,
            'objects',
          );
        }
        if (options.bound) {
          yield* transaction.execute(
            bindWorkload(tenantId, ids.principalId, REQUEST_SOURCE, ids.workerIncarnation),
            'objects',
          );
        }
        yield* transaction.execute(
          bindWorkload(tenantId, ids.originalPrincipalId, REQUEST_SOURCE, ids.ownerIncarnation),
          'objects',
        );
        yield* transaction.execute(
          bindWorkload(tenantId, ids.originalPrincipalId, SOURCE_ADMISSION_WORKLOAD, ids.originalWorkloadIncarnation),
          'objects',
        );
        yield* transaction.execute(
          sql`insert into core.source_execution_fences (tenant_id, admission_invocation_id, state)
              values (${tenantId}::uuid, ${ids.admissionInvocationId}::uuid, 'open')`,
          'objects',
        );
        yield* transaction.execute(
          sql`insert into core.action_invocations (action_invocation_id, tenant_id, principal_id, auth_method, auth_context_ref,
                action_key, status, request_hash, started_at, completed_at)
              values (${ids.admissionInvocationId}::uuid, ${tenantId}::uuid, ${ids.originalPrincipalId}::uuid, 'system',
                ${`job:${SOURCE_ADMISSION_WORKLOAD}:run:${ids.admissionInvocationId}`}, 'commerce.customer-context.fictional-source-write',
                'succeeded', ${'a'.repeat(64)}, now() - interval '1 minute', now() - interval '1 minute')`,
          'objects',
        );
        yield* transaction.execute(
          sql`insert into core.domain_events (domain_event_id, tenant_id, action_invocation_id, producer_module_key, event_type,
                subject_module_key, subject_resource_type, subject_resource_id, payload_json)
              values (${ids.domainEventId}::uuid, ${tenantId}::uuid, ${ids.admissionInvocationId}::uuid, ${SOURCE_MODULE},
                'commerce.customer-context.fictional-source-event.v1', ${SOURCE_MODULE}, 'commerce.customer-context.fictional-source',
                'fictional-1', '{}'::jsonb)`,
          'objects',
        );
        yield* transaction.execute(
          sql`insert into core.outbox_messages (outbox_message_id, tenant_id, domain_event_id, producer_module_key, topic, payload_json)
              values (${ids.messageId}::uuid, ${tenantId}::uuid, ${ids.domainEventId}::uuid, ${SOURCE_MODULE},
                'commerce.customer-context.fictional-source-event.v1', '{}'::jsonb)`,
          'objects',
        );
        yield* transaction.execute(
          sql`insert into core.outbox_deliveries (outbox_delivery_id, outbox_message_id, worker_key, consumer_module_key, status,
                attempts_count, claimed_by, claimed_at, claim_expires_at)
              values (${ids.deliveryId}::uuid, ${ids.messageId}::uuid, ${SOURCE_JOB}, ${SOURCE_MODULE}, 'processing', 1,
                ${ids.claimId}, now(), now() + interval '1 hour')`,
          'objects',
        );
      }),
    );
    return ids;
  });

/**
 * One workload assertion in the Shell-signed shape (version 4) of a Portal Auth source-worker delivery calling the
 * registered workload `communications.core.request-source`. It is signed here with the test key the runtime trusts: the Shell
 * issuing it is NOT run (see the suite header).
 */
const workloadAssertionFor = Effect.fnUntraced(function* workloadAssertionFor(input: {
  readonly compositionRevision: string;
  readonly gateway: Gateway;
  readonly seed: Effect.Success<ReturnType<typeof seedSourceWorkerDelivery>>;
  readonly sourceBuildMarker: string;
  readonly sourceModule: string;
  readonly tenantId: string;
  readonly workloadKey: string;
}) {
  const { seed } = input;
  const issuedAt = Math.floor((yield* DateTime.nowAsDate).getTime() / 1000);
  return yield* signAssertion(
    input.gateway,
    {
      compositionRevision: input.compositionRevision,
      principal: {
        authContextRef: `job:${SOURCE_JOB}:run:${seed.deliveryId}`,
        authMethod: 'system',
        principalId: seed.principalId,
        tenantId: input.tenantId,
      },
      targetBuildMarker: ultramodernApiMarker.buildMarker,
      ver: WORKLOAD_GATEWAY_ASSERTION_VERSION,
      workload: {
        admissionInvocationId: seed.admissionInvocationId,
        bindingIncarnation: seed.workerIncarnation,
        claimId: seed.claimId,
        declarationKey: 'communications.core.communication-request.submit',
        entrypointKey: 'communications.core.submit-communication-request',
        jobKey: SOURCE_JOB,
        legalEntityScope: 'optional',
        originalOwnerBindingIncarnation: seed.ownerIncarnation,
        originalPrincipalId: seed.originalPrincipalId,
        originalWorkloadBindingIncarnation: seed.originalWorkloadIncarnation,
        originalWorkloadKey: SOURCE_ADMISSION_WORKLOAD,
        runReference: seed.deliveryId,
        schemaVersion: '1',
        sourceAppId: SOURCE_APP,
        sourceBuildMarker: input.sourceBuildMarker,
        sourceMode: 'worker',
        workerKey: SOURCE_JOB,
        workerModuleKey: input.sourceModule,
        workloadKey: input.workloadKey,
      },
    },
    seed.principalId,
    issuedAt,
  );
});

/** What Auth's published Read answers while a scenario runs. */
interface AuthBehavior {
  current: 'CURRENT' | 'UNAVAILABLE';
}

/**
 * The harness of the submit scenarios: the production HTTP assembly (real gate, real redemption, native PostgreSQL, real
 * SpiceDB), a real Tenant, the registered workers the Core gate reads, and the loopback owner peer of Auth's Read.
 */
const submitHarness = Effect.fnUntraced(function* submitHarness() {
  const { core, document, snapshot } = yield* publishComposition();
  const { revision } = snapshot.composition;
  const gateway = yield* makeGateway();
  // Auth's published Read, which the production owner ports reach over HTTP, answers what `authBehavior` says
  const authBehavior: AuthBehavior = { current: 'CURRENT' };
  const authPeer = yield* serveAuthOwnerPeer((asked) =>
    Effect.sync(() => {
      if (authBehavior.current === 'UNAVAILABLE') {
        return { body: {}, status: 503 };
      }
      const facts = {
        issuanceRef: asked.issuanceRef,
        kind: 'FACTS',
        latestRevision: 1,
        state: 'commerce.customer-context.portal-auth.issuance-current',
      };
      return {
        body:
          asked.recipientSubjectId === undefined
            ? facts
            : { ...facts, originalEndpoint: { kind: 'CURRENT', mask: 'h***@example.test' } },
        status: 200,
      };
    }),
  );
  const runtime = yield* mountRuntime(gateway, document, {
    ONTOS_GATEWAY_MODULE_API_KEY: 'fictional-communications-module-api-key',
    ONTOS_SHELL_GATEWAY_BASE_URL: `${authPeer.origin}${SHELL_PREFIX}`,
  });
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
  const customerContext = snapshot.composition.modules.find(({ moduleId }) => moduleId === SOURCE_MODULE);
  const sourceBuildMarker = Option.getOrThrow(Option.fromNullishOr(customerContext)).deployment.buildMarker;
  // the registered worker holds the request-source workload in THIS Tenant only
  const worker = yield* seedSourceWorkerDelivery(core, tenant.tenantId, { bound: true });
  const unregistered = yield* seedSourceWorkerDelivery(core, tenant.tenantId, { bound: false });
  const foreignWorker = yield* seedSourceWorkerDelivery(core, foreign.tenantId, { bound: true });

  // fixed instants: the request states Auth's own issuance window, far from any clock this suite runs on
  const issuedAt = DateTime.makeUnsafe('2026-11-25T08:00:00.000Z');
  const requestOf = (tenantId: string) =>
    portalAuthVerificationRequest(
      {
        expiresAt: DateTime.makeUnsafe('2099-01-01T00:00:00.000Z'),
        issuanceRef: PortalAuthIssuanceRefSchema.make(`pae-${randomUUID().replaceAll('-', '')}`),
        issuedAt,
        providerSubjectId: randomUUID(),
      },
      { tenantId },
    );
  const submitAs = Effect.fnUntraced(function* submitAs(
    seed: Effect.Success<ReturnType<typeof seedSourceWorkerDelivery>>,
    tenantId: string,
    overrides: { readonly sourceModule?: string; readonly workloadKey?: string } = {},
  ) {
    const token = yield* workloadAssertionFor({
      compositionRevision: revision,
      gateway,
      seed,
      sourceBuildMarker,
      sourceModule: overrides.sourceModule ?? SOURCE_MODULE,
      tenantId,
      workloadKey: overrides.workloadKey ?? REQUEST_SOURCE,
    });
    return yield* post(runtime, token, SUBMIT_PATH, yield* requestOf(tenantId), true);
  });
  const stored = Effect.gen(function* storedRows() {
    const database = yield* makeRuntimeDatabase();
    const rows = (tenantId: string) =>
      database.inTenant(tenantId, (transaction) =>
        Effect.all({
          intents: transaction.select({ intentId: messageIntents.intentId }).from(messageIntents),
          requests: transaction.select({ requestId: communicationRequests.requestId }).from(communicationRequests),
        }),
      );
    return { foreign: yield* rows(foreign.tenantId), tenant: yield* rows(tenant.tenantId) };
  }).pipe(Effect.provide(nativeServices));

  return {
    authBehavior,
    authPeer,
    foreign,
    foreignWorker,
    gateway,
    requestOf,
    revision,
    runtime,
    sourceBuildMarker,
    stored,
    submitAs,
    tenant,
    unregistered,
    worker,
  };
});

describe('submit-communication-request over real HTTP, the registered workload gate and native PostgreSQL (#1406 D1, T2-17)', () => {
  it.live(
    'admits only the registered Portal Auth source worker of the Tenant to the handler; a human, an unregistered, foreign or other-module worker is refused and creates nothing',
    () =>
      Effect.scoped(
        Effect.gen(function* gate() {
          const harness = yield* submitHarness();
          const { foreignWorker, gateway, revision, runtime, stored, submitAs, tenant, unregistered, worker } = harness;
          const nothing = { foreign: { intents: [], requests: [] }, tenant: { intents: [], requests: [] } };

          // DENIED: a HUMAN staff member of the Tenant, however fully the Tenant grants it: the Action is workload-only
          const human = yield* assertionFor(gateway, revision, tenant.manager);
          const asHuman = yield* post(runtime, human, SUBMIT_PATH, yield* harness.requestOf(tenant.tenantId), true);
          expect(asHuman.status, JSON.stringify(asHuman.body)).toBe(403);
          // DENIED: a system principal that holds no request-source workload in this Tenant
          const asUnregistered = yield* submitAs(unregistered, tenant.tenantId);
          expect(asUnregistered.body, 'unregistered').toMatchObject({
            reasons: ['deny.workload_unbound'],
            status: 403,
          });
          // DENIED: the registered principal of ANOTHER Tenant never acts in this one
          const asForeign = yield* submitAs(foreignWorker, tenant.tenantId);
          expect([401, 403], JSON.stringify(asForeign.body)).toContain(asForeign.status);
          // DENIED: an assertion naming another registered workload than the one the Action declares
          const asOtherWorkload = yield* submitAs(worker, tenant.tenantId, { workloadKey: 'payment.source-ingress' });
          expect([401, 403], JSON.stringify(asOtherWorkload.body)).toContain(asOtherWorkload.status);
          expect(yield* stored).toEqual(nothing);

          // DENIED: a worker of ANOTHER module than the delivery it claims to run in: Core's delivery liveness check binds the claim
          // to the source module's own claimed Outbox delivery, so a foreign module is refused by the gate, before any handler
          const asOtherModule = yield* submitAs(worker, tenant.tenantId, { sourceModule: 'payment.core' });
          expect(asOtherModule.body, 'other module').toMatchObject({ reasons: ['deny.workload_unbound'], status: 403 });
          expect(yield* stored).toEqual(nothing);

          // ADMITTED: the registered worker passes the real gate (the redemption, the delivery liveness, the binding incarnation and
          // the open admission fence) and reaches the handler: it is not refused by authorization
          const admitted = yield* submitAs(worker, tenant.tenantId);
          expect([401, 403], JSON.stringify(admitted.body)).not.toContain(admitted.status);
        }).pipe(Effect.provide(Layer.mergeAll(services, nativeServices))),
      ),
  );

  /**
   * REGRESSION of D-2 (the production owner ports were refused by Core). Two causes, both fixed: the Communications manifest
   * declared no `requirements.operations` entry for the asks of the intake Action and the pre-handoff workers (Auth's issuance
   * Read, Privacy's two eligibility Reads), and the adapters sent a condition name instead of the requirement key; and this
   * suite's loopback issuer answered an ABSOLUTE `apiBaseUrl`, which the published response schema refuses (the Shell issues a
   * root-relative owner prefix). The scenario asks Auth through Core's delegated gateway with its real conditional-lease check.
   */
  it.live(
    '[T2-17 DEFECT] an admitted source worker is decided through the production owner ports: stored, suppressed on the undeclared Privacy scope, replayed on a repeat',
    () =>
      Effect.scoped(
        Effect.gen(function* decidedByProduction() {
          const harness = yield* submitHarness();
          const {
            authBehavior,
            authPeer,
            gateway,
            requestOf,
            revision,
            runtime,
            sourceBuildMarker,
            stored,
            tenant,
            worker,
          } = harness;
          const nothing = { intents: [], requests: [] };
          // Auth's published Read unavailable: the production owner ports fail CLOSED (retryable), nothing valid is created
          authBehavior.current = 'UNAVAILABLE';
          const request = yield* requestOf(tenant.tenantId);
          const submitOnce = Effect.fnUntraced(function* submitOnce() {
            const token = yield* workloadAssertionFor({
              compositionRevision: revision,
              gateway,
              seed: worker,
              sourceBuildMarker,
              sourceModule: SOURCE_MODULE,
              tenantId: tenant.tenantId,
              workloadKey: REQUEST_SOURCE,
            });
            return yield* post(runtime, token, SUBMIT_PATH, request, true);
          });
          const whileAuthDown = yield* submitOnce();
          expect(whileAuthDown.status, JSON.stringify(whileAuthDown.body)).toBe(503);
          expect((yield* stored).tenant).toEqual(nothing);

          // Auth answers Current: decided and stored. The production composition declares NO Privacy scope (an open owner gate,
          // #1396 J), so the one message intent is SUPPRESSED as an unresolved Privacy context and nothing is handed off.
          authBehavior.current = 'CURRENT';
          const decidedReply = yield* submitOnce();
          expect(decidedReply.status, JSON.stringify(decidedReply.body)).toBe(200);
          expect(decidedReply.body).toMatchObject({
            decision: {
              intents: [{ reason: 'PRIVACY_CONTEXT_AMBIGUOUS', status: 'SUPPRESSED' }],
              kind: 'MESSAGE_INTENTS',
            },
            outcome: 'DECIDED',
            replayed: false,
          });
          const afterDecision = yield* stored;
          expect(afterDecision.tenant.requests).toHaveLength(1);
          expect(afterDecision.tenant.intents).toHaveLength(1);
          // the same request again (a fresh Idempotency-Key) is a replay of the SAME decision, never a second message
          const replayed = yield* submitOnce();
          expect(replayed.body).toMatchObject({ outcome: 'DECIDED', replayed: true });
          expect((yield* stored).tenant).toEqual(afterDecision.tenant);
          // every ask of Auth carried fresh delegated authority
          const asks = (yield* Ref.get(authPeer.received)).filter(({ path }) =>
            path.endsWith('/reads/portal-auth-issuance-source'),
          );
          expect(asks.length).toBeGreaterThanOrEqual(2);
          expect(asks.every(({ authorization }) => authorization === 'Bearer fictional-auth-owner-token')).toBe(true);
        }).pipe(Effect.provide(Layer.mergeAll(services, nativeServices))),
      ),
  );
});
