import { Effect, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import type {
  HttpApi,
  HttpApiClient,
  HttpApiGroup,
  HttpClientError,
  Schema,
} from '@modern-js/bff-effect/effect-client';
import { pricingApi, pricingApiContract, pricingOperationContexts } from '../../shared/api.ts';
import type { OperationContext, PricingReadiness } from '../../shared/api.ts';

// oxlint-disable-next-line effect-native/no-scattered-browser-effect-run -- Generated compatibility surface retained for existing callers.
export { Effect, runEffectRequest } from '@modern-js/bff-effect/effect-client';
// <generated-action-http-client-exports>
export * from './define-commercial-fee-action-client.ts';
export * from './define-price-action-client.ts';
export * from './manage-contractual-discount-action-client.ts';
export * from './manage-product-commercial-fees-bulk-action-client.ts';
export * from './manage-product-prices-bulk-action-client.ts';
export * from './manage-quantity-tier-action-client.ts';
export * from './manage-quotation-action-client.ts';
export * from './manage-zero-floor-authorization-action-client.ts';
export * from './revise-commercial-fee-action-client.ts';
export * from './revise-price-action-client.ts';
export * from './set-supported-currencies-action-client.ts';
// </generated-action-http-client-exports>
export {
  executeCurrentSupportedCurrencies,
  executeCurrentSupportedCurrenciesWithAuthorization,
} from './current-supported-currencies-client.ts';
export type { CurrentSupportedCurrenciesClientOptions } from './current-supported-currencies-client.ts';
export {
  executeCommercialFeeDefinition,
  executeCommercialFeeDefinitionWithAuthorization,
} from './commercial-fee-definition-client.ts';
export type { CommercialFeeDefinitionClientOptions } from './commercial-fee-definition-client.ts';
export {
  executeCommercialFeeResultLookup,
  executeCommercialFeeResultLookupWithAuthorization,
} from './commercial-fee-result-lookup-client.ts';
export type { CommercialFeeResultLookupClientOptions } from './commercial-fee-result-lookup-client.ts';
export {
  CommercialFeeDefinitionRequestSchema,
  CommercialFeeDefinitionResponseSchema,
} from '../../shared/apis/commercial-fee-definition.ts';
export type {
  CommercialFeeDefinitionRequest,
  CommercialFeeDefinitionResponse,
} from '../../shared/apis/commercial-fee-definition.ts';
export { executePriceDefinition, executePriceDefinitionWithAuthorization } from './price-definition-client.ts';
export type { PriceDefinitionClientOptions } from './price-definition-client.ts';
export { PriceDefinitionRequestSchema, PriceDefinitionResponseSchema } from '../../shared/apis/price-definition.ts';
export type { PriceDefinitionRequest, PriceDefinitionResponse } from '../../shared/apis/price-definition.ts';
export {
  executeCommercialFeeSchedule,
  executeCommercialFeeScheduleWithAuthorization,
} from './commercial-fee-schedule-client.ts';
export type { CommercialFeeScheduleClientOptions } from './commercial-fee-schedule-client.ts';
export {
  CommercialFeeScheduleRequestSchema,
  CommercialFeeScheduleResponseSchema,
} from '../../shared/apis/commercial-fee-schedule.ts';
export type {
  CommercialFeeScheduleRequest,
  CommercialFeeScheduleResponse,
} from '../../shared/apis/commercial-fee-schedule.ts';
export {
  executeContractualDiscountResultLookup,
  executeContractualDiscountResultLookupWithAuthorization,
} from './contractual-discount-result-lookup-client.ts';
export type { ContractualDiscountResultLookupClientOptions } from './contractual-discount-result-lookup-client.ts';
export {
  executeCurrencySupportResultLookup,
  executeCurrencySupportResultLookupWithAuthorization,
} from './currency-support-result-lookup-client.ts';
export type { CurrencySupportResultLookupClientOptions } from './currency-support-result-lookup-client.ts';
export {
  executeCurrentPricingDecision,
  executeCurrentPricingDecisionWithAuthorization,
} from './current-pricing-decision-client.ts';
export type { CurrentPricingDecisionClientOptions } from './current-pricing-decision-client.ts';
export { executePriceResultLookup, executePriceResultLookupWithAuthorization } from './price-result-lookup-client.ts';
export type { PriceResultLookupClientOptions } from './price-result-lookup-client.ts';
export { executePriceSchedule, executePriceScheduleWithAuthorization } from './price-schedule-client.ts';
export type { PriceScheduleClientOptions } from './price-schedule-client.ts';
export {
  executeQuantityTierResultLookup,
  executeQuantityTierResultLookupWithAuthorization,
} from './quantity-tier-result-lookup-client.ts';
export type { QuantityTierResultLookupClientOptions } from './quantity-tier-result-lookup-client.ts';
export {
  executeQuotationResultLookup,
  executeQuotationResultLookupWithAuthorization,
} from './quotation-result-lookup-client.ts';
export type { QuotationResultLookupClientOptions } from './quotation-result-lookup-client.ts';
export {
  executeZeroFloorAuthorizationResultLookup,
  executeZeroFloorAuthorizationResultLookupWithAuthorization,
} from './zero-floor-authorization-result-lookup-client.ts';
export type { ZeroFloorAuthorizationResultLookupClientOptions } from './zero-floor-authorization-result-lookup-client.ts';
export { CurrentSupportedCurrenciesRequestSchema, CurrentSupportedCurrenciesResponseSchema } from '../../shared/api.ts';
export type { CurrentSupportedCurrenciesRequest, CurrentSupportedCurrenciesResponse } from '../../shared/api.ts';

type PricingApiGroups = typeof pricingApi extends HttpApi.HttpApi<infer _ApiId, infer Groups> ? Groups : never;
export type PricingClient = HttpApiClient.Client<Extract<PricingApiGroups, HttpApiGroup.Constraint>>;
export type PricingClientError = HttpClientError.HttpClientError | Schema.SchemaError;
export type PricingClientEffect<Success> = Effect.Effect<Success, PricingClientError>;

export interface PricingClientOptions {
  readonly baseUrl?: string | URL;
  readonly locale?: string;
  readonly operationContext?: OperationContext;
  // oxlint-disable-next-line effect-native/no-threaded-correlation-parameter -- This public option is the caller-provided W3C wire header consumed by the generated HTTP transport; remove-when: the framework client accepts an ambient request context.
  readonly traceparent?: string;
}

export const createPricingClient = (options: PricingClientOptions = {}): PricingClientEffect<PricingClient> => {
  const requestContext = {};
  if (options.locale !== undefined) {
    Object.assign(requestContext, { locale: options.locale });
  }
  if (options.operationContext !== undefined) {
    Object.assign(requestContext, { operationContext: options.operationContext });
  }
  if (options.traceparent !== undefined) {
    Object.assign(requestContext, { traceparent: options.traceparent });
  }
  // oxlint-disable-next-line effect-native/no-per-operation-http-api-client -- Generated public factory binds caller-specific request metadata.
  return makeEffectHttpApiClient(pricingApi, {
    baseUrl: options.baseUrl ?? pricingApiContract.apiPrefix,
    requestContext,
  });
};

export const getPricingReadiness = (options: PricingClientOptions = {}): PricingClientEffect<PricingReadiness> =>
  // oxlint-disable-next-line effect-native/no-per-operation-http-api-client -- Generated wrapper delegates caller-specific request metadata.
  createPricingClient({
    ...options,
    operationContext: options.operationContext ?? pricingOperationContexts.readiness,
  }).pipe(Effect.flatMap((client) => client.foundation.readiness({})));
