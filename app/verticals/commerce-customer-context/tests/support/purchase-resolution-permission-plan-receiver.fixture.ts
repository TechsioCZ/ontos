import { NodeHttpServer, NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, Layer, Option, Schema } from 'effect';
import { ContextAccessLive, DatabaseConfigLive, ReadRuntime } from '@app/core-runtime';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';

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
const observeReadFailure = (error: typeof DiagnosticCauseSchema.Type) =>
  Effect.sync(() => {
    const allowed = [
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
    process.stderr.write(`${JSON.stringify({ known: [...known], stage: 'quantity-read-runtime' })}\n`);
  });
const observedProductionReadRuntime = Layer.effect(
  ReadRuntime,
  Effect.gen(function* observeProductionReadRuntime() {
    const base = yield* ReadRuntime;
    const runRead: typeof base.runRead = (input) =>
      base
        .runRead(input)
        .pipe(
          Effect.tapError((failure) =>
            Schema.is(DiagnosticCauseSchema)(failure) ? observeReadFailure(failure) : Effect.void,
          ),
        );
    return { runRead };
  }),
).pipe(Layer.provide(productionReadRuntimeLive));

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
      configuredGatewayAssertionRedemptionLive,
      commercePortalAuthRealmUnavailableLive([resolveCommerceCustomerContextShellOrigin()]),
      Layer.empty,
      DatabaseConfigLive,
      ContextAccessLive,
    );
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
        });
        return HttpServerResponse.fromWeb(response);
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
