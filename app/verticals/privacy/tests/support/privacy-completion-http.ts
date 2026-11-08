import { HttpApi } from 'effect/http-api';
// Explicit TEST assembly: production Privacy defaults remain unavailable.
import {
  defineDatabaseIdentityEnrollment,
  makeDatabaseIdentityEnrollmentLive,
  ActionAuthorizationPreflightDatabaseLive,
  ContextAccessLive,
  extractVerticalRuntimeSafeDescriptors,
  canonicalOntosPublicApiKey,
  OntosActionContractSchema,
  OntosApiContractSchema,
  OntosOperationContractSchema,
  OntosOutboxSubscriptionContractSchema,
  OntosModuleRequirementsSchema,
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
  GatewayAssertionRedemptionUnavailableError,
  makeActionRuntimeLive,
  ReadRuntimeLive,
  TenantModuleStateServiceLive,
} from '@app/core-runtime';
import { makeOwnerActionApprovalsLive } from '@app/core-runtime/access/approvals/owner-runtime';
import { CoreDatabase, testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import {
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { ActiveApplicationCompositionConfigLive } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { executePrivacyMeasureExecutionWithAuthorization } from '@app/party-registry/api/client';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import { GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS } from '@app/shared-contracts';
import { NodeCrypto, NodeHttpServer, NodeHttpServerRequest, NodeServices } from '@effect/platform-node';
import { runMain } from '@effect/platform-node/NodeRuntime';
import { Clock, Config, Crypto, Deferred, Effect, FiberHandle, Layer, Option, Redacted, Schema } from 'effect';
import { FetchHttpClient, HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { PgClient } from '@effect/sql-pg';
import { Reactivity } from 'effect/reactivity';
import { Hex } from 'effect/encoding';

import { makePrivacyApiRuntime } from '../../api/index.ts';
import { makePrivacyCompletionAccessGate } from './access-gate.ts';
import { privacyRegistration } from '../../vertical.registration.ts';
import { privacyManifest } from '../../vertical.manifest.ts';
import { outboxWorkerEntry } from '../../src/worker-host/entry.ts';
import { ultramodernApiMarker, ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import { OwnerExecutionAuthority } from '../../src/actions/privacy-owner-execution-authority.ts';
import { PrivacyOperationPersistenceError } from '../../src/persistence/privacy-operation-repository.ts';
import { PrivacyActionRejected } from '../../src/actions/privacy-operation-action-support.ts';
import { PrivacyMeasureHandoffSchema } from '../../shared/domain/privacy-measure-handoff.ts';

class PrivacyCompletionHttpFailure extends Schema.TaggedError<PrivacyCompletionHttpFailure>()(
  'PrivacyCompletionHttpFailure',
  { reason: Schema.String },
) {}
const completeActualPrivacyWatchdog = Effect.scoped(
  Effect.gen(function* completeActualPrivacyWatchdogCycle() {
    type Failure = Effect.Error<ReturnType<typeof outboxWorkerEntry.runLoop>> | PrivacyCompletionHttpFailure;
    const completed = yield* Deferred.make<true, Failure>();
    const handle = yield* FiberHandle.make<Effect.Success<ReturnType<typeof outboxWorkerEntry.runLoop>>, Failure>();
    const loop = outboxWorkerEntry.runLoop({
      config: {
        claimOwner: `privacy.core-outbox-worker:privacy-completion-${process.pid}`,
        maxDeliveries: 1,
        pollIntervalMs: 10,
      },
      health: {
        cycleFailed: Deferred.fail(
          completed,
          new PrivacyCompletionHttpFailure({ reason: 'The actual Privacy watchdog cycle failed' }),
        ).pipe(Effect.asVoid),
        cycleSucceeded: Deferred.succeed(completed, true).pipe(Effect.asVoid),
      },
    });
    yield* FiberHandle.run(
      handle,
      loop.pipe(Effect.tapCause((cause) => Deferred.failCause(completed, cause).pipe(Effect.asVoid))),
    );
    yield* Deferred.await(completed);
  }),
);
// Closed TEST transport fault. It cannot supply an outcome or bypass the real Action.
export const makeReportResponseLossControl = () => {
  let armed = false;
  let discardedResponses = 0;
  let committedResponseStatus: number | null = null;
  return {
    arm: () => {
      if (armed || discardedResponses !== 0) {
        return false;
      }
      armed = true;
      return true;
    },
    discard: (method: string, url: string, status: number, close: () => void) => {
      if (
        !armed ||
        method !== 'POST' ||
        url !== '/privacy/actions/record-owner-execution-outcome' ||
        status < 200 ||
        status >= 300
      ) {
        return false;
      }
      armed = false;
      close();
      discardedResponses += 1;
      committedResponseStatus = status;
      return true;
    },
    observe: () => ({ armed, committedResponseStatus, discardedResponses }),
  };
};
const unavailable = () =>
  new PrivacyOperationPersistenceError({
    code: 'privacy_operation_persistence_unavailable',
    reason: 'TEST owner receipt authority is unavailable',
  });

const invalidCapabilities = () => new PrivacyCompletionHttpFailure({ reason: 'Invalid TEST runtime capabilities' });

const unavailableProbe = () =>
  new PrivacyCompletionHttpFailure({ reason: 'TEST native redemption identity is unavailable' });

const verifyRuntimeCapabilities = Effect.fn('PrivacyCompletionTest.verifyRuntimeCapabilities')(
  function* verifyRuntimeCapabilities(
    runtime: PgClient.PgClient,
    settings: { readonly database: string; readonly runtimeUser: string },
  ) {
    const rows = yield* runtime`select current_database() as database, current_user as role,
      session_user as session, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
      from pg_roles where rolname=current_user`.pipe(Effect.mapError(unavailableProbe));
    const [row] = yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({
          database: Schema.String,
          rolbypassrls: Schema.Boolean,
          rolcreatedb: Schema.Boolean,
          rolcreaterole: Schema.Boolean,
          role: Schema.String,
          rolsuper: Schema.Boolean,
          session: Schema.String,
        }),
      ),
    )(rows).pipe(Effect.mapError(unavailableProbe));
    if (
      row === undefined ||
      ![
        row.database === settings.database,
        row.role === settings.runtimeUser,
        row.session === settings.runtimeUser,
        !row.rolsuper,
        !row.rolbypassrls,
        !row.rolcreaterole,
        !row.rolcreatedb,
      ].every(Boolean)
    ) {
      return yield* invalidCapabilities();
    }
    for (const operation of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      const privileges = yield* runtime<{
        allowed: boolean;
      }>`select has_table_privilege(current_user,${'privacy_completion_test.redemptions'},${operation}) as allowed`.pipe(
        Effect.mapError(unavailableProbe),
      );
      if (privileges[0]?.allowed !== ['SELECT', 'INSERT'].includes(operation)) {
        return yield* invalidCapabilities();
      }
    }
    const ddl = yield* runtime<{
      allowed: boolean;
    }>`select has_schema_privilege(current_user,'privacy_completion_test','CREATE') as allowed`.pipe(
      Effect.mapError(unavailableProbe),
    );
    const [ddlRow] = ddl;
    if (ddlRow === undefined || ddlRow.allowed) {
      return yield* invalidCapabilities();
    }
    return yield* Effect.void;
  },
);

const serve = Effect.scoped(
  Effect.gen(function* completionPrivacyHttp() {
    const unexpectedAdmin = yield* Config.Redacted('DATABASE_ADMIN_URL').pipe(Config.option);
    const settings = yield* Config.all({
      apiKey: Config.Redacted('ONTOS_PRIVACY_MEASURE_WORKER_API_KEY'),
      database: Config.String('ONTOS_1258_TEST_DATABASE'),
      party: Config.String('ONTOS_PARTY_REGISTRY_API_BASE_URL'),
      revision: Config.String('ONTOS_1258_TEST_REVISION'),
      runtime: Config.Redacted('DATABASE_URL'),
      runtimeUser: Config.String('ONTOS_1258_TEST_RUNTIME'),
      shell: Config.String('ONTOS_SHELL_GATEWAY_BASE_URL'),
    });
    const databaseAddress = new URL(Redacted.value(settings.runtime));
    if (
      !['postgres:', 'postgresql:'].includes(databaseAddress.protocol) ||
      !['localhost', '127.0.0.1'].includes(databaseAddress.hostname) ||
      databaseAddress.search !== '' ||
      databaseAddress.hash !== '' ||
      databaseAddress.pathname !== `/${settings.database}` ||
      !settings.database.startsWith('ontos_test_party_gateway_') ||
      decodeURIComponent(databaseAddress.username) !== settings.runtimeUser ||
      Option.isSome(unexpectedAdmin)
    ) {
      return yield* new PrivacyCompletionHttpFailure({ reason: 'TEST redemption requires the owned database' });
    }
    const reactivity = yield* Reactivity.make;
    const runtime = yield* PgClient.make({ maxConnections: 2, url: settings.runtime }).pipe(
      Effect.provideService(Reactivity.Reactivity, reactivity),
      Effect.mapError(
        () => new PrivacyCompletionHttpFailure({ reason: 'TEST native redemption identity is unavailable' }),
      ),
    );
    yield* verifyRuntimeCapabilities(runtime, settings);
    let redemptionAvailable = true;
    let authorityAvailable = true;
    const responseLoss = makeReportResponseLossControl();
    const redemption = Layer.succeed(GatewayAssertionRedemptionService, {
      consume: Effect.fn('PrivacyCompletionTest.redeem')(function* redeem(input) {
        if (!redemptionAvailable) {
          return yield* new GatewayAssertionRedemptionUnavailableError({
            reason: 'TEST native redemption is unavailable',
          });
        }
        const now = yield* Clock.currentTimeMillis;
        if (input.expiresAtEpochSeconds + GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS <= Math.floor(now / 1000)) {
          return yield* new GatewayAssertionReplayError({ reason: 'The Bearer assertion is no longer usable' });
        }
        const inserted = yield* runtime`insert into privacy_completion_test.redemptions (issuer,audience,jti)
          values (${input.issuer},${input.audience},${input.jti}) on conflict do nothing returning jti`.pipe(
          Effect.mapError(
            () => new GatewayAssertionRedemptionUnavailableError({ reason: 'TEST native redemption is unavailable' }),
          ),
        );
        if (inserted.length !== 1) {
          return yield* new GatewayAssertionReplayError({ reason: 'The Bearer assertion is no longer usable' });
        }
        return yield* Effect.void;
      }),
    });
    const crypto = yield* Crypto.Crypto;
    // Every owner runtime and approval store uses the already validated case pool.
    const executor = yield* testCoreDatabase.pipe(Effect.provideService(PgClient.PgClient, runtime));
    const persistence = Layer.succeed(CoreDatabase, { executor });
    const identitiesAndCrypto = Layer.mergeAll(
      Layer.succeed(Crypto.Crypto, crypto),
      makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([])),
    );
    const authority = Layer.succeed(OwnerExecutionAuthority, {
      resolve: Effect.fn('PrivacyCompletionTest.authoritativeReceipt')(function* resolve(request, context) {
        if (!authorityAvailable) {
          return yield* unavailable();
        }
        const { handoff } = context;
        if (handoff.owningCapability !== 'party.registry') {
          return yield* unavailable();
        }
        const credential = yield* issueApiKeyGatewayContext(
          {
            audience: 'party-registry',
            compositionRevision: settings.revision,
            legalEntityId: context.legalEntityId,
          },
          { apiKey: settings.apiKey, baseUrl: settings.shell, requestCorrelation: context.actionInvocationId },
        ).pipe(Effect.mapError(unavailable));
        const receipt = yield* executePrivacyMeasureExecutionWithAuthorization(
          { idempotencyKey: handoff.idempotencyKey },
          `Bearer ${credential.token}`,
          context.actionInvocationId,
          { baseUrl: settings.party, compositionRevision: settings.revision },
        ).pipe(Effect.mapError(unavailable));
        if (Option.isNone(receipt)) {
          return yield* unavailable();
        }
        const canonical = yield* Schema.encodeEffect(Schema.fromJsonString(PrivacyMeasureHandoffSchema))({
          ...handoff,
          contentScopeRefs: handoff.contentScopeRefs.toSorted(),
          expectedEvidenceRefs: handoff.expectedEvidenceRefs.toSorted(),
          preconditionRefs: handoff.preconditionRefs.toSorted(),
          resourceRefs: handoff.resourceRefs.toSorted(),
        }).pipe(Effect.mapError(unavailable));
        const fingerprint = Hex.encode(
          yield* crypto.digest('SHA-256', new TextEncoder().encode(canonical)).pipe(Effect.mapError(unavailable)),
        );
        if (receipt.value.handoffFingerprint !== fingerprint || request.attempt !== receipt.value.outcome.attempt) {
          return yield* new PrivacyActionRejected({
            code: 'privacy_action_rejected',
            reason: 'TEST authority receipt does not match the immutable handoff',
          });
        }
        return {
          authorityRef: 'TEST:public-party-receipt',
          contentScopeRefs: handoff.contentScopeRefs,
          evidenceRefs: receipt.value.outcome.evidenceRefs,
          outcome: receipt.value.outcome,
          receiptRef: receipt.value.outcome.outcomeId,
          resourceRefs: handoff.resourceRefs,
          subjectRef: handoff.subjectRef,
          tenantId: context.tenantId,
        };
      }),
    });
    const source = ActiveApplicationCompositionSourceLive.pipe(Layer.provide(FetchHttpClient.layer));
    const moduleState = TenantModuleStateServiceLive.pipe(Layer.provide(persistence));
    const gate = ModuleStateGateLive.pipe(Layer.provide(moduleState));
    const entrypoint = ModuleEntrypointGatewayLive.pipe(Layer.provide(gate));
    // The one access gate this suite scripts (C04 harness shape); the legacy pair stays beside it
    // until the runners stop requiring `ActionPermission`/`ContextAccess` (C14).
    const accessGate = makePrivacyCompletionAccessGate();
    const scope = OperationalScopeResolverLive.pipe(
      Layer.provide(Layer.mergeAll(persistence, ContextAccessLive, accessGate.layer)),
    );
    const infrastructure = Layer.mergeAll(
      persistence,
      ContextAccessLive,
      gate,
      entrypoint,
      scope,
      ActionRepositoryLive,
      ActionPermissionLive,
      ActionAuthorizationPreflightDatabaseLive.pipe(Layer.provideMerge(persistence)),
      ActiveApplicationCompositionConfigLive.pipe(Layer.provide(source)),
      accessGate.layer,
    );
    const ownerApprovals = makeOwnerActionApprovalsLive(ultramodernDeliveryUnit, privacyRegistration).pipe(
      Layer.provideMerge(authority),
      Layer.provide(infrastructure),
      Layer.provide(identitiesAndCrypto),
    );
    const action = makeActionRuntimeLive(ultramodernDeliveryUnit).pipe(
      Layer.provideMerge(ownerApprovals),
      Layer.provideMerge(authority),
      Layer.provide(infrastructure),
      Layer.provide(identitiesAndCrypto),
    );
    const read = ReadRuntimeLive.pipe(
      Layer.provide(Layer.mergeAll(persistence, ContextAccessLive, entrypoint, scope, accessGate.layer)),
      Layer.provide(identitiesAndCrypto),
    );
    const api = makePrivacyApiRuntime(read, action, redemption);
    const handler = yield* Effect.acquireRelease(
      Effect.sync(() => api.createHandler()),
      (value) => Effect.promise(value.dispose.bind(value)),
    );
    const server = yield* HttpServer.HttpServer;
    yield* server.serve(
      Effect.gen(function* privacyRequest() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.method === 'POST' && request.url === '/__1258/dispatch-watchdog/complete') {
          return yield* completeActualPrivacyWatchdog.pipe(
            Effect.map(() => HttpServerResponse.empty({ status: 204 })),
            Effect.catch((error) => HttpServerResponse.json({ errorTag: error._tag }, { status: 503 })),
          );
        }
        if (request.method === 'POST' && request.url === '/__1258/report-response/discard-next') {
          return HttpServerResponse.empty({ status: responseLoss.arm() ? 204 : 409 });
        }
        if (request.method === 'GET' && request.url === '/__1258/report-response/evidence') {
          return yield* HttpServerResponse.json(responseLoss.observe());
        }
        if (request.method === 'POST' && request.url === '/__1258/authority/unavailable') {
          authorityAvailable = false;
          return HttpServerResponse.empty();
        }
        if (request.method === 'POST' && request.url === '/__1258/authority/available') {
          authorityAvailable = true;
          return HttpServerResponse.empty();
        }
        if (request.method === 'POST' && request.url === '/__1258/redemption/unavailable') {
          redemptionAvailable = false;
          return HttpServerResponse.empty();
        }
        if (request.method === 'POST' && request.url === '/__1258/redemption/available') {
          redemptionAvailable = true;
          return HttpServerResponse.empty();
        }
        const webRequest = yield* HttpServerRequest.toWeb(request);
        const response = yield* Effect.tryPromise({
          catch: () => new PrivacyCompletionHttpFailure({ reason: 'TEST Privacy HTTP adapter failed' }),
          try: handler.handler.bind(handler, webRequest, undefined),
        });
        // The actual governed handler has resolved after its transaction committed.
        // Destroy the Node response before any status/body can reach the worker. A
        // post-report worker barrier would already have received that response.
        responseLoss.discard(request.method, request.url, response.status, () => {
          NodeHttpServerRequest.toServerResponse(request).destroy();
        });
        return HttpServerResponse.fromWeb(response);
      }),
    );
    const { address } = server;
    if (!Schema.is(Schema.Struct({ port: Schema.Number }))(address)) {
      return yield* new PrivacyCompletionHttpFailure({ reason: 'A loopback Privacy TCP address is required' });
    }
    const ready = yield* Schema.encodeEffect(
      Schema.fromJsonString(
        Schema.Struct({ marker: Schema.Unknown, port: Schema.Number, type: Schema.Literal('ready') }),
      ),
    )({ marker: ultramodernApiMarker, port: address.port, type: 'ready' });
    yield* Effect.sync(() => process.stdout.write(`${ready}\n`));
    return yield* Effect.never;
  }),
);

