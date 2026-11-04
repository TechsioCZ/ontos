import { NodeHttpServer, NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, Layer, Option, Redacted, Result, Schema } from 'effect';
import { ContextAccessLive, DatabaseConfigLive, ReadRuntime } from '@app/core-runtime';
import { GatewayAssertionRedemptionService } from '@app/core-runtime/auth/gateway-assertion-redemption';
import { FetchHttpClient, HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { bindGatewayPrincipalVerifier } from '@app/gateway-principal-verifier/server';
import { ActionPrincipalVerifierLive } from '../../api/auth/action-principal.ts';

import {
  configuredGatewayAssertionRedemptionLive,
  makeCommerceCustomerContextApiRuntime,
  productionActionRuntimeLive,
  productionReadRuntimeLive,
} from '../../api/index.ts';
import { optionalCommercePortalAuthConfig } from '../../api/portal-auth/provider/config.ts';
import { commercePortalAuthRealmUnavailableLive } from '../../api/portal-auth/realm-unavailable.ts';
import { resolveCommerceCustomerContextShellOrigin } from '../../api/runtime-support.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';

class PurchaseReceiverFixtureError extends Schema.TaggedError<PurchaseReceiverFixtureError>()(
  'PurchaseReceiverFixtureError',
  { reason: Schema.String },
) {}

const DiagnosticCauseSchema = Schema.Struct({
  _tag: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Unknown),
  code: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.Unknown),
});
const observeReadFailure = (
  error: typeof DiagnosticCauseSchema.Type,
  stage: 'quantity-read-runtime' | 'quantity-redemption' | 'quantity-verification' = 'quantity-read-runtime',
) =>
  Effect.sync(() => {
    const allowed = [
      'GatewayAssertionRedemptionUnavailableError',
      'GatewayAssertionReplayError',
      'ActionPrincipalConfigurationError',
      'ActionPrincipalUnavailableError',
      'ActionPrincipalExpiredError',
      'ActionPrincipalInvalidError',
      'ActionPrincipalMissingError',
      'ActionPrincipalScopeError',
      'ReadHandlerUnavailable',
      'ReadHandlerExecutionError',
      'ReadScopeResolutionError',
      'ReadPermissionDenied',
      'ReadPermissionUnavailable',
      'ReadEvidencePersistenceError',
      'ReadEvidenceValidationError',
      'ReadResultValidationError',
      'ReadPolicyEvaluationError',
      'ModuleOperationRequirementError',
      'ActiveApplicationCompositionUnavailableError',
      'OperationContextUnavailable',
      'SqlError',
      'ConnectionError',
      'PermissionDenied',
      'receiving-owner-release-not-approved',
      'read_handler_unavailable',
      'read_evidence_persistence_error',
      'operation_context_unavailable',
      'module_operation_requirement_unavailable',
      '42501',
      'The receiving owner release is not approved by the active Application Composition',
      'Current Commerce Quantity policy is temporarily unavailable',
    ];
    const known = new Set<string>();
    let current: unknown = error;
    for (let depth = 0; depth < 8 && Schema.is(DiagnosticCauseSchema)(current); depth += 1) {
      const values = new Set([current._tag, current.code, current.reason]);
      for (const label of allowed) {
        if (values.has(label)) {
          known.add(label);
        }
      }
      current = current.cause ?? current.reason;
    }
    process.stderr.write(`${JSON.stringify({ known: [...known], stage })}\n`);
  });
const observeReadStage = (
  stage:
    | 'READ_RUNTIME_BEGIN'
    | 'READ_RUNTIME_OK'
    | 'READ_RUNTIME_FAIL_UNCLASSIFIED'
    | 'REDEMPTION_CONSUME_BEGIN'
    | 'REDEMPTION_CONSUME_OK'
    | 'REDEMPTION_CONSUME_FAIL_UNCLASSIFIED'
    | 'VERIFY_CREATED'
    | 'VERIFY_BEGIN'
    | 'VERIFY_OK'
    | 'VERIFY_FAIL_UNCLASSIFIED',
) => Effect.sync(() => process.stderr.write(`${stage}\n`));
const observedProductionReadRuntime = Layer.effect(
  ReadRuntime,
  Effect.gen(function* observeProductionReadRuntime() {
    const base = yield* ReadRuntime;
    const runRead: typeof base.runRead = (input) =>
      observeReadStage('READ_RUNTIME_BEGIN').pipe(
        Effect.andThen(() => base.runRead(input)),
        Effect.tap(() => observeReadStage('READ_RUNTIME_OK')),
        Effect.tapError(() => observeReadStage('READ_RUNTIME_FAIL_UNCLASSIFIED')),
        Effect.tapError((failure) =>
          Schema.is(DiagnosticCauseSchema)(failure) ? observeReadFailure(failure) : Effect.void,
        ),
      );
    return { runRead };
  }),
).pipe(Layer.provide(productionReadRuntimeLive));

