import { ModuleCallRouteLive as GovernedModuleCallRouteLive } from '@app/shared-contracts/server/sdk-module-call-route';
import { communicationsRegistration as governedOwnerRegistration } from '../vertical.registration.ts';
import {
  ultramodernDeliveryUnit as governedActionDeliveryUnit,
  ultramodernApiMarker,
} from '../shared/ultramodern-build.ts';
import {
  ContextAccessLive as GovernedContextAccessLive,
  CorePersistenceLive as GovernedCorePersistenceLive,
  DatabaseConfigLive as GovernedDatabaseConfigLive,
  makeReadRuntimeLive as GovernedMakeReadRuntimeLive,
  makeActionRuntimeLive as GovernedMakeActionRuntimeLive,
  TenantModuleStateServiceLive as GovernedTenantModuleStateServiceLive,
} from '@app/core-runtime';
import {
  AccessDecisionLive as GovernedAccessDecisionLive,
  AccessEnforcementPortsLive as GovernedAccessEnforcementPortsLive,
  ActionPermissionLive as GovernedActionPermissionLive,
  ActionRepositoryLive as GovernedActionRepositoryLive,
  ModuleEntrypointGatewayLive as GovernedModuleEntrypointGatewayLive,
  ModuleStateGateLive as GovernedModuleStateGateLive,
  OperationalScopeResolverLive as GovernedOperationalScopeResolverLive,
  TenantIntentLoaderLive as GovernedTenantIntentLoaderLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { ActiveApplicationCompositionConfigLive as GovernedApplicationCompositionConfigLive } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive as GovernedApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Effect, HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
import { NodeCrypto } from '@effect/platform-node';
import { Layer as GovernedReadLayer, Logger, References, Tracer } from 'effect';
import { FetchHttpClient as GovernedFetchHttpClient } from 'effect/http';
import { Reactivity } from 'effect/reactivity';
import { CommunicationsDatabaseLive, CommunicationsPgClientLive } from '../src/database/client.ts';
import { communicationsApi, communicationsOperationContexts } from '../shared/api.ts';
import type { OperationContext } from '../shared/api.ts';
// <generated-governed-http-handler-support-imports>
import { ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive } from './auth/action-principal.ts';
import { GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive } from './auth/gateway-assertion-redemption.ts';
// </generated-governed-http-handler-support-imports>

// <generated-governed-http-handler-imports>
import { activateTemplateRevisionActionApiLive } from './activate-template-revision-action-server.ts';
import { deactivateTemplateRevisionActionApiLive } from './deactivate-template-revision-action-server.ts';
import { invalidateTemplateRevisionActionApiLive } from './invalidate-template-revision-action-server.ts';
import { prepareTemplateRevisionActionApiLive } from './prepare-template-revision-action-server.ts';
// </generated-governed-http-handler-imports>

const governedTenantModuleStateServiceLive = GovernedTenantModuleStateServiceLive.pipe(
  GovernedReadLayer.provide(GovernedCorePersistenceLive),
);
const governedModuleStateGateLive = GovernedModuleStateGateLive.pipe(
  GovernedReadLayer.provide(governedTenantModuleStateServiceLive),
);
const governedReadRuntimeDependenciesLive = GovernedReadLayer.mergeAll(
  GovernedCorePersistenceLive,
  GovernedContextAccessLive,
  GovernedModuleEntrypointGatewayLive.pipe(GovernedReadLayer.provide(governedModuleStateGateLive)),
  GovernedOperationalScopeResolverLive.pipe(
    GovernedReadLayer.provide(GovernedReadLayer.mergeAll(GovernedCorePersistenceLive, GovernedContextAccessLive)),
  ),
);
const governedAccessEnforcementLive = GovernedAccessDecisionLive.pipe(
  GovernedReadLayer.provideMerge(GovernedAccessEnforcementPortsLive),
  GovernedReadLayer.provide(GovernedTenantIntentLoaderLive),
  GovernedReadLayer.provide(GovernedCorePersistenceLive),
  GovernedReadLayer.provide(GovernedDatabaseConfigLive),
  GovernedReadLayer.provide(NodeCrypto.layer),
);
const governedApplicationCompositionSourceLive = GovernedApplicationCompositionSourceLive.pipe(
  GovernedReadLayer.provide(
    GovernedFetchHttpClient.layer.pipe(
      GovernedReadLayer.provide(
        GovernedReadLayer.succeed(GovernedFetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' }),
      ),
    ),
  ),
);

const governedActiveApplicationCompositionLive = GovernedApplicationCompositionConfigLive.pipe(
  GovernedReadLayer.provide(governedApplicationCompositionSourceLive),
);
// The module route's fetch client: no cache, no redirect, so the delegated credential reaches only the named provider.
const governedModuleCallHttpClientLive = GovernedFetchHttpClient.layer.pipe(
  GovernedReadLayer.provide(
    GovernedReadLayer.succeed(GovernedFetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' }),
  ),
);
const governedReadRuntimeLive = GovernedMakeReadRuntimeLive(governedActionDeliveryUnit, governedOwnerRegistration).pipe(
  GovernedReadLayer.provide(governedReadRuntimeDependenciesLive),
  GovernedReadLayer.provide(governedActiveApplicationCompositionLive),
  GovernedReadLayer.provide(
    GovernedModuleCallRouteLive.pipe(
      GovernedReadLayer.provide(GovernedReadLayer.mergeAll(NodeCrypto.layer, governedModuleCallHttpClientLive)),
    ),
  ),
);

const operationAttributes = (operationContext: OperationContext) => {
  const base = {
    'modernjs.operation.id': operationContext.operationId,
    'modernjs.operation.method': operationContext.method,
    'modernjs.operation.route': operationContext.routePath,
    'modernjs.operation.source': operationContext.source,
  };
  return operationContext.traceId === undefined ? base : { ...base, 'modernjs.trace.id': operationContext.traceId };
};

const communicationsReadinessLayer = HttpApiBuilder.group(communicationsApi, 'foundation', (handlers) =>
  handlers.handle('readiness', () =>
    Effect.succeed({
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
      Effect.withSpan('ultramodern.api.communications.readiness', {
        attributes: operationAttributes(communicationsOperationContexts.readiness),
        kind: 'server',
      }),
    ),
  ),
);

const governedActionRuntimeLive = GovernedMakeActionRuntimeLive(
  governedActionDeliveryUnit,
  governedOwnerRegistration,
).pipe(
  GovernedReadLayer.provide(
    GovernedReadLayer.mergeAll(
      governedReadRuntimeDependenciesLive,
      governedModuleStateGateLive,
      GovernedActionRepositoryLive,
      GovernedActionPermissionLive,
      governedActiveApplicationCompositionLive,
    ),
  ),
);

export const governedReadApiHandlersLive = GovernedReadLayer.mergeAll(
  communicationsReadinessLayer,
  // <generated-governed-http-handler-layers>
  activateTemplateRevisionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  deactivateTemplateRevisionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  invalidateTemplateRevisionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  prepareTemplateRevisionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  // </generated-governed-http-handler-layers>
).pipe(
  // <generated-governed-http-handler-support-layers>
  GovernedReadLayer.provide(
    GovernedReadLayer.mergeAll(
      GovernedActionPrincipalVerifierLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
      GovernedGatewayAssertionRedemptionLive,
    ),
  ),
  // </generated-governed-http-handler-support-layers>
  // Every Read and Action handler of this owner runs in the Core-owned Read runtime composed above.
  GovernedReadLayer.provide(governedReadRuntimeLive),
  GovernedReadLayer.provide(governedAccessEnforcementLive),
);

const runtimeObservabilityLive = Layer.mergeAll(
  Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
  Layer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
  Layer.succeed(References.MinimumLogLevel, 'Info'),
);
export default assembleEffectBffRuntime({
  api: communicationsApi,
  handlers: governedReadApiHandlersLive.pipe(
    GovernedReadLayer.provide(
      CommunicationsDatabaseLive.pipe(
        GovernedReadLayer.provide(CommunicationsPgClientLive),
        GovernedReadLayer.provide(Reactivity.layer),
      ),
    ),
    GovernedReadLayer.provide(runtimeObservabilityLive),
    GovernedReadLayer.provide(governedApplicationCompositionSourceLive),
    GovernedReadLayer.provide(GovernedReadLayer.mergeAll(GovernedDatabaseConfigLive, NodeCrypto.layer)),
    GovernedReadLayer.orDie,
  ),
});
