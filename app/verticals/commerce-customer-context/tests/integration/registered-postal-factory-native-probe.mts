/** Real redemption and scope admission do not authorize factory-only provider access without Core execution. */
import { staffAuthenticationNamespaceRegistryLayer } from '@app/core-runtime/auth/staff-authentication-namespace';
import { ModuleOperationRequirementError, GatewayAssertionRedemptionService } from '@app/core-runtime';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { ActiveApplicationCompositionConfigLive } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { withVerifiedNativeReadScope } from '@app/core-runtime/testing/native-reads';
import { getReadServiceFactory } from '@app/core-runtime/testing/reads';
import { bindGatewayPrincipalVerifier } from '@app/gateway-principal-verifier/server';
import { NodeHttpClient, NodeRuntime, NodeServices, NodeSink, NodeStream } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Config, Context, Effect, Layer, Logger, Result, Schema, Stream } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { FetchHttpClient } from 'effect/http';

import { AddressBookUnavailable } from '../../shared/domain/address-errors.ts';
import { SavedAddressSchema } from '../../shared/domain/address-book.ts';
import { deliveryDestinationResolutionRead } from '../../src/api/delivery-destination-resolution.read.ts';
import { invoiceRecipientResolutionRead } from '../../src/api/invoice-recipient-resolution.read.ts';
import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive,
} from '../../src/auth/gateway-assertion-redemption-runtime.ts';

class PostalFactoryProbeFailure extends Schema.TaggedError<PostalFactoryProbeFailure>()('PostalFactoryProbeFailure', {
  stage: Schema.Literals(['input', 'redemption', 'admitted_factory', 'output', 'execution']),
}) {}

const ProbeCorrelationIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('PostalFactoryProbeCorrelationId'),
);

const InputSchema = Schema.Struct({
  authorization: Schema.RedactedFromValue(Schema.String),
  compositionRevision: Schema.String,
  correlationId: ProbeCorrelationIdSchema,
  deployment: Schema.Struct({
    appId: Schema.Literal('commerce-customer-context'),
    buildMarker: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  }),
  factory: Schema.Literals(['delivery', 'invoice']),
  savedAddress: SavedAddressSchema,
});

const readInput = NodeStream.fromReadable({
  evaluate: () => process.stdin,
  onError: () => new PostalFactoryProbeFailure({ stage: 'input' }),
}).pipe(
  Stream.decodeText(),
  Stream.mkString,
  Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(InputSchema))),
  Effect.catchCause(() => Effect.fail(new PostalFactoryProbeFailure({ stage: 'input' }))),
);

const PostalFactoryPhaseSchema = Schema.Literals([
  'redemption_started',
  'redemption_completed',
  'scope_admission_started',
  'scope_admitted',
  'factory_ready',
  'requirement_rejected',
  'scope_completed',
]);

const reportPhase = Effect.fn('RegisteredPostalFactoryProbe.reportPhase')(function* reportPostalFactoryPhase(
  phase: typeof PostalFactoryPhaseSchema.Type,
) {
  yield* Stream.make(`ONTOS_POSTAL_FACTORY_PHASE ${phase}\n`).pipe(
    Stream.encodeText,
    Stream.run(
      NodeSink.fromWritable({
        endOnDone: false,
        evaluate: () => process.stdout,
        onError: () => new PostalFactoryProbeFailure({ stage: 'output' }),
      }),
    ),
  );
});

