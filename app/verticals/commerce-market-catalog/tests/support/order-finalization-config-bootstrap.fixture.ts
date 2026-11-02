import { readFileSync, writeSync } from 'node:fs';
import {
  ActionRuntime,
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfig,
  GatewayAssertionRedemptionService,
  TenantModuleStateServiceLive,
  makeActionRuntimeLive,
  parseDatabaseConfig,
  defineDatabaseIdentityEnrollment,
  makeDatabaseIdentityEnrollmentLive,
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
import { createMarketAction } from '../../src/actions/create-market.action.ts';
import { associateStorefrontAction } from '../../src/actions/associate-storefront.action.ts';
import {
  CreateMarketPayloadSchema,
  CreateMarketResultSchema,
  AssociateStorefrontPayloadSchema,
  StorefrontAssociationResultSchema,
} from '../../shared/action-contracts.ts';

const OWNER_AUDIENCE = 'commerce-market-catalog';
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
const RequestSchema = Schema.Union([
  Schema.Struct({
    ...requestContext,
    operation: Schema.Literal('CREATE_MARKET'),
    parameters: Schema.toEncoded(CreateMarketPayloadSchema),
  }),
  Schema.Struct({
    ...requestContext,
    operation: Schema.Literal('ASSOCIATE_STOREFRONT'),
    parameters: Schema.toEncoded(AssociateStorefrontPayloadSchema),
  }),
]).annotate({ parseOptions: { onExcessProperty: 'error' } });
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
      yield* unavailable();
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
      const principal = yield* bindGatewayPrincipalVerifier(OWNER_AUDIENCE, ultramodernApiMarker).verifyAndRedeem(
        request.authorization,
        { redemption },
      );
      const runtime = yield* ActionRuntime;
      const transport = {
        correlationId: request.correlationId,
        idempotencyKey: request.idempotencyKey,
        targetModuleKey: 'commerce.market-catalog',
      };
      if (request.operation === 'CREATE_MARKET') {
        const result = yield* runtime.runAction({
          audience: OWNER_AUDIENCE,
          payload: request.parameters,
          principal,
          registration: createMarketAction,
          transport,
        });
        return yield* Schema.encodeEffect(
          Schema.fromJsonString(
            Schema.Struct({ operation: Schema.Literal('CREATE_MARKET'), result: CreateMarketResultSchema }),
          ),
        )({ operation: request.operation, result });
      }
      const result = yield* runtime.runAction({
        audience: OWNER_AUDIENCE,
        payload: request.parameters,
        principal,
        registration: associateStorefrontAction,
        transport,
      });
      return yield* Schema.encodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            operation: Schema.Literal('ASSOCIATE_STOREFRONT'),
            result: StorefrontAssociationResultSchema,
          }),
        ),
      )({ operation: request.operation, result });
    }).pipe(Effect.provideContext(context));
    // Secret-bearing input and all child output use dedicated private parent IPC, never logs/stdout.
    yield* Effect.sync(() => writeSync(3, `${line}\n`));
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
NodeRuntime.runMain(main.pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, Logger.layer([])))), {
  disableErrorReporting: true,
});
