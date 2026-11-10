import { promotionRegistration as governedOwnerRegistration } from '../vertical.registration.ts';
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
import { PromotionDatabaseLive, PromotionPgClientLive } from '../src/database/client.ts';
import { PromotionExternalFactSourceLive } from '../src/services/evaluation.service.ts';
import { Reactivity } from 'effect/reactivity';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import { Layer as GovernedReadLayer, Logger, References, Tracer } from 'effect';
import { FetchHttpClient as GovernedFetchHttpClient } from 'effect/http';
// <generated-governed-http-handler-support-imports>
import { ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive } from './auth/action-principal.ts';
import { GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive } from './auth/gateway-assertion-redemption.ts';
// </generated-governed-http-handler-support-imports>

// <generated-governed-http-handler-imports>
import { createPromotionDraftActionApiLive } from './create-promotion-draft-action-server.ts';
import { createPromotionSuccessorActionApiLive } from './create-promotion-successor-action-server.ts';
import { disablePromotionActionApiLive } from './disable-promotion-action-server.ts';
import { disableVoucherActionApiLive } from './disable-voucher-action-server.ts';
import { editPromotionDraftActionApiLive } from './edit-promotion-draft-action-server.ts';
import { endPromotionActionApiLive } from './end-promotion-action-server.ts';
import { previewPromotionsReadApiLive } from './preview-promotions-read-server.ts';
import { provisionVoucherActionApiLive } from './provision-voucher-action-server.ts';
import { publishPromotionActionApiLive } from './publish-promotion-action-server.ts';
import { readPromotionPoliciesReadApiLive } from './read-promotion-policies-read-server.ts';
import { readPromotionsReadApiLive } from './read-promotions-read-server.ts';
import { readVouchersReadApiLive } from './read-vouchers-read-server.ts';
import { retirePromotionActionApiLive } from './retire-promotion-action-server.ts';
import { setBasisPolicyActionApiLive } from './set-basis-policy-action-server.ts';
import { setCartRankingActionApiLive } from './set-cart-ranking-action-server.ts';
import { setShippingRankingActionApiLive } from './set-shipping-ranking-action-server.ts';
// </generated-governed-http-handler-imports>

import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Effect, HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
import { promotionApi, promotionOperationContexts } from '../shared/api.ts';
import type { OperationContext } from '../shared/api.ts';

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
  GovernedReadLayer.provide(nodeCryptoLayer),
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
const governedReadRuntimeLive = GovernedMakeReadRuntimeLive(governedActionDeliveryUnit, governedOwnerRegistration).pipe(
  GovernedReadLayer.provide(governedReadRuntimeDependenciesLive),
  GovernedReadLayer.provide(governedActiveApplicationCompositionLive),
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
  // <generated-governed-http-handler-layers>
  createPromotionDraftActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  createPromotionSuccessorActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  disablePromotionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  disableVoucherActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  editPromotionDraftActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  endPromotionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  previewPromotionsReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  provisionVoucherActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  publishPromotionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  readPromotionPoliciesReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  readPromotionsReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  readVouchersReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  retirePromotionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  setBasisPolicyActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  setCartRankingActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  setShippingRankingActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
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
  GovernedReadLayer.provide(governedAccessEnforcementLive),
);

const runtimeObservabilityLive = Layer.mergeAll(
  Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
  Layer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
  Layer.succeed(References.MinimumLogLevel, 'Info'),
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

const promotionReadinessLayer = HttpApiBuilder.group(promotionApi, 'foundation', (handlers) =>
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
      Effect.withSpan('ultramodern.api.promotion.readiness', {
        attributes: operationAttributes(promotionOperationContexts.readiness),
        kind: 'server',
      }),
    ),
  ),
);

const apiHandlersLive = Layer.mergeAll(promotionReadinessLayer);
export default assembleEffectBffRuntime({
  api: promotionApi,
  handlers: GovernedReadLayer.mergeAll(apiHandlersLive, governedReadApiHandlersLive).pipe(
    GovernedReadLayer.provide(
      PromotionDatabaseLive.pipe(
        GovernedReadLayer.provide(PromotionPgClientLive),
        GovernedReadLayer.provide(Reactivity.layer),
      ),
    ),
    GovernedReadLayer.provide(runtimeObservabilityLive),
    GovernedReadLayer.provide(PromotionExternalFactSourceLive),
    GovernedReadLayer.provide(governedApplicationCompositionSourceLive),
    GovernedReadLayer.provide(GovernedReadLayer.mergeAll(GovernedDatabaseConfigLive, nodeCryptoLayer)),
    GovernedReadLayer.orDie,
  ),
});