const probe = Effect.fn('RegisteredPostalFactoryProbe.run')(function* runProbe(input: typeof InputSchema.Type) {
  yield* reportPhase('redemption_started');
  const client = yield* PgClient.make({ url: yield* Config.Redacted('DATABASE_URL') });
  const redemptionContext = yield* Layer.build(
    GatewayAssertionRedemptionLive.pipe(
      Layer.provide(GatewayAssertionRedemptionDatabaseLive),
      Layer.provide(Layer.succeed(PgClient.PgClient, client)),
    ),
  );
  const redemption = Context.get(redemptionContext, GatewayAssertionRedemptionService);
  const principal = yield* bindGatewayPrincipalVerifier(input.deployment.appId, input.deployment)
    .verifyAndRedeem(input.authorization, {
      environment: {
        ONTOS_GATEWAY_ISSUER: yield* Config.String('ONTOS_GATEWAY_ISSUER'),
        ONTOS_GATEWAY_PUBLIC_JWKS: yield* Config.String('ONTOS_GATEWAY_PUBLIC_JWKS'),
      },
      redemption,
    })
    .pipe(Effect.catchCause(() => Effect.fail(new PostalFactoryProbeFailure({ stage: 'redemption' }))));
  yield* reportPhase('redemption_completed');
  const entrypoint =
    input.factory === 'delivery'
      ? deliveryDestinationResolutionRead.descriptor.entrypoint
      : invoiceRecipientResolutionRead.descriptor.entrypoint;
  const factory =
    input.factory === 'delivery'
      ? getReadServiceFactory(deliveryDestinationResolutionRead)
      : getReadServiceFactory(invoiceRecipientResolutionRead);
  yield* reportPhase('scope_admission_started');
  const resolved = yield* withVerifiedNativeReadScope(
    { audience: input.deployment.appId, correlationId: input.correlationId, entrypoint, principal },
    Effect.fn('RegisteredPostalFactoryProbe.resolve')(function* resolveRegisteredPostal(
      transaction: ScopedTransactionExecutor,
      scope: OperationalScope,
      revision: string,
    ) {
      if (
        revision !== input.compositionRevision ||
        scope.trustedStorefrontId !== undefined ||
        scope.principalId !== principal.principalId ||
        scope.tenantId !== principal.tenantId ||
        scope.legalEntityId !== principal.legalEntityId
      ) {
        return yield* new PostalFactoryProbeFailure({ stage: 'admitted_factory' });
      }
      yield* reportPhase('scope_admitted');
      // The exact production-resolved carrier reaches the original registered factory unchanged.
      const services = yield* factory(transaction, scope, revision);
      yield* reportPhase('factory_ready');
      const result = yield* Effect.result(services.resolvePostalAddress(input.savedAddress));
      // This is a specific product rejection, not permission/catalog/network failure or a
      // successful postal read. The original typed Core cause stays inside this process.
      const requirementFailure = Schema.Struct({ cause: ModuleOperationRequirementError });
      if (
        Result.isSuccess(result) ||
        !Schema.is(AddressBookUnavailable)(result.failure) ||
        !Schema.is(requirementFailure)(result.failure) ||
        result.failure.cause.code !== 'module_operation_requirement_unavailable'
      ) {
        return yield* new PostalFactoryProbeFailure({ stage: 'admitted_factory' });
      }
      yield* reportPhase('requirement_rejected');
      return {
        compositionRevision: revision,
        factory: input.factory,
        outcome: 'FACTORY_ONLY_EXECUTION_REJECTED' as const,
        requirementCode: result.failure.cause.code,
      };
    }),
  ).pipe(Effect.catchCause(() => Effect.fail(new PostalFactoryProbeFailure({ stage: 'admitted_factory' }))));
  yield* reportPhase('scope_completed');
  yield* Stream.make(`ONTOS_POSTAL_FACTORY_RESULT ${JSON.stringify(resolved)}\n`).pipe(
    Stream.encodeText,
    Stream.run(
      NodeSink.fromWritable({
        endOnDone: false,
        evaluate: () => process.stdout,
        onError: () => new PostalFactoryProbeFailure({ stage: 'output' }),
      }),
    ),
  );
});

const failProtocol = (stage: PostalFactoryProbeFailure['stage']) =>
  Stream.make(`ONTOS_POSTAL_FACTORY_FAILURE ${JSON.stringify({ stage })}\n`).pipe(
    Stream.encodeText,
    Stream.run(
      NodeSink.fromWritable({
        endOnDone: false,
        evaluate: () => process.stdout,
        onError: () => new PostalFactoryProbeFailure({ stage: 'output' }),
      }),
    ),
    Effect.andThen(
      Effect.sync(() => {
        process.exitCode = 1;
      }),
    ),
    Effect.catchCause(() =>
      Effect.sync(() => {
        process.exitCode = 1;
      }),
    ),
  );

const compositionHttpClientLive = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' })),
);
const activeCompositionLive = ActiveApplicationCompositionConfigLive.pipe(
  Layer.provide(ActiveApplicationCompositionSourceLive.pipe(Layer.provide(compositionHttpClientLive))),
);

// Decode before live layers. Every failed path emits only a closed protocol tag, never its cause.
NodeRuntime.runMain(
  readInput.pipe(
    Effect.flatMap((input) =>
      Effect.scoped(probe(input)).pipe(
        Effect.provide(activeCompositionLive),
        Effect.provide(staffAuthenticationNamespaceRegistryLayer(['commerce-customer-context'])),
        Effect.provide(Reactivity.layer),
        Effect.provide(NodeHttpClient.layerUndici),
        Effect.provide(NodeServices.layer),
      ),
    ),
    Effect.catchTag('PostalFactoryProbeFailure', (failure) => failProtocol(failure.stage)),
    Effect.catchCause(() => failProtocol('execution')),
    Effect.provide(Logger.layer([])),
  ),
);
