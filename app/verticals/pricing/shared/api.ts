import { identity } from 'effect';
import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@modern-js/bff-effect/microvertical-api';
import type { MicroVerticalOperationContext } from '@modern-js/bff-effect/microvertical-api';
// oxlint-disable-next-line typescript/consistent-type-imports -- The framework baseline requires Schema in the exact value import.
import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';

// <generated-governed-http-api-imports>
import { CurrentSupportedCurrenciesApi } from './apis/current-supported-currencies.ts';
// </generated-governed-http-api-imports>

export const pricingMarkerSchema: Schema.Codec<typeof MicroVerticalBuildMarkerSchema.Type> =
  MicroVerticalBuildMarkerSchema;
export type PricingMarker = typeof pricingMarkerSchema.Type;

export const pricingReadinessSchema: Schema.Codec<typeof MicroVerticalReadinessSchema.Type> =
  MicroVerticalReadinessSchema;
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
  .addHttpApi(CurrentSupportedCurrenciesApi)
  // </generated-governed-http-api-additions>
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
