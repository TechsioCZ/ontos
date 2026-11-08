import {
  OwnerActionApprovalSchemaErrorLive,
  makeOwnerActionApprovalApiLive,
} from '@app/core-runtime/access/approvals/owner-http';
import { makeOwnerActionApprovalsLive } from '@app/core-runtime/access/approvals/owner-runtime';
import { merchandiseBackendRegistration } from '../vertical.runtime-declaration.ts';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import {
  CoreSearchQueryRuntimeLive,
  CoreSearchProjectionStoreLive,
  defineDatabaseIdentityEnrollment,
  makeDatabaseIdentityEnrollmentLive,
  makeActionRuntimeLive,
  ContextAccessLive as GovernedContextAccessLive,
  CorePersistenceLive as GovernedCorePersistenceLive,
  DatabaseConfigLive as GovernedDatabaseConfigLive,
  makeReadRuntimeLive,
  TenantModuleStateServiceLive as GovernedTenantModuleStateServiceLive,
} from '@app/core-runtime';
import {
  AccessDecisionLive,
  AccessEnforcementPortsLive,
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive as GovernedModuleEntrypointGatewayLive,
  ModuleStateGateLive as GovernedModuleStateGateLive,
  OperationalScopeResolverLive as GovernedOperationalScopeResolverLive,
  TenantIntentLoaderLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { ActiveApplicationCompositionConfigLive } from '@app/core-runtime/modules/active-application-composition';
import { ultramodernDeliveryUnit, ultramodernApiMarker } from '../shared/ultramodern-build.ts';
import { ActiveApplicationCompositionSourceLive as GovernedApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { Layer as GovernedReadLayer, Logger, References, Tracer } from 'effect';
import { FetchHttpClient as GovernedFetchHttpClient } from 'effect/http';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Effect, HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { merchandiseApi, merchandiseOperationContexts } from '../shared/api.ts';
import type { OperationContext } from '../shared/api.ts';

// <generated-governed-http-handler-support-imports>
import {
  ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive,
  authenticateOperationPrincipal as authenticateOwnerApprovalPrincipal,
} from './auth/action-principal.ts';
import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive,
} from './auth/gateway-assertion-redemption.ts';
// </generated-governed-http-handler-support-imports>

// <generated-governed-http-handler-imports>
import { agentReviewReadApiLive } from './agent-review-read-server.ts';
import { applyCommandActionApiLive } from './apply-command-action-server.ts';
import { bootstrapPlaygroundCatalogActionApiLive } from './bootstrap-playground-catalog-action-server.ts';
import { changeOrderStatusActionApiLive } from './change-order-status-action-server.ts';
import { changeProductImagesActionApiLive } from './change-product-images-action-server.ts';
import { cleanupDemoActionApiLive } from './cleanup-demo-action-server.ts';
import { manageCatalogActionApiLive } from './manage-catalog-action-server.ts';
import { manageMarketsActionApiLive } from './manage-markets-action-server.ts';
import { mediaReadApiLive } from './media-read-server.ts';
import { ordersReadApiLive } from './orders-search-server.ts';
import { placeStorefrontOrderActionApiLive } from './place-storefront-order-action-server.ts';
import { productsReadApiLive } from './products-search-server.ts';
import { proposeOrderChangesActionApiLive } from './propose-order-changes-action-server.ts';
import { recordsReadApiLive } from './records-read-server.ts';
import { recordStockMovementActionApiLive } from './record-stock-movement-action-server.ts';
import { requestSearchRebuildActionApiLive } from './request-search-rebuild-action-server.ts';
import { reviewOrderChangesActionApiLive } from './review-order-changes-action-server.ts';
// </generated-governed-http-handler-imports>

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
const governedReadRuntimeLive = makeReadRuntimeLive(ultramodernDeliveryUnit, merchandiseBackendRegistration).pipe(
  GovernedReadLayer.provide(governedReadRuntimeDependenciesLive),
  GovernedReadLayer.provide(GovernedDatabaseConfigLive),
  GovernedReadLayer.provide(governedActiveApplicationCompositionLive),
);

const ownerActionApprovalsLive = makeOwnerActionApprovalsLive(
  ultramodernDeliveryUnit,
  merchandiseBackendRegistration,
).pipe(
  GovernedReadLayer.provide(
    GovernedReadLayer.mergeAll(
      governedReadRuntimeDependenciesLive,
      ActionRepositoryLive,
      ActionPermissionLive,
      governedModuleStateGateLive,
      governedActiveApplicationCompositionLive,
    ),
  ),
);

const governedActionRuntimeLive = makeActionRuntimeLive(ultramodernDeliveryUnit, merchandiseBackendRegistration).pipe(
  GovernedReadLayer.provideMerge(ownerActionApprovalsLive),
  GovernedReadLayer.provide(
    GovernedReadLayer.mergeAll(
      governedReadRuntimeDependenciesLive,
      ActionRepositoryLive,
      ActionPermissionLive,
      governedModuleStateGateLive,
      governedActiveApplicationCompositionLive,
    ),
  ),
);

export const governedReadApiHandlersLive = GovernedReadLayer.mergeAll(
  makeOwnerActionApprovalApiLive(merchandiseApi, authenticateOwnerApprovalPrincipal).pipe(
    GovernedReadLayer.provide(OwnerActionApprovalSchemaErrorLive),
    GovernedReadLayer.provide(governedActionRuntimeLive),
  ),
  // <generated-governed-http-handler-layers>
  agentReviewReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  applyCommandActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  bootstrapPlaygroundCatalogActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  changeOrderStatusActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  changeProductImagesActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  cleanupDemoActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  manageCatalogActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  manageMarketsActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  mediaReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  ordersReadApiLive.pipe(
    GovernedReadLayer.provide(governedReadRuntimeLive),
    GovernedReadLayer.provide(
      CoreSearchQueryRuntimeLive.pipe(GovernedReadLayer.provide(CoreSearchProjectionStoreLive)),
    ),
  ),
  placeStorefrontOrderActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  productsReadApiLive.pipe(
    GovernedReadLayer.provide(governedReadRuntimeLive),
    GovernedReadLayer.provide(
      CoreSearchQueryRuntimeLive.pipe(GovernedReadLayer.provide(CoreSearchProjectionStoreLive)),
    ),
  ),
  proposeOrderChangesActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  recordsReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  recordStockMovementActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  requestSearchRebuildActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  reviewOrderChangesActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  // </generated-governed-http-handler-layers>
).pipe(
  // <generated-governed-http-handler-support-layers>
  GovernedReadLayer.provide(
    GovernedReadLayer.mergeAll(
      GovernedActionPrincipalVerifierLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
      GovernedGatewayAssertionRedemptionLive.pipe(GovernedReadLayer.provide(GatewayAssertionRedemptionDatabaseLive)),
    ),
  ),
  // </generated-governed-http-handler-support-layers>
  GovernedReadLayer.provide(governedReadRuntimeDependenciesLive),
);

const operationAttributes = (operationContext: OperationContext) => ({
  'modernjs.operation.id': operationContext.operationId,
  'modernjs.operation.method': operationContext.method,
  'modernjs.operation.route': operationContext.routePath,
  'modernjs.operation.source': operationContext.source,
});

const merchandiseReadinessLayer = HttpApiBuilder.group(merchandiseApi, 'foundation', (handlers) =>
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
      Effect.withSpan('ultramodern.api.merchandise.readiness', {
        attributes: operationAttributes(merchandiseOperationContexts.readiness),
        kind: 'server',
      }),
    ),
  ),
);

const apiHandlersLive = merchandiseReadinessLayer;
const runtimeObservabilityLive = GovernedReadLayer.mergeAll(
  Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
  GovernedReadLayer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
  GovernedReadLayer.succeed(References.MinimumLogLevel, 'Info'),
);
const governedResolvedApiHandlersLive = GovernedReadLayer.mergeAll(apiHandlersLive, governedReadApiHandlersLive).pipe(
  GovernedReadLayer.provide(governedApplicationCompositionSourceLive),
  GovernedReadLayer.provide(GovernedDatabaseConfigLive),
  GovernedReadLayer.provide(databaseIdentitiesLive),
  GovernedReadLayer.provide(nodeCryptoLayer),
  GovernedReadLayer.provide(runtimeObservabilityLive),
  GovernedReadLayer.orDie,
);

export const makeMerchandiseApiRuntime = () =>
  assembleEffectBffRuntime({
    api: merchandiseApi,
    handlers: governedResolvedApiHandlersLive,
  });
const apiRuntime = makeMerchandiseApiRuntime();

export default apiRuntime;
