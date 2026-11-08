import {
  OwnerActionApprovalSchemaErrorLive,
  makeOwnerActionApprovalApiLive,
} from '@app/core-runtime/access/approvals/owner-http';
import { makeOwnerActionApprovalsLive } from '@app/core-runtime/access/approvals/owner-runtime';
import { propertyPortfolioRegistration } from '../vertical.registration.ts';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import {
  defineDatabaseIdentityEnrollment,
  makeDatabaseIdentityEnrollmentLive,
  ContextAccessLive as GovernedContextAccessLive,
  CorePersistenceLive as GovernedCorePersistenceLive,
  DatabaseConfigLive as GovernedDatabaseConfigLive,
  makeReadRuntimeLive,
  TenantModuleStateServiceLive as GovernedTenantModuleStateServiceLive,
  makeActionRuntimeLive,
} from '@app/core-runtime';
import {
  AccessDecisionLive,
  AccessEnforcementPortsLive,
  ModuleEntrypointGatewayLive as GovernedModuleEntrypointGatewayLive,
  ModuleStateGateLive as GovernedModuleStateGateLive,
  OperationalScopeResolverLive as GovernedOperationalScopeResolverLive,
  ActionPermissionLive,
  ActionRepositoryLive,
  TenantIntentLoaderLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { ActiveApplicationCompositionSourceLive as GovernedApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { Logger, References, Tracer, Layer as GovernedReadLayer } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { FetchHttpClient as GovernedFetchHttpClient } from 'effect/http';
// <generated-governed-http-handler-support-imports>
import {
  ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive,
  authenticateOperationPrincipal as authenticateOwnerApprovalPrincipal,
} from './auth/action-principal.ts';
import {
  GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive,
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionPgClientLive,
} from './auth/gateway-assertion-redemption.ts';
// </generated-governed-http-handler-support-imports>

// <generated-governed-http-handler-imports>
import { applyCommandActionApiLive } from './apply-command-action-server.ts';
import { assetsReadApiLive } from './assets-search-server.ts';
import { propertiesReadApiLive } from './properties-search-server.ts';
import { recordsReadApiLive } from './records-read-server.ts';
import { requestSearchRebuildActionApiLive } from './request-search-rebuild-action-server.ts';
import { searchLabelsReadApiLive } from './search-labels-read-server.ts';
import { unitsReadApiLive } from './units-search-server.ts';
// </generated-governed-http-handler-imports>

import { ActiveApplicationCompositionConfigLive } from '@app/core-runtime/modules/active-application-composition';
import { ultramodernDeliveryUnit, ultramodernApiMarker } from '../shared/ultramodern-build.ts';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Effect, HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { propertyPortfolioApi, propertyPortfolioOperationContexts } from '../shared/api.ts';
import type { OperationContext } from '../shared/api.ts';

const databaseIdentitiesLive = makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([]));

const governedCompositionHttpClientLive = GovernedFetchHttpClient.layer.pipe(
  GovernedReadLayer.provide(
    GovernedReadLayer.succeed(GovernedFetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' }),
  ),
);
const governedApplicationCompositionSourceLive = GovernedApplicationCompositionSourceLive.pipe(
  GovernedReadLayer.provide(governedCompositionHttpClientLive),
);
const governedActiveApplicationCompositionLive = ActiveApplicationCompositionConfigLive.pipe(
  GovernedReadLayer.provide(governedApplicationCompositionSourceLive),
);

const governedTenantModuleStateServiceLive = GovernedTenantModuleStateServiceLive.pipe(
  GovernedReadLayer.provide(GovernedCorePersistenceLive),
);
const governedModuleStateGateLive = GovernedModuleStateGateLive.pipe(
  GovernedReadLayer.provide(governedTenantModuleStateServiceLive),
);
const governedAccessEnforcementLive = AccessDecisionLive.pipe(
  GovernedReadLayer.provideMerge(AccessEnforcementPortsLive),
  GovernedReadLayer.provide(TenantIntentLoaderLive),
  GovernedReadLayer.provide(GovernedCorePersistenceLive),
  GovernedReadLayer.provide(GovernedDatabaseConfigLive),
  GovernedReadLayer.provide(nodeCryptoLayer),
);
const governedReadRuntimeDependenciesLive = GovernedReadLayer.mergeAll(
  GovernedCorePersistenceLive,
  GovernedContextAccessLive,
  GovernedModuleEntrypointGatewayLive.pipe(GovernedReadLayer.provide(governedModuleStateGateLive)),
  GovernedOperationalScopeResolverLive.pipe(
    GovernedReadLayer.provide(
      GovernedReadLayer.mergeAll(GovernedCorePersistenceLive, GovernedContextAccessLive, governedAccessEnforcementLive),
    ),
  ),
  governedAccessEnforcementLive,
);

const governedActionRuntimeDependenciesLive = GovernedReadLayer.mergeAll(
  GovernedCorePersistenceLive,
  GovernedContextAccessLive,
  governedActiveApplicationCompositionLive,
  ActionRepositoryLive,
  ActionPermissionLive,
  governedModuleStateGateLive,
  GovernedModuleEntrypointGatewayLive.pipe(GovernedReadLayer.provide(governedModuleStateGateLive)),
  GovernedOperationalScopeResolverLive.pipe(
    GovernedReadLayer.provide(
      GovernedReadLayer.mergeAll(GovernedCorePersistenceLive, GovernedContextAccessLive, governedAccessEnforcementLive),
    ),
  ),
  governedAccessEnforcementLive,
);
const ownerActionApprovalsLive = makeOwnerActionApprovalsLive(
  ultramodernDeliveryUnit,
  propertyPortfolioRegistration,
).pipe(GovernedReadLayer.provide(governedActionRuntimeDependenciesLive));

const governedActionRuntimeLive = makeActionRuntimeLive(ultramodernDeliveryUnit, propertyPortfolioRegistration).pipe(
  GovernedReadLayer.provideMerge(ownerActionApprovalsLive),
  GovernedReadLayer.provide(governedActionRuntimeDependenciesLive),
);
const governedReadRuntimeLive = makeReadRuntimeLive(ultramodernDeliveryUnit, propertyPortfolioRegistration).pipe(
  GovernedReadLayer.provide(governedReadRuntimeDependenciesLive),
  GovernedReadLayer.provide(GovernedDatabaseConfigLive),
  GovernedReadLayer.provide(governedActiveApplicationCompositionLive),
);

export const governedReadApiHandlersLive = GovernedReadLayer.mergeAll(
  makeOwnerActionApprovalApiLive(propertyPortfolioApi, authenticateOwnerApprovalPrincipal).pipe(
    GovernedReadLayer.provide(OwnerActionApprovalSchemaErrorLive),
    GovernedReadLayer.provide(governedActionRuntimeLive),
  ),
  // <generated-governed-http-handler-layers>
  applyCommandActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  assetsReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  propertiesReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  recordsReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  requestSearchRebuildActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  searchLabelsReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  unitsReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  // </generated-governed-http-handler-layers>
).pipe(
  // <generated-governed-http-handler-support-layers>
  GovernedReadLayer.provide(
    GovernedReadLayer.mergeAll(
      GovernedActionPrincipalVerifierLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
      GovernedGatewayAssertionRedemptionLive.pipe(
        GovernedReadLayer.provide(GatewayAssertionRedemptionDatabaseLive),
        GovernedReadLayer.provide(GatewayAssertionPgClientLive),
        GovernedReadLayer.provide(Reactivity.layer),
      ),
    ),
  ),
  // </generated-governed-http-handler-support-layers>
  // The search-labels read checks current resource authority in `finish` with ContextAccess.
  GovernedReadLayer.provide(GovernedContextAccessLive),
);

const operationAttributes = (operationContext: OperationContext) => {
  const attributes = {
    'modernjs.operation.id': operationContext.operationId,
    'modernjs.operation.method': operationContext.method,
    'modernjs.operation.route': operationContext.routePath,
    'modernjs.operation.source': operationContext.source,
    'modernjs.trace.id': operationContext.traceId,
  };
  return attributes;
};
const telemetryLive = GovernedReadLayer.mergeAll(
  Logger.layer([Logger.defaultLogger]),
  GovernedReadLayer.succeed(References.MinimumLogLevel, 'Info'),
  GovernedReadLayer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
);

const propertyPortfolioReadinessLayer = HttpApiBuilder.group(propertyPortfolioApi, 'foundation', (handlers) =>
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
      Effect.withSpan('ultramodern.api.propertyPortfolio.readiness', {
        attributes: operationAttributes(propertyPortfolioOperationContexts.readiness),
        kind: 'server',
      }),
    ),
  ),
);

const apiHandlersLive = propertyPortfolioReadinessLayer;
const governedResolvedApiHandlersLive = GovernedReadLayer.mergeAll(apiHandlersLive, governedReadApiHandlersLive).pipe(
  GovernedReadLayer.provide(GovernedCorePersistenceLive),
  GovernedReadLayer.provide(ActiveApplicationCompositionConfigLive),
  GovernedReadLayer.provide(governedApplicationCompositionSourceLive),
  GovernedReadLayer.provide(GovernedDatabaseConfigLive),
  GovernedReadLayer.provide(databaseIdentitiesLive),
  GovernedReadLayer.provide(nodeCryptoLayer),
  GovernedReadLayer.provide(telemetryLive),
  GovernedReadLayer.orDie,
);

export const makePropertyPortfolioApiRuntime = () =>
  assembleEffectBffRuntime({
    api: propertyPortfolioApi,
    handlers: governedResolvedApiHandlersLive,
  });
const apiRuntime = makePropertyPortfolioApiRuntime();

export default apiRuntime;
