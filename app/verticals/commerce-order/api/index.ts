import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Effect, HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/bff-effect/effect-edge';

import { commerceOrderApi, commerceOrderOperationContexts } from '../shared/api.ts';
import type { OperationContext } from '../shared/api.ts';
import {
  ultramodernApiMarker,
  ultramodernDeliveryUnit as governedActionDeliveryUnit,
} from '../shared/ultramodern-build.ts';

import {
  ActionAuthorizationPreflightDatabaseLive,
  ContextAccessLive as GovernedContextAccessLive,
  CorePersistenceLive as GovernedCorePersistenceLive,
  DatabaseConfigLive as GovernedDatabaseConfigLive,
  ReadRuntimeLive as GovernedReadRuntimeLive,
  makeActionRuntimeLive as GovernedMakeActionRuntimeLive,
  TenantModuleStateServiceLive as GovernedTenantModuleStateServiceLive,
} from '@app/core-runtime';
import {
  ActionPermissionLive as GovernedActionPermissionLive,
  ActionRepositoryLive as GovernedActionRepositoryLive,
  ModuleEntrypointGatewayLive as GovernedModuleEntrypointGatewayLive,
  ModuleStateGateLive as GovernedModuleStateGateLive,
  OperationalScopeResolverLive as GovernedOperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { ActiveApplicationCompositionConfigLive as GovernedApplicationCompositionConfigLive } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive as GovernedApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import { PgClient } from '@effect/sql-pg';
import { Reactivity } from 'effect/reactivity';
import { ApprovalOwnerGatewayLive } from '../src/services/approval-owner-gateway.ts';
import { OrderFinalSourceVerificationLive } from '../src/services/order-final-source-verification.service.ts';
import { OrderFinalizationPricingCartLive } from '../src/integrations/order-finalization-pricing-cart.ts';
import { FinalizationTaxPaymentTermsLive } from '../src/integrations/finalization-tax-payment-terms.ts';
import {
  GatewayAssertionRedemptionDatabaseLive,
  gatewayAssertionRedemptionPgClient,
  GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive,
} from './auth/gateway-assertion-redemption.ts';
import { Layer as GovernedReadLayer, Logger, References, Tracer } from 'effect';
import { FetchHttpClient as GovernedFetchHttpClient } from 'effect/http';
// <generated-governed-http-handler-support-imports>
import { ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive } from './auth/action-principal.ts';
// </generated-governed-http-handler-support-imports>

// <generated-governed-http-handler-imports>
import { cancelOrderCommitmentActionApiLive } from './cancel-order-commitment-action-server.ts';
import { commitOrderActionApiLive } from './commit-order-action-server.ts';
import { committedOrderApprovalEvidenceReadApiLive } from './committed-order-approval-evidence-read-server.ts';
import { completeOrderApprovalConsumptionActionApiLive } from './complete-order-approval-consumption-action-server.ts';
import { completeOrderPreparationActionApiLive } from './complete-order-preparation-action-server.ts';
import { orderCommitmentStateReadApiLive } from './order-commitment-state-read-server.ts';
import { orderFinalizationWorkReadApiLive } from './order-finalization-work-read-server.ts';
import { preparedOrderApprovalBindingReadApiLive } from './prepared-order-approval-binding-read-server.ts';
import { preparedOrderPricingBindingReadApiLive } from './prepared-order-pricing-binding-read-server.ts';
import { prepareOrderCommitmentActionApiLive } from './prepare-order-commitment-action-server.ts';
import { reconcileOrderApprovalActionApiLive } from './reconcile-order-approval-action-server.ts';
import { recordOrderProofSetActionApiLive } from './record-order-proof-set-action-server.ts';
import { recordPrecommitFailureActionApiLive } from './record-precommit-failure-action-server.ts';
import { revalidateOrderCommitmentActionApiLive } from './revalidate-order-commitment-action-server.ts';
import { verifyOrderCommitmentBindingReadApiLive } from './verify-order-commitment-binding-read-server.ts';
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
const governedReadRuntimeLive = GovernedReadRuntimeLive.pipe(
  GovernedReadLayer.provide(governedReadRuntimeDependenciesLive),
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

const configuredGatewayAssertionRedemptionDatabaseLive = GatewayAssertionRedemptionDatabaseLive.pipe(
  GovernedReadLayer.provide(PgClient.layerFrom(gatewayAssertionRedemptionPgClient)),
  GovernedReadLayer.provide(Reactivity.layer),
  GovernedReadLayer.provide(GovernedDatabaseConfigLive),
);
const configuredApprovalOwnerGatewayLive = ApprovalOwnerGatewayLive.pipe(
  GovernedReadLayer.provide(GovernedApplicationCompositionConfigLive),
  GovernedReadLayer.provide(governedApplicationCompositionSourceLive),
);

const configuredOrderFinalSourcesLive = OrderFinalSourceVerificationLive.pipe(
  GovernedReadLayer.provide(
    GovernedReadLayer.mergeAll(OrderFinalizationPricingCartLive, FinalizationTaxPaymentTermsLive),
  ),
  GovernedReadLayer.provide(GovernedApplicationCompositionConfigLive),
  GovernedReadLayer.provide(governedApplicationCompositionSourceLive),
);

const governedActionRuntimeLive = GovernedMakeActionRuntimeLive(governedActionDeliveryUnit).pipe(
  GovernedReadLayer.provide(
    GovernedReadLayer.mergeAll(
      governedReadRuntimeDependenciesLive,
      governedModuleStateGateLive,
      GovernedActionRepositoryLive,
      GovernedActionPermissionLive,
      ActionAuthorizationPreflightDatabaseLive.pipe(GovernedReadLayer.provideMerge(GovernedCorePersistenceLive)),
      GovernedApplicationCompositionConfigLive,
    ),
  ),
);

export const governedReadApiHandlersLive = GovernedReadLayer.mergeAll(
  // <generated-governed-http-handler-layers>
  cancelOrderCommitmentActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  commitOrderActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  committedOrderApprovalEvidenceReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  completeOrderApprovalConsumptionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  completeOrderPreparationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  orderCommitmentStateReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  orderFinalizationWorkReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  preparedOrderApprovalBindingReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  preparedOrderPricingBindingReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  prepareOrderCommitmentActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  reconcileOrderApprovalActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  recordOrderProofSetActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  recordPrecommitFailureActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  revalidateOrderCommitmentActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  verifyOrderCommitmentBindingReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
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
  GovernedReadLayer.provide(configuredGatewayAssertionRedemptionDatabaseLive),
  GovernedReadLayer.provide(configuredApprovalOwnerGatewayLive),
  GovernedReadLayer.provide(configuredOrderFinalSourcesLive),
);

const operationAttributes = (operationContext: OperationContext) => {
  const attributes = {
    'modernjs.operation.id': operationContext.operationId,
    'modernjs.operation.method': operationContext.method,
    'modernjs.operation.route': operationContext.routePath,
    'modernjs.operation.source': operationContext.source,
  };
  if (operationContext.traceId === undefined) {
    return attributes;
  }
  return { ...attributes, 'modernjs.trace.id': operationContext.traceId };
};

const commerceOrderReadinessLayer = HttpApiBuilder.group(commerceOrderApi, 'foundation', (handlers) =>
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
      Effect.withSpan('ultramodern.api.commerceOrder.readiness', {
        attributes: operationAttributes(commerceOrderOperationContexts.readiness),
        kind: 'server',
      }),
    ),
  ),
);