const observedConfiguredRedemption = Layer.effect(
  GatewayAssertionRedemptionService,
  Effect.gen(function* observeProductionRedemption() {
    const base = yield* GatewayAssertionRedemptionService;
    const consume: typeof base.consume = (input) =>
      observeReadStage('REDEMPTION_CONSUME_BEGIN').pipe(
        Effect.andThen(() => base.consume(input)),
        Effect.tap(() => observeReadStage('REDEMPTION_CONSUME_OK')),
        Effect.tapError(() => observeReadStage('REDEMPTION_CONSUME_FAIL_UNCLASSIFIED')),
        Effect.tapError((failure) =>
          Schema.is(DiagnosticCauseSchema)(failure) ? observeReadFailure(failure, 'quantity-redemption') : Effect.void,
        ),
      );
    return { consume };
  }),
).pipe(Layer.provide(configuredGatewayAssertionRedemptionLive));

const describe = Effect.sync(() => process.stdout.write(`${JSON.stringify(ultramodernApiMarker)}\n`));
const serve = Effect.scoped(
  Effect.gen(function* serveDefaultPurchaseReceiver() {
    const portalConfiguration = yield* optionalCommercePortalAuthConfig;
    if (Option.isSome(portalConfiguration)) {
      return yield* new PurchaseReceiverFixtureError({
        reason: 'This diagnostic fixture requires an absent portal realm',
      });
    }
    const apiRuntime = makeCommerceCustomerContextApiRuntime(
      observedProductionReadRuntime,
      productionActionRuntimeLive,
      observedConfiguredRedemption,
      commercePortalAuthRealmUnavailableLive([resolveCommerceCustomerContextShellOrigin()]),
      Layer.empty,
      DatabaseConfigLive,
      ContextAccessLive,
    );
    // Non-redeeming observation only: the original HTTP request below still executes every genuine gate.
    const verificationContext = yield* Layer.build(
      ActionPrincipalVerifierLive.pipe(
        Layer.provide(
          ActiveApplicationCompositionSourceLive.pipe(
            Layer.provide(
              FetchHttpClient.layer.pipe(
                Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' })),
              ),
            ),
          ),
        ),
      ),
    );
    const verification = bindGatewayPrincipalVerifier('commerce-customer-context', ultramodernApiMarker);
    yield* observeReadStage('VERIFY_CREATED');
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => apiRuntime.createHandler()),
      (handler) => Effect.promise(async () => await handler.dispose()),
    );
    const server = yield* HttpServer.HttpServer;
    yield* server.serve(
      Effect.gen(function* defaultPurchaseReceiverRequest() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const webRequest = yield* HttpServerRequest.toWeb(request);
        const response = yield* Effect.tryPromise({
          catch: () => new PurchaseReceiverFixtureError({ reason: 'The default purchase HTTP adapter failed' }),
          try: async () => await runtime.handler(webRequest),
        }).pipe(Effect.result);
        // Observe only after the original request failed: never warm verification caches before its gates.
        if (Result.isFailure(response) || response.success.status === 503) {
          yield* observeReadStage('VERIFY_BEGIN');
          const verified = yield* verification
            .verify(Redacted.make(webRequest.headers.get('authorization') ?? undefined))
            .pipe(
              Effect.tapError((error) =>
                Schema.is(DiagnosticCauseSchema)(error)
                  ? observeReadFailure(error, 'quantity-verification')
                  : Effect.void,
              ),
              Effect.provideContext(verificationContext),
              Effect.result,
            );
          yield* observeReadStage(Result.isSuccess(verified) ? 'VERIFY_OK' : 'VERIFY_FAIL_UNCLASSIFIED');
        }
        if (Result.isFailure(response)) {
          return yield* Effect.fail(response.failure);
        }
        return HttpServerResponse.fromWeb(response.success);
      }),
    );
    const { address } = server;
    if (!Schema.is(Schema.Struct({ port: Schema.Number }))(address)) {
      return yield* new PurchaseReceiverFixtureError({
        reason: 'The purchase receiver requires a loopback TCP address',
      });
    }
    yield* Effect.sync(() =>
      process.stdout.write(`${JSON.stringify({ marker: ultramodernApiMarker, port: address.port, type: 'ready' })}\n`),
    );
    return yield* Effect.never;
  }),
);
NodeRuntime.runMain(
  process.argv.includes('--describe')
    ? describe.pipe(Effect.provide(NodeServices.layer))
    : serve.pipe(Effect.provide(NodeHttpServer.layerTest)),
);
