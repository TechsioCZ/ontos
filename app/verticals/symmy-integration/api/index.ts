import type {
  ActionAuthorizationPreflightInput,
  ActionAuthorizationPreflightService,
  ActionRuntimeService,
} from '@app/core-runtime';
import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import { isSymmyCustomerIntakeRoute } from '../shared/domain/symmy-job-identities.ts';
import { AdmitSymmyJobPayloadSchema } from '../shared/domain/symmy-job-admission.ts';
import { admitSymmyJobAction } from '../src/actions/admit-symmy-job.action.ts';
import { symmyJobOperationFactory } from '../src/auth/symmy-job-operation-factory.ts';
import { SymmyJobStoreError } from '../src/persistence/symmy-job-store.ts';
import {
  prepareSymmyCustomerIntakePrivacy,
  SymmyPreparedCustomerIntake,
  customerIntakePreparationMatches,
} from '../src/services/symmy-customer-intake-privacy.ts';
import type { SymmyCustomerIntakePreparation } from '../src/services/symmy-customer-intake-privacy.ts';
import { ModuleCallRouteLive } from '@app/shared-contracts/server/sdk-module-call-route';
import { SymmyCatalogPricingInventoryAdaptersLive } from '../src/services/symmy-catalog-pricing-inventory-adapters.ts';
import { SymmyPolicyFixtureAdaptersLive } from '../src/services/symmy-policy-fixture-adapters.ts';
import { SymmyPartyCommerceAdaptersLive } from '../src/services/symmy-party-commerce-adapters.ts';
import {
  ActionAuthorizationPreflight,
  ActionAuthorizationPreflightDatabase,
  ActionPermissionCheckError,
  ActionRuntime,
  makeActionAuthorizationPreflightPermit,
  ActionAuthorizationPreflightDatabaseLive,
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfig,
  DatabaseConfigLive,
  TenantModuleStateServiceLive,
  makeActionRuntimeLive,
  makeReadRuntimeLive,
} from '@app/core-runtime';
import {
  AccessDecisionLive,
  AccessEnforcementPortsLive,
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
  TenantIntentLoaderLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { ActiveApplicationCompositionConfigLive as GovernedApplicationCompositionConfigLive } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive as GovernedApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import { PgClient } from '@effect/sql-pg';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import {
  Context,
  Effect,
  Layer,
  Layer as GovernedReadLayer,
  Logger,
  Option,
  Redacted,
  Ref,
  References,
  Result,
  Schema,
  Tracer,
} from 'effect';
import { SecureRandom } from 'effect/crypto';
import { FetchHttpClient } from 'effect/http';
import { Reactivity } from 'effect/reactivity';

import { symmyIntegrationApi, symmyIntegrationOperationContexts } from '../shared/api.ts';
import { ultramodernApiMarker, ultramodernDeliveryUnit } from '../shared/ultramodern-build.ts';
import { symmyIntegrationRegistration } from '../vertical.registration.ts';
import { SymmyJobPrivacyLive } from '../src/services/symmy-job-privacy.service.ts';
// <generated-governed-http-handler-support-imports>
import { ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive } from './auth/action-principal.ts';
import {
  gatewayAssertionRedemptionPgClient,
  GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive,
} from './auth/gateway-assertion-redemption.ts';
// </generated-governed-http-handler-support-imports>
// <generated-governed-http-handler-imports>
import { admitSymmyJobActionApiLive } from './admit-symmy-job-action-server.ts';
import { admitSymmySyncActionApiLive } from './admit-symmy-sync-action-server.ts';
import { executeSymmyRetentionActionApiLive } from './execute-symmy-retention-action-server.ts';
import { symmyJobPrivacyExecutionReadApiLive } from './symmy-job-privacy-execution-read-server.ts';
import { symmyJobStatusReadApiLive } from './symmy-job-status-read-server.ts';
import { symmyRouteContextReadApiLive } from './symmy-route-context-read-server.ts';
import { symmySourceOrganizationFactsReadApiLive } from './symmy-source-organization-facts-read-server.ts';
import { symmySyncAdmissionReadApiLive } from './symmy-sync-admission-read-server.ts';
// </generated-governed-http-handler-imports>

const governedModuleStateGateLive = ModuleStateGateLive.pipe(
  GovernedReadLayer.provide(TenantModuleStateServiceLive.pipe(GovernedReadLayer.provide(CorePersistenceLive))),
);
const governedAccessEnforcementLive = AccessDecisionLive.pipe(
  GovernedReadLayer.provideMerge(AccessEnforcementPortsLive),
  GovernedReadLayer.provide(TenantIntentLoaderLive),
  GovernedReadLayer.provide(CorePersistenceLive),
  GovernedReadLayer.provide(DatabaseConfigLive),
  GovernedReadLayer.provide(nodeCryptoLayer),
);
const governedReadRuntimeDependenciesLive = GovernedReadLayer.mergeAll(
  CorePersistenceLive,
  ContextAccessLive,
  ModuleEntrypointGatewayLive.pipe(GovernedReadLayer.provide(governedModuleStateGateLive)),
  OperationalScopeResolverLive.pipe(
    GovernedReadLayer.provide(
      GovernedReadLayer.mergeAll(CorePersistenceLive, ContextAccessLive, governedAccessEnforcementLive),
    ),
  ),
  governedAccessEnforcementLive,
);

const governedApplicationCompositionSourceLive = GovernedApplicationCompositionSourceLive.pipe(
  GovernedReadLayer.provide(
    FetchHttpClient.layer.pipe(
      GovernedReadLayer.provide(
        GovernedReadLayer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' }),
      ),
    ),
  ),
);
const governedActiveApplicationCompositionLive = GovernedApplicationCompositionConfigLive.pipe(
  GovernedReadLayer.provide(governedApplicationCompositionSourceLive),
);
/** The module route's fetch client: no cache, no redirect, so the delegated credential reaches only the named provider. */
const moduleCallHttpClientLive = FetchHttpClient.layer.pipe(
  GovernedReadLayer.provide(
    GovernedReadLayer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' }),
  ),
);
const governedReadRuntimeLive = makeReadRuntimeLive(ultramodernDeliveryUnit, symmyIntegrationRegistration).pipe(
  GovernedReadLayer.provide(governedReadRuntimeDependenciesLive),
  GovernedReadLayer.provide(governedActiveApplicationCompositionLive),
  GovernedReadLayer.provide(
    ModuleCallRouteLive.pipe(
      GovernedReadLayer.provide(GovernedReadLayer.mergeAll(nodeCryptoLayer, moduleCallHttpClientLive)),
    ),
  ),
);
const governedActionRuntimeCoreLive = makeActionRuntimeLive(ultramodernDeliveryUnit, symmyIntegrationRegistration).pipe(
  GovernedReadLayer.provide(
    GovernedReadLayer.mergeAll(
      governedReadRuntimeDependenciesLive,
      governedModuleStateGateLive,
      ActionRepositoryLive,
      ActionPermissionLive,
      ActionAuthorizationPreflightDatabaseLive.pipe(GovernedReadLayer.provideMerge(CorePersistenceLive)),
      governedActiveApplicationCompositionLive,
    ),
  ),
);

type IntakePreparationState = Ref.Ref<Result.Result<SymmyCustomerIntakePreparation, SymmyJobStoreError>>;
const intakeUnavailable = (cause?: unknown) => {
  const error = new SymmyJobStoreError({ code: 'unavailable' });
  return cause === undefined ? error : Object.defineProperty(error, 'cause', { value: Redacted.make(cause) });
};
const intakeDenied = () => new SymmyJobStoreError({ code: 'route_denied' });
const prepareCustomerIntake = Effect.fn('SymmyCustomerIntake.prepareInvocation')(function* prepareCustomerIntake(
  source: ActionAuthorizationPreflightInput,
) {
  const database = yield* ActionAuthorizationPreflightDatabase;
  const payload = yield* Schema.decodeUnknownEffect(AdmitSymmyJobPayloadSchema)(source.payload).pipe(
    Effect.mapError(intakeUnavailable),
  );
  const plan = yield* database
    .read(
      source.scope,
      symmyJobOperationFactory,
      Effect.fnUntraced(function* prepareOwner(services) {
        const kind = yield* services.readPrincipalKind().pipe(Effect.mapError(intakeUnavailable));
        if (Option.getOrUndefined(kind) !== 'integration') {
          return yield* intakeDenied();
        }
        return yield* services.prepareIntake(payload);
      }),
    )
    .pipe(Effect.mapError((cause) => (Schema.is(SymmyJobStoreError)(cause) ? cause : intakeUnavailable(cause))));
  const crypto = yield* SecureRandom.SecureRandom;
  const preparationId = yield* crypto.uuidV4();
  const { bindingCommitments, intake } = yield* prepareSymmyCustomerIntakePrivacy(source.scope, plan, {
    invocationId: source.actionInvocationId,
    preparationId,
  });
  return {
    actionInvocationId: source.actionInvocationId,
    bindingCommitments,
    intakeHash: computeCanonicalValueHash(intake),
    preparationId,
    scope: source.scope,
  };
});

const customerIntakePreflight = Effect.fn('SymmyCustomerIntake.preflight')(function* buildIntakePreflight(
  state: IntakePreparationState,
) {
  const database = yield* ActionAuthorizationPreflightDatabase;
  const crypto = yield* SecureRandom.SecureRandom;
  const dependencies = Context.make(ActionAuthorizationPreflightDatabase, database).pipe(
    Context.add(SecureRandom.SecureRandom, crypto),
  );
  const preflight: ActionAuthorizationPreflightService = {
    prepare: (source) => {
      const permit = makeActionAuthorizationPreflightPermit({
        actionInvocationId: source.actionInvocationId,
        actionKey: source.actionKey,
        principalId: source.principal.principalId,
      });
      const consume = permit.consume.pipe(
        Effect.andThen(
          prepareCustomerIntake(source).pipe(
            Effect.provideContext(dependencies),
            Effect.result,
            Effect.flatMap((result) => Ref.set(state, result)),
          ),
        ),
      );
      return Effect.succeed({ outcome: 'allowed' as const, permit: { ...permit, consume } });
    },
  };
  return preflight;
});
const preparedCustomerIntake = (state: IntakePreparationState) =>
  SymmyPreparedCustomerIntake.of({
    verify: (current) =>
      Ref.get(state).pipe(
        Effect.flatMap((result) => {
          if (Result.isFailure(result)) {
            return Effect.fail(result.failure);
          }
          return customerIntakePreparationMatches(result.success, current)
            ? Effect.succeed(result.success)
            : Effect.fail(intakeDenied());
        }),
      ),
  });

// Consume Core's existing invocation-bound permit after permission/composition admission but before the tenant write
// transaction. Parent and Privacy Actions must never contend for the same tenant mutex while awaiting each other.
const customerIntakeActionRuntime = Layer.effect(
  ActionRuntime,
  Effect.gen(function* customerIntakeActionRuntime() {
    const baseContext = yield* Layer.build(governedActionRuntimeCoreLive);
    const base = Context.get(baseContext, ActionRuntime);
    const configuration = yield* DatabaseConfig;
    const crypto = yield* SecureRandom.SecureRandom;
    // Select only dependencies: capturing Effect.context would also retain the server's resource Scope.
    const dependencies = Context.make(DatabaseConfig, configuration).pipe(
      Context.add(SecureRandom.SecureRandom, crypto),
    );
    const preparationDependencies = yield* Effect.context<
      ActionAuthorizationPreflightDatabase | SecureRandom.SecureRandom
    >();
    const runPrepared: ActionRuntimeService['runAction'] = (input) =>
      Effect.scoped(
        Effect.gen(function* preparedRun() {
          const state = yield* Ref.make<Result.Result<SymmyCustomerIntakePreparation, SymmyJobStoreError>>(
            Result.fail(intakeUnavailable()),
          );
          const preflight = yield* customerIntakePreflight(state).pipe(Effect.provideContext(preparationDependencies));
          const context = yield* Layer.build(
            governedActionRuntimeCoreLive.pipe(Layer.provide(Layer.succeed(ActionAuthorizationPreflight, preflight))),
          ).pipe(
            Effect.provideContext(dependencies),
            Effect.mapError((cause) =>
              Object.defineProperty(
                new ActionPermissionCheckError({
                  code: 'action_permission_check_failed',
                  reason: 'The intake preparation runtime could not be built',
                }),
                'cause',
                { value: cause },
              ),
            ),
          );
          return yield* Context.get(context, ActionRuntime)
            .runAction(input)
            .pipe(Effect.provideService(SymmyPreparedCustomerIntake, preparedCustomerIntake(state)));
        }),
      );
    const runtime: ActionRuntimeService = {
      resolveActionCommit: base.resolveActionCommit,
      runAction: (input) => {
        const payload = Schema.decodeUnknownOption(AdmitSymmyJobPayloadSchema)(input.payload);
        return Object.is(input.registration, admitSymmyJobAction) &&
          Option.isSome(payload) &&
          isSymmyCustomerIntakeRoute(payload.value.routeKey)
          ? runPrepared(input)
          : base.runAction(input);
      },
    };
    return runtime;
  }),
);
const governedActionRuntimeLive = customerIntakeActionRuntime.pipe(
  GovernedReadLayer.provide(nodeCryptoLayer),
  GovernedReadLayer.provide(
    ActionAuthorizationPreflightDatabaseLive.pipe(GovernedReadLayer.provide(CorePersistenceLive)),
  ),
);

const governedReadApiHandlersLive = GovernedReadLayer.mergeAll(
  // <generated-governed-http-handler-layers>
  admitSymmyJobActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  admitSymmySyncActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  executeSymmyRetentionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  symmyJobPrivacyExecutionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  symmyJobStatusReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  symmyRouteContextReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  symmySourceOrganizationFactsReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  symmySyncAdmissionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  // </generated-governed-http-handler-layers>
).pipe(
  GovernedReadLayer.provide(governedReadRuntimeLive),
  // <generated-governed-http-handler-support-layers>
  GovernedReadLayer.provide(
    GovernedReadLayer.mergeAll(
      GovernedActionPrincipalVerifierLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
      GovernedGatewayAssertionRedemptionLive,
    ),
  ),
  // </generated-governed-http-handler-support-layers>
  GovernedReadLayer.provide(PgClient.layerFrom(gatewayAssertionRedemptionPgClient)),
  GovernedReadLayer.provide(Reactivity.layer),
);

const symmyIntegrationReadinessLayer = HttpApiBuilder.group(symmyIntegrationApi, 'foundation', (handlers) =>
  handlers.handle('readiness', () => {
    const operation = symmyIntegrationOperationContexts.readiness;
    return Effect.succeed({
      checks: {
        api: 'ready' as const,
        moduleFederation: 'ready' as const,
        ssr: 'ready' as const,
        translations: 'ready' as const,
      },
      marker: ultramodernApiMarker,
      status: 'ready' as const,
      versionSkew: 'none' as const,
    }).pipe(
      Effect.withSpan('ultramodern.api.symmyIntegration.readiness', {
        attributes: {
          'modernjs.operation.id': operation.operationId,
          'modernjs.operation.method': operation.method,
          'modernjs.operation.route': operation.routePath,
          'modernjs.operation.source': operation.source,
        },
        kind: 'server',
      }),
    );
  }),
);

const runtimeObservabilityLive = Layer.mergeAll(
  Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
  Layer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
  Layer.succeed(References.MinimumLogLevel, 'Info'),
);

const apiHandlersLive = Layer.mergeAll(symmyIntegrationReadinessLayer, governedReadApiHandlersLive).pipe(
  Layer.provide(SymmyJobPrivacyLive),
  Layer.provide(SymmyCatalogPricingInventoryAdaptersLive),
  Layer.provide(SymmyPartyCommerceAdaptersLive),
  Layer.provide(SymmyPolicyFixtureAdaptersLive),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' })),
  Layer.provide(
    Layer.mergeAll(governedApplicationCompositionSourceLive, RequestSchemaProblemLive, runtimeObservabilityLive),
  ),
  Layer.provide(Layer.mergeAll(DatabaseConfigLive, nodeCryptoLayer)),
  Layer.orDie,
);

export default assembleEffectBffRuntime({ api: symmyIntegrationApi, handlers: apiHandlersLive });