/** The native assembly installs handlers; the owner composes actual logging and span services here. */
const runtimeObservabilityLive = GovernedReadLayer.mergeAll(
  Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
  GovernedReadLayer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
  GovernedReadLayer.succeed(References.MinimumLogLevel, 'Info'),
);

const apiHandlersLive = commerceOrderReadinessLayer;
export const makeCommerceOrderApiRuntime = (): EffectBffDefinition<typeof commerceOrderApi> &
  EffectBffRuntime<typeof commerceOrderApi> =>
  assembleEffectBffRuntime({
    api: commerceOrderApi,
    handlers: GovernedReadLayer.mergeAll(apiHandlersLive, governedReadApiHandlersLive).pipe(
      GovernedReadLayer.provide(governedApplicationCompositionSourceLive),
      GovernedReadLayer.provide(GovernedReadLayer.mergeAll(GovernedDatabaseConfigLive, nodeCryptoLayer)),
      GovernedReadLayer.provide(GovernedReadLayer.mergeAll(runtimeObservabilityLive, RequestSchemaProblemLive)),
      GovernedReadLayer.orDie,
    ),
  });
const apiRuntime: EffectBffDefinition<typeof commerceOrderApi> & EffectBffRuntime<typeof commerceOrderApi> =
  makeCommerceOrderApiRuntime();

export default apiRuntime;
