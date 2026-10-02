import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import {
  ActionRuntimeLive,
  ActiveApplicationCompositionConfigLive,
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfigLive,
  ReadRuntimeLive,
  TenantModuleStateServiceLive,
} from '@app/core-runtime';
import {
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { microVerticalOperationAttributes } from '@app/shared-contracts';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import type { EffectBffRuntimeAssembly } from '@modern-js/bff-effect/assembly';
import { Effect, HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
import type { EffectBffDefinition, EffectBffRuntime, HttpRouter } from '@modern-js/bff-effect/effect-edge';
import { Layer as GovernedReadLayer, Logger, References, Tracer } from 'effect';
import { pricingApi, pricingOperationContexts } from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';
import { pricingCurrentDecisionOwnerFinalFenceGatewaysLive } from '../src/integrations/current-pricing-decision-owner-final-fence.ts';
import { pricingOrdinaryCurrentPublicationLive } from '../src/integrations/material-evidence-owner-final-fence.ts';
import { manageQuotationFreshCurrentAuthorityLive } from '../src/actions/manage-quotation.action.ts';
import { currentPricingDecisionEvaluationFactoryLive } from '../src/services/current-pricing-decision-evaluation.service.ts';
import { ExternalPriceInputBoundaryFactoryLive } from '../src/services/external-price-input-boundary.service.ts';
import { catalogSelectionGatewayCredentialLive } from './catalog-selection-gateway-credential.ts';
import { commercialContextGatewayCredentialLive } from './commercial-context-gateway-credential.ts';
import {
  commercePriceGroupResolutionGatewayCredentialLive,
  priceGroupCompatibilityGatewayCredentialLive,
} from './price-group-owner-gateway-credential.ts';
// <generated-governed-http-handler-support-imports>
import { ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive } from './auth/action-principal.ts';
import {
  GatewayAssertionRedemptionDatabaseLive as GovernedGatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive,
} from './auth/gateway-assertion-redemption.ts';
// </generated-governed-http-handler-support-imports>

// <generated-governed-http-handler-imports>
import { commercialFeeDefinitionReadApiLive } from './commercial-fee-definition-read-server.ts';
import { commercialFeeResultLookupReadApiLive } from './commercial-fee-result-lookup-read-server.ts';
import { commercialFeeScheduleReadApiLive } from './commercial-fee-schedule-read-server.ts';
import { contractualDiscountResultLookupReadApiLive } from './contractual-discount-result-lookup-read-server.ts';
import { currencySupportResultLookupReadApiLive } from './currency-support-result-lookup-read-server.ts';
import { currentPricingDecisionReadApiLive } from './current-pricing-decision-read-server.ts';
import { currentSupportedCurrenciesReadApiLive } from './current-supported-currencies-read-server.ts';
import { defineCommercialFeeActionApiLive } from './define-commercial-fee-action-server.ts';
import { definePriceActionApiLive } from './define-price-action-server.ts';
import { exactPriceResolutionReadApiLive } from './exact-price-resolution-read-server.ts';
import { manageContractualDiscountActionApiLive } from './manage-contractual-discount-action-server.ts';
import { manageProductCommercialFeesBulkActionApiLive } from './manage-product-commercial-fees-bulk-action-server.ts';
import { manageProductPricesBulkActionApiLive } from './manage-product-prices-bulk-action-server.ts';
import { manageQuantityTierActionApiLive } from './manage-quantity-tier-action-server.ts';
import { manageQuotationActionApiLive } from './manage-quotation-action-server.ts';
import { manageZeroFloorAuthorizationActionApiLive } from './manage-zero-floor-authorization-action-server.ts';
import { priceDefinitionReadApiLive } from './price-definition-read-server.ts';
import { priceResultLookupReadApiLive } from './price-result-lookup-read-server.ts';
import { priceScheduleReadApiLive } from './price-schedule-read-server.ts';
import { quantityTierResultLookupReadApiLive } from './quantity-tier-result-lookup-read-server.ts';
import { quotationResultLookupReadApiLive } from './quotation-result-lookup-read-server.ts';
import { reviseCommercialFeeActionApiLive } from './revise-commercial-fee-action-server.ts';
import { revisePriceActionApiLive } from './revise-price-action-server.ts';
import { setSupportedCurrenciesActionApiLive } from './set-supported-currencies-action-server.ts';
import { zeroFloorAuthorizationResultLookupReadApiLive } from './zero-floor-authorization-result-lookup-read-server.ts';
// </generated-governed-http-handler-imports>

const pricingReadinessLayer = HttpApiBuilder.group(pricingApi, 'foundation', (handlers) =>
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
      Effect.withSpan('ultramodern.api.pricing.readiness', {
        attributes: microVerticalOperationAttributes(pricingOperationContexts.readiness),
        kind: 'server',
      }),
    ),
  ),
);

