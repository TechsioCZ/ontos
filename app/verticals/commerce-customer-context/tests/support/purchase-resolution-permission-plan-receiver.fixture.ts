import { NodeHttpServer, NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, Layer, Option, Redacted, Result, Schema } from 'effect';
import {
  ActiveApplicationCompositionService,
  ContextAccessLive,
  DatabaseConfigLive,
  ReadRuntime,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import { GatewayAssertionRedemptionService } from '@app/core-runtime/auth/gateway-assertion-redemption';
import { FetchHttpClient, HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import {
  bindGatewayPrincipalVerifier,
  GatewayPrincipalVerifierConfiguration,
} from '@app/gateway-principal-verifier/server';
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
  issue: Schema.optionalKey(Schema.Unknown),
  issues: Schema.optionalKey(Schema.Unknown),
  path: Schema.optionalKey(Schema.Unknown),
  reason: Schema.optionalKey(Schema.Unknown),
});
const observeReadFailure = (
  error: typeof DiagnosticCauseSchema.Type,
  stage:
    | 'quantity-read-runtime'
    | 'quantity-redemption'
    | 'quantity-verification'
    | 'quantity-source' = 'quantity-read-runtime',
) =>
  Effect.sync(() => {
    const allowed = [
      'SchemaError',
      'ApplicationCompositionValidationError',
      'ActiveApplicationCompositionSourceReadError',
      'application_composition_invalid',
      'active_application_composition_unavailable',
      'Application Composition authority is expired or not yet valid',
      'The active Application Composition snapshot is unavailable or invalid',
      'Application Composition snapshot exceeds its byte budget',
      'The ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL configuration is required',
      'The active Application Composition source URL is invalid',
      'The active Application Composition source read-token configuration is invalid',
      'The active Application Composition source read failed',
      'The active Application Composition source body read failed',
      'The active Application Composition snapshot is not UTF-8 text',
      'The active Application Composition snapshot has no valid authority deadline',
      'The active Application Composition source read timed out',
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
    const safeFields = new Set([
      'composition',
      'observedAt',
      'validUntil',
      'modules',
      'shell',
      'schemaVersion',
      'deployment',
      'appId',
      'buildMarker',
      'contractDocument',
      'manifest',
      'publicSurface',
      'operationContracts',
      'requirements',
      'intrinsic',
      'coreCapabilities',
      'api',
      'actions',
      'components',
      'runtime',
      'outboxSubscriptions',
      'exposes',
      'federation',
      'sharedSingletons',
      'contributionAbi',
    ]);
    const known = new Set<string>();
    let current: unknown = error;
    for (let depth = 0; depth < 8 && Schema.is(DiagnosticCauseSchema)(current); depth += 1) {
      const values = new Set([current._tag, current.code, current.reason]);
      for (const label of allowed) {
        if (values.has(label)) {
          known.add(label);
        }
      }
      if (Schema.is(Schema.Array(Schema.Union([Schema.String, Schema.Number])))(current.path)) {
        for (const field of current.path) {
          if (Schema.is(Schema.String)(field) && safeFields.has(field)) {
            known.add(`schema.field.${field}`);
          }
        }
      }
      const issues = Schema.is(Schema.Array(Schema.Unknown))(current.issues) ? current.issues : [];
      current = current.cause ?? current.issue ?? issues[0] ?? current.reason;
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
    | 'VERIFY_FAIL_UNCLASSIFIED'
    | 'SOURCE_LOAD_BEGIN'
    | 'SOURCE_LOAD_OK'
    | 'SOURCE_LOAD_FAIL'
    | 'CONFIG_LOAD_OK'
    | 'CONFIG_LOAD_FAIL',
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
          const configuration = yield* GatewayPrincipalVerifierConfiguration.pipe(
            Effect.flatMap((service) => service.configuration),
            Effect.asVoid,
            Effect.provideContext(verificationContext),
            Effect.result,
          );
          yield* observeReadStage(Result.isSuccess(configuration) ? 'CONFIG_LOAD_OK' : 'CONFIG_LOAD_FAIL');
          yield* observeReadStage('SOURCE_LOAD_BEGIN');
          const loaded = yield* ActiveApplicationCompositionService.pipe(
            Effect.flatMap((service) => service.load),
            Effect.flatMap(validateActiveApplicationCompositionSnapshot),
            Effect.asVoid,
            Effect.tapError((error) =>
              Schema.is(DiagnosticCauseSchema)(error) ? observeReadFailure(error, 'quantity-source') : Effect.void,
            ),
            Effect.provideContext(verificationContext),
            Effect.result,
          );
          yield* observeReadStage(Result.isSuccess(loaded) ? 'SOURCE_LOAD_OK' : 'SOURCE_LOAD_FAIL');
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
