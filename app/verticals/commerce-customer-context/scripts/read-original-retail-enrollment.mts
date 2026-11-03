#!/usr/bin/env node
// Approved operator/infrastructure exception. No HTTP registration or provider capability.
import {
  ActionAuthorizationPreflightDatabaseLive,
  ActionRuntime,
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfigLive,
  GatewayAssertionRedemptionService,
  TenantModuleStateServiceLive,
  defineDatabaseIdentityEnrollment,
  makeActionRuntimeLive,
  makeDatabaseIdentityEnrollmentLive,
} from '@app/core-runtime';
import {
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import {
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionService,
} from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { GatewayPrincipalVerifierLive, bindGatewayPrincipalVerifier } from '@app/gateway-principal-verifier/server';
import { NodeCrypto, NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Cause, Config, Console, Effect, FileSystem, Layer, Logger, Option, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { FetchHttpClient } from 'effect/http';
import { Command, Flag } from 'effect/cli';
import { EnrollmentAttemptIdSchema } from '../shared/enrollment-contracts.ts';

import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive,
  gatewayAssertionRedemptionPgClient,
} from '../api/auth/gateway-assertion-redemption.ts';
import { CommerceAuthenticationNamespaceRegistryLive } from '../api/portal-auth/authentication-namespace-registry.ts';
import {
  OriginalEnrollmentDiagnosticError,
  OriginalEnrollmentReceiptRead,
  OriginalEnrollmentRequestSchema,
  readOriginalEnrollmentRequest,
} from '../src/enrollment/attempts/original-request-diagnostic.ts';
import { CommerceEnrollmentOwnerTransactionRunnerLive } from '../src/enrollment/orchestration/owner-transaction-runner.ts';

const unavailable = () => new OriginalEnrollmentDiagnosticError({ code: 'ORIGINAL_REQUEST_DIAGNOSTIC_UNAVAILABLE' });
const privateInputSchema = Schema.Struct({
  compositionRevision: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  gatewayAssertion: Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(1))),
  request: OriginalEnrollmentRequestSchema,
});
const audience = 'commerce-customer-context';
const composition = ActiveApplicationCompositionConfigLive.pipe(
  Layer.provide(ActiveApplicationCompositionSourceLive.pipe(Layer.provide(FetchHttpClient.layer))),
);
const state = TenantModuleStateServiceLive.pipe(Layer.provide(CorePersistenceLive));
const gate = ModuleStateGateLive.pipe(Layer.provide(state));
const core = Layer.mergeAll(CorePersistenceLive, ContextAccessLive);
const runtime = Layer.unwrap(
  Effect.gen(function* originalRequestRuntime() {
    const snapshot = yield* (yield* ActiveApplicationCompositionService).load;
    const owner = snapshot.composition.modules.find((module) => module.deployment.appId === audience);
    if (owner === undefined) {
      return yield* unavailable();
    }
    return makeActionRuntimeLive(owner.deployment).pipe(
      Layer.provide(
        Layer.mergeAll(
          core,
          gate,
          ModuleEntrypointGatewayLive.pipe(Layer.provide(gate)),
          OperationalScopeResolverLive.pipe(Layer.provide(core)),
          ActionRepositoryLive,
          ActionPermissionLive,
        ),
      ),
    );
  }),
).pipe(Layer.provide(composition));
const receiptRead = Layer.effect(
  OriginalEnrollmentReceiptRead,
  Effect.gen(function* originalReceiptRead() {
    const service = yield* ActionRuntime;
    return { resolveActionExecution: service.resolveActionExecution };
  }),
).pipe(Layer.provide(runtime));
const runner = CommerceEnrollmentOwnerTransactionRunnerLive.pipe(
  Layer.provide(ActionAuthorizationPreflightDatabaseLive.pipe(Layer.provide(CorePersistenceLive))),
);
const redemption = GatewayAssertionRedemptionLive.pipe(
  Layer.provide(
    GatewayAssertionRedemptionDatabaseLive.pipe(
      Layer.provide(PgClient.layerFrom(gatewayAssertionRedemptionPgClient)),
      Layer.provide(Reactivity.layer),
      Layer.provide(DatabaseConfigLive),
    ),
  ),
);
const live = Layer.mergeAll(
  receiptRead,
  runner,
  redemption,
  composition,
  GatewayPrincipalVerifierLive,
  CommerceAuthenticationNamespaceRegistryLive,
).pipe(
  Layer.provide(DatabaseConfigLive),
  Layer.provide(makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([]))),
  Layer.provide(NodeCrypto.layer),
  Layer.provide(NodeServices.layer),
  Layer.provide(FetchHttpClient.layer),
);

const successSchema = Schema.Struct({ portalEnrollmentAttemptId: EnrollmentAttemptIdSchema });
const failureSchema = Schema.Struct({ code: OriginalEnrollmentDiagnosticError.fields.code });
const operator = Command.make(
  'read-original-retail-enrollment',
  { inputStdin: Flag.Boolean('input-stdin') },
  ({ inputStdin }) =>
    Effect.gen(function* readPrivateOperatorInput() {
      const envPath = yield* Config.String('APP_ENV_PATH').pipe(Effect.mapError(unavailable));
      if (!inputStdin || envPath !== '/dev/null') {
        return yield* unavailable();
      }
      const fs = yield* FileSystem.FileSystem;
      const encoded = yield* fs.readFileString('/dev/stdin').pipe(Effect.mapError(unavailable));
      const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(privateInputSchema), {
        onExcessProperty: 'error',
      })(encoded).pipe(Effect.catchTag('SchemaError', () => Effect.fail(unavailable())));
      const read = Effect.gen(function* authenticateAndReadOriginalRequest() {
        const snapshot = yield* (yield* ActiveApplicationCompositionService).load;
        const owner = snapshot.composition.modules.find((module) => module.deployment.appId === audience);
        if (owner === undefined || snapshot.composition.revision !== input.compositionRevision) {
          return yield* unavailable();
        }
        const principal = yield* bindGatewayPrincipalVerifier(audience, owner.deployment)
          .verifyAndRedeem(Redacted.make(`Bearer ${Redacted.value(input.gatewayAssertion)}`), {
            redemption: yield* GatewayAssertionRedemptionService,
          })
          .pipe(Effect.mapError(unavailable));
        return yield* readOriginalEnrollmentRequest(input.request, principal);
      });
      return yield* Layer.build(
        Layer.effectDiscard(
          read.pipe(
            Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(successSchema))),
            Effect.flatMap(Console.log),
          ),
        ).pipe(Layer.provide(live)),
      );
    }),
);

if (import.meta.main) {
  const program = Command.run(operator, { version: '1.0.0' }).pipe(
    Effect.timeout('60 seconds'),
    Effect.catchCause((cause) => {
      const observed = Cause.findErrorOption(cause);
      const failure =
        Option.isSome(observed) && Schema.is(OriginalEnrollmentDiagnosticError)(observed.value)
          ? observed.value
          : unavailable();
      return Schema.encodeEffect(Schema.fromJsonString(failureSchema))({ code: failure.code }).pipe(
        Effect.flatMap(Console.log),
        Effect.andThen(Effect.fail(failure)),
      );
    }),
    Effect.scoped,
  );
  const entrypoint = Layer.effectDiscard(program).pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, Logger.layer([]))),
  );
  NodeRuntime.runMain(Effect.scoped(Layer.build(entrypoint)), {
    disableErrorReporting: true,
  });
}