const runtimeObservabilityLive = Layer.mergeAll(
  Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
  Layer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
  Layer.succeed(References.MinimumLogLevel, 'Info'),
);
const tenantModuleStateServiceLive = TenantModuleStateServiceLive.pipe(Layer.provide(CorePersistenceLive));
const moduleStateGateLive = ModuleStateGateLive.pipe(Layer.provide(tenantModuleStateServiceLive));
const operationalScopeResolverLive = OperationalScopeResolverLive.pipe(
  Layer.provide(Layer.mergeAll(CorePersistenceLive, ContextAccessLive)),
);
const moduleEntrypointGatewayLive = ModuleEntrypointGatewayLive.pipe(Layer.provide(moduleStateGateLive));
const pricingActionRuntimeLive = ActionRuntimeLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      CorePersistenceLive,
      ActionRepositoryLive,
      ActionPermissionLive,
      ContextAccessLive,
      moduleStateGateLive,
      moduleEntrypointGatewayLive,
      operationalScopeResolverLive,
    ),
  ),
  Layer.provide(DatabaseConfigLive),
);
/** Production Action composition with server-owned owner-client credential issuers. */
export const productionActionRuntimeLive = pricingActionRuntimeLive.pipe(
  Layer.provideMerge(ExternalPriceInputBoundaryFactoryLive),
  Layer.provideMerge(manageQuotationFreshCurrentAuthorityLive),
  Layer.provideMerge(currentPricingDecisionEvaluationFactoryLive),
  Layer.provideMerge(pricingOrdinaryCurrentPublicationLive),
  Layer.provideMerge(pricingCurrentDecisionOwnerFinalFenceGatewaysLive),
  Layer.provideMerge(
    Layer.mergeAll(
      catalogSelectionGatewayCredentialLive,
      commercePriceGroupResolutionGatewayCredentialLive,
      commercialContextGatewayCredentialLive,
      priceGroupCompatibilityGatewayCredentialLive,
    ),
  ),
);
const governedActionRuntimeLive = productionActionRuntimeLive;
const actionPrincipalVerifierLive = GovernedActionPrincipalVerifierLive.pipe(Layer.provide(governedActionRuntimeLive));
const readRuntimeDependenciesLive = Layer.mergeAll(
  CorePersistenceLive,
  ContextAccessLive,
  moduleEntrypointGatewayLive,
  operationalScopeResolverLive,
);
const readRuntimeLive = ReadRuntimeLive.pipe(
  Layer.provide(readRuntimeDependenciesLive),
  Layer.provide(DatabaseConfigLive),
);
const governedReadRuntimeLive = readRuntimeLive;
const pricingGatewayAssertionRedemptionDatabaseLive = GovernedGatewayAssertionRedemptionDatabaseLive.pipe(
  Layer.provide(DatabaseConfigLive),
);

export const governedReadApiHandlersLive = Layer.mergeAll(
  pricingReadinessLayer,
  // <generated-governed-http-handler-layers>
  commercialFeeDefinitionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  commercialFeeResultLookupReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  commercialFeeScheduleReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  contractualDiscountResultLookupReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  currencySupportResultLookupReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  currentPricingDecisionReadApiLive.pipe(
    GovernedReadLayer.provide(governedReadRuntimeLive),
    Layer.provide(currentPricingDecisionEvaluationFactoryLive),
    Layer.provide(pricingOrdinaryCurrentPublicationLive),
    Layer.provide(pricingCurrentDecisionOwnerFinalFenceGatewaysLive),
    Layer.provide(commercePriceGroupResolutionGatewayCredentialLive),
  ),
  currentSupportedCurrenciesReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  defineCommercialFeeActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  definePriceActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  exactPriceResolutionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  manageContractualDiscountActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  manageProductCommercialFeesBulkActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  manageProductPricesBulkActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  manageQuantityTierActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  manageQuotationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  manageZeroFloorAuthorizationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  priceDefinitionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  priceResultLookupReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  priceScheduleReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  quantityTierResultLookupReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  quotationResultLookupReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  reviseCommercialFeeActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  revisePriceActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  setSupportedCurrenciesActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  zeroFloorAuthorizationResultLookupReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  // </generated-governed-http-handler-layers>
).pipe(
  // <generated-governed-http-handler-support-layers>
  GovernedReadLayer.provide(
    GovernedReadLayer.mergeAll(actionPrincipalVerifierLive, GovernedGatewayAssertionRedemptionLive),
  ),
  // </generated-governed-http-handler-support-layers>
  GovernedReadLayer.provide(pricingGatewayAssertionRedemptionDatabaseLive),
  GovernedReadLayer.provide(ActiveApplicationCompositionConfigLive),
);
type PricingApiGroups = (typeof pricingApi.groups)[keyof typeof pricingApi.groups];
type PricingHandlerRequirements =
  | (typeof governedReadApiHandlersLive extends Layer.Layer<infer _Services, infer _Error, infer Requirements>
      ? Requirements
      : never)
  | HttpRouter.HttpRouter;
const resolvedApiHandlersLive: EffectBffRuntimeAssembly<
  'PricingApi',
  PricingApiGroups,
  PricingHandlerRequirements
>['handlers'] = governedReadApiHandlersLive.pipe(
  Layer.provide(Layer.mergeAll(runtimeObservabilityLive, RequestSchemaProblemLive)),
  Layer.orDie,
);

export const makePricingApiRuntime = (): EffectBffDefinition<typeof pricingApi> & EffectBffRuntime<typeof pricingApi> =>
  assembleEffectBffRuntime({
    api: pricingApi,
    handlers: resolvedApiHandlersLive,
  });

const apiRuntime: EffectBffDefinition<typeof pricingApi> & EffectBffRuntime<typeof pricingApi> =
  makePricingApiRuntime();

export default apiRuntime;
