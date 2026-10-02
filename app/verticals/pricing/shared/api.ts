import { identity } from 'effect';
import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@modern-js/bff-effect/microvertical-api';
import type { MicroVerticalOperationContext } from '@modern-js/bff-effect/microvertical-api';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';

// <generated-governed-http-api-imports>
import { CommercialFeeDefinitionApi } from './apis/commercial-fee-definition.ts';
import { CommercialFeeResultLookupApi } from './apis/commercial-fee-result-lookup.ts';
import { CommercialFeeScheduleApi } from './apis/commercial-fee-schedule.ts';
import { ContractualDiscountResultLookupApi } from './apis/contractual-discount-result-lookup.ts';
import { CurrencySupportResultLookupApi } from './apis/currency-support-result-lookup.ts';
import { CurrentPricingDecisionApi } from './apis/current-pricing-decision.ts';
import { CurrentSupportedCurrenciesApi } from './apis/current-supported-currencies.ts';
import { DefineCommercialFeeActionApi } from './apis/define-commercial-fee-action.ts';
import { DefinePriceActionApi } from './apis/define-price-action.ts';
import { ExactPriceResolutionApi } from './apis/exact-price-resolution.ts';
import { ManageContractualDiscountActionApi } from './apis/manage-contractual-discount-action.ts';
import { ManageProductCommercialFeesBulkActionApi } from './apis/manage-product-commercial-fees-bulk-action.ts';
import { ManageProductPricesBulkActionApi } from './apis/manage-product-prices-bulk-action.ts';
import { ManageQuantityTierActionApi } from './apis/manage-quantity-tier-action.ts';
import { ManageQuotationActionApi } from './apis/manage-quotation-action.ts';
import { ManageZeroFloorAuthorizationActionApi } from './apis/manage-zero-floor-authorization-action.ts';
import { PriceDefinitionApi } from './apis/price-definition.ts';
import { PriceResultLookupApi } from './apis/price-result-lookup.ts';
import { PriceScheduleApi } from './apis/price-schedule.ts';
import { QuantityTierResultLookupApi } from './apis/quantity-tier-result-lookup.ts';
import { QuotationResultLookupApi } from './apis/quotation-result-lookup.ts';
import { ReviseCommercialFeeActionApi } from './apis/revise-commercial-fee-action.ts';
import { RevisePriceActionApi } from './apis/revise-price-action.ts';
import { SetSupportedCurrenciesActionApi } from './apis/set-supported-currencies-action.ts';
import { ZeroFloorAuthorizationResultLookupApi } from './apis/zero-floor-authorization-result-lookup.ts';
// </generated-governed-http-api-imports>

export const pricingMarkerSchema = Schema.Struct({
  ...MicroVerticalBuildMarkerSchema.fields,
  kind: Schema.Literal('microvertical-delivery-unit'),
  schemaVersion: Schema.Literal(1),
});
export type PricingMarker = typeof pricingMarkerSchema.Type;

export const pricingReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: pricingMarkerSchema,
});
export type PricingReadiness = typeof pricingReadinessSchema.Type;

export type OperationContext = MicroVerticalOperationContext;

export const pricingFoundationApi = HttpApi.make('PricingApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/pricing/readiness', {
      success: pricingReadinessSchema,
    }),
  ),
);

export {
  CurrentSupportedCurrenciesApi,
  CurrentSupportedCurrenciesAuthenticationProblemSchema,
  CurrentSupportedCurrenciesInternalProblemSchema,
  CurrentSupportedCurrenciesInvalidProblemSchema,
  CurrentSupportedCurrenciesInvalidSchema,
  CurrentSupportedCurrenciesNotFoundProblemSchema,
  CurrentSupportedCurrenciesPolicyConflictProblemSchema,
  CurrentSupportedCurrenciesPolicyProblemSchema,
  CurrentSupportedCurrenciesRequestSchema,
  CurrentSupportedCurrenciesResponseSchema,
  CurrentSupportedCurrenciesStaleSchema,
  CurrentSupportedCurrenciesSuccessSchema,
  CurrentSupportedCurrenciesUnavailableProblemSchema,
  CurrentSupportedCurrenciesUnavailableSchema,
  CurrentSupportedCurrenciesUnverifiableSchema,
  PricingCartIdSchema,
  PricingChannelIdSchema,
  PricingContextRevisionSchema,
  PricingCurrencyCodeSchema,
  PricingCurrencyCodeSetSchema,
  PricingCurrencySubjectSchema,
  PricingInstantSchema,
  PricingMarketIdSchema,
  PricingRevisionSchema,
  PricingSellingLegalEntityIdSchema,
  PricingStorefrontIdSchema,
  PricingTenantIdSchema,
} from './apis/current-supported-currencies.ts';
export type {
  CurrentSupportedCurrenciesRequest,
  CurrentSupportedCurrenciesResponse,
  CurrentSupportedCurrenciesSuccess,
  PricingCurrencySubject,
} from './apis/current-supported-currencies.ts';

export const pricingApi = HttpApi.make('PricingApi')
  .addHttpApi(pricingFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(CommercialFeeDefinitionApi)
  .addHttpApi(CommercialFeeResultLookupApi)
  .addHttpApi(CommercialFeeScheduleApi)
  .addHttpApi(ContractualDiscountResultLookupApi)
  .addHttpApi(CurrencySupportResultLookupApi)
  .addHttpApi(CurrentPricingDecisionApi)
  .addHttpApi(CurrentSupportedCurrenciesApi)
  .addHttpApi(DefineCommercialFeeActionApi)
  .addHttpApi(DefinePriceActionApi)
  .addHttpApi(ExactPriceResolutionApi)
  .addHttpApi(ManageContractualDiscountActionApi)
  .addHttpApi(ManageProductCommercialFeesBulkActionApi)
  .addHttpApi(ManageProductPricesBulkActionApi)
  .addHttpApi(ManageQuantityTierActionApi)
  .addHttpApi(ManageQuotationActionApi)
  .addHttpApi(ManageZeroFloorAuthorizationActionApi)
  .addHttpApi(PriceDefinitionApi)
  .addHttpApi(PriceResultLookupApi)
  .addHttpApi(PriceScheduleApi)
  .addHttpApi(QuantityTierResultLookupApi)
  .addHttpApi(QuotationResultLookupApi)
  .addHttpApi(ReviseCommercialFeeActionApi)
  .addHttpApi(RevisePriceActionApi)
  .addHttpApi(SetSupportedCurrenciesActionApi)
  .addHttpApi(ZeroFloorAuthorizationResultLookupApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);

export const pricingOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'PricingApi:pricing:readiness',
    routePath: '/pricing/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const pricingApiContract = {
  apiPrefix: '/pricing-api',
  basePath: '/pricing-api/pricing',
  ownerId: 'pricing',
  readinessPath: '/pricing-api/pricing/readiness',
} as const;