const ownerRuntime = extractVerticalRuntimeSafeDescriptors(privacyRegistration);
const descriptionSchema = Schema.Struct({
  marker: Schema.Unknown,
  runtime: Schema.Struct({
    actions: Schema.Array(OntosActionContractSchema),
    api: Schema.Array(OntosApiContractSchema),
    operationContracts: Schema.Array(OntosOperationContractSchema),
    outboxSubscriptions: Schema.Array(OntosOutboxSubscriptionContractSchema),
    requirements: Schema.optionalKey(OntosModuleRequirementsSchema),
  }),
});
const describe = Schema.encodeEffect(Schema.fromJsonString(descriptionSchema))({
  marker: ultramodernApiMarker,
  runtime: {
    ...ownerRuntime,
    api: Object.entries(privacyManifest.publicSurface.api).map(([key, api]) => {
      if (!HttpApi.isHttpApi(api)) {
        throw new Error('The actual owner public API declaration is not a genuine HttpApi');
      }
      return {
        key: canonicalOntosPublicApiKey(ownerRuntime.moduleId, key),
        operationKeys: Object.values(api.groups).flatMap((group) =>
          Object.values(group.endpoints).map((endpoint) =>
            group.topLevel ? endpoint.identifier : `${group.identifier}.${endpoint.identifier}`,
          ),
        ),
      };
    }),
  },
}).pipe(Effect.flatMap((line) => Effect.sync(() => process.stdout.write(`${line}\n`))));
runMain(
  Effect.scoped(
    Effect.gen(function* completionProcessEntry() {
      if (process.argv.includes('--describe')) {
        return yield* describe;
      }
      const services = yield* Layer.build(
        Layer.mergeAll(NodeHttpServer.layerTest, NodeCrypto.layer, NodeServices.layer),
      );
      return yield* serve.pipe(Effect.provideContext(services));
    }),
  ),
);
