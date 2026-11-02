// @effect-diagnostics nodeBuiltinImport:off -- Native proof bootstrap child reads its private config file before any Effect layer exists; expires: 2027-03-31.
import { readFileSync, writeSync } from 'node:fs';
import {
  ActionRuntime,
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfig,
  GatewayAssertionRedemptionService,
  TenantModuleStateServiceLive,
  defineDatabaseIdentityEnrollment,
  makeActionRuntimeLive,
  makeDatabaseIdentityEnrollmentLive,
  parseDatabaseConfig,
} from '@app/core-runtime';
import {
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { ActiveApplicationCompositionService } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { bindGatewayPrincipalVerifier } from '@app/gateway-principal-verifier/server';
import { NodeCrypto, NodeRuntime, NodeServices } from '@effect/platform-node';
import { Cause, Effect, Layer, Logger, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { ActionPrincipalVerifierLive } from '../../api/auth/action-principal.ts';
import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive,
} from '../../api/auth/gateway-assertion-redemption.ts';
import { ultramodernApiMarker, ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import { registerStorefrontApplicationAction } from '../../src/actions/register-storefront-application.action.ts';
import {
  RegisterStorefrontApplicationPayloadSchema,
  RegisterStorefrontApplicationResultSchema,
} from '../../shared/actions/register-storefront-application.ts';

const bounded = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const requestContext = {
  authorization: Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_000))),
  compositionRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  correlationId: bounded,
  databaseName: Schema.String.check(Schema.isPattern(/^ontos_test_[a-z0-9_]+$/u)),
  idempotencyKey: bounded,
  runtimeConnectionString: Schema.RedactedFromValue(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
  ),
};
const RequestSchema = Schema.Struct({
  ...requestContext,
  operation: Schema.Literal('REGISTER_STOREFRONT'),
  parameters: Schema.toEncoded(RegisterStorefrontApplicationPayloadSchema),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
class OwnerProducerUnavailable extends Schema.TaggedError<OwnerProducerUnavailable>()('OwnerProducerUnavailable', {
  reason: Schema.String,
}) {}
const unavailable = () => new OwnerProducerUnavailable({ reason: 'The isolated owner producer failed' });

/** Real owner Actions only: verification, one-shot redemption, Core grants and transactional audit remain mandatory. */
const main = Effect.scoped(
  Effect.gen(function* runOwnerProducerChild() {
    const request = yield* Effect.sync(() => readFileSync(0, 'utf-8')).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(RequestSchema))),
    );
    const configuration = yield* parseDatabaseConfig({ DATABASE_URL: Redacted.value(request.runtimeConnectionString) });
    if (
      !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(configuration.host) ||
      configuration.database !== request.databaseName ||
      configuration.user !== 'ontos_runtime'
    ) {
      return yield* unavailable();
    }
    const database = Layer.succeed(DatabaseConfig, configuration);
    const persistence = CorePersistenceLive.pipe(Layer.provide(database));
    const states = TenantModuleStateServiceLive.pipe(Layer.provide(persistence));
    const gate = ModuleStateGateLive.pipe(Layer.provide(states));
    const gateway = ModuleEntrypointGatewayLive.pipe(Layer.provide(gate));
    const scopes = OperationalScopeResolverLive.pipe(Layer.provide(Layer.mergeAll(persistence, ContextAccessLive)));
    const actions = makeActionRuntimeLive(ultramodernDeliveryUnit).pipe(
      Layer.provide(
        Layer.mergeAll(ActionRepositoryLive, ActionPermissionLive, gate, gateway, scopes, ContextAccessLive),
      ),
      Layer.provide(persistence),
      Layer.provide(ActionPrincipalVerifierLive),
    );
    const live = Layer.mergeAll(
      actions,
      ActionPrincipalVerifierLive,
      GatewayAssertionRedemptionLive.pipe(Layer.provide(GatewayAssertionRedemptionDatabaseLive)),
    ).pipe(
      Layer.provide(database),
      Layer.provide(
        ActiveApplicationCompositionSourceLive.pipe(
          Layer.provide(
            FetchHttpClient.layer.pipe(
              Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' })),
            ),
          ),
        ),
      ),
      Layer.provide(NodeCrypto.layer),
      Layer.provide(makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([]))),
    );
    const context = yield* Layer.build(live);
    const line = yield* Effect.gen(function* invokeActualOwnerAction() {
      const composition = yield* ActiveApplicationCompositionService;
      const snapshot = yield* composition.load;
      if (snapshot.composition.revision !== request.compositionRevision) {
        return yield* unavailable();
      }
      const redemption = yield* GatewayAssertionRedemptionService;
      const principal = yield* bindGatewayPrincipalVerifier(
        'storefront-registry',
        ultramodernApiMarker,
      ).verifyAndRedeem(request.authorization, { redemption });
      const runtime = yield* ActionRuntime;
      const transport = {
        correlationId: request.correlationId,
        idempotencyKey: request.idempotencyKey,
        targetModuleKey: 'commerce.storefront-registry',
      };
      const result = yield* runtime.runAction({
        audience: 'storefront-registry',
        payload: request.parameters,
        principal,
        registration: registerStorefrontApplicationAction,
        transport,
      });
      return yield* Schema.encodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            operation: Schema.Literal('REGISTER_STOREFRONT'),
            result: RegisterStorefrontApplicationResultSchema,
          }),
        ),
      )({ operation: request.operation, result });
    }).pipe(Effect.provideContext(context));
    // Secret-bearing input and all child output use dedicated private parent IPC, never logs/stdout.
    yield* Effect.sync(() => writeSync(3, `${line}\n`));
    return yield* Effect.void;
  }),
).pipe(
  Effect.tapCause((cause) =>
    Effect.sync(() =>
      process.stderr.write(
        `owner-producer-cause: ${Cause.pretty(cause)
          .replaceAll(/(?<scheme>\w+:\/\/)[^\s/@]+:[^\s/@]+@/gu, '$<scheme>[REDACTED]@')
          .replaceAll(/eyJ[\w-]+\.[\w-]+\.[\w-]+/gu, '[REDACTED]')
          .replaceAll(/(?<field>Bearer\s+)\S+/gu, '$<field>[REDACTED]')
          .slice(0, 6144)}\n`,
      ),
    ),
  ),
  Effect.mapError(unavailable),
);
NodeRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* runOwnerProducer() {
      const services = yield* Layer.build(Layer.mergeAll(NodeServices.layer, Logger.layer([])));
      return yield* main.pipe(Effect.provideContext(services));
    }),
  ),
  { disableErrorReporting: true },
);
