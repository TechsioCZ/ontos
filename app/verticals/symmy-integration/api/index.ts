import { SymmyCatalogPricingInventoryAdaptersLive } from '../src/services/symmy-catalog-pricing-inventory-adapters.ts';
import { SymmyPartyCommerceAdaptersLive } from '../src/services/symmy-party-commerce-adapters.ts';
import {
  ActionAuthorizationPreflightDatabaseLive,
  ContextAccessLive,
  CorePersistenceLive,
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
import { Effect, Layer, Layer as GovernedReadLayer, Logger, References, Tracer } from 'effect';
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
const governedReadRuntimeLive = makeReadRuntimeLive(ultramodernDeliveryUnit, symmyIntegrationRegistration).pipe(
  GovernedReadLayer.provide(governedReadRuntimeDependenciesLive),
  GovernedReadLayer.provide(governedActiveApplicationCompositionLive),
);
const governedActionRuntimeLive = makeActionRuntimeLive(ultramodernDeliveryUnit, symmyIntegrationRegistration).pipe(
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
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' })),
  Layer.provide(
    Layer.mergeAll(governedApplicationCompositionSourceLive, RequestSchemaProblemLive, runtimeObservabilityLive),
  ),
  Layer.provide(Layer.mergeAll(DatabaseConfigLive, nodeCryptoLayer)),
  Layer.orDie,
);

export default assembleEffectBffRuntime({ api: symmyIntegrationApi, handlers: apiHandlersLive });
