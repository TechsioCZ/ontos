import { identity } from 'effect';
import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@modern-js/bff-effect/microvertical-api';
import type { MicroVerticalOperationContext } from '@modern-js/bff-effect/microvertical-api';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';

// <generated-governed-http-api-imports>
import { CurrentMarketCatalogApi } from './apis/current-market-catalog.ts';
import { EligibleMarketTuplesApi } from './apis/eligible-market-tuples.ts';
import { MarketHistoryApi } from './apis/market-history.ts';
import { PricingCurrentMarketEvidenceApi } from './apis/pricing-current-market-evidence.ts';
import { ResolveCommerceMarketApi } from './apis/resolve-commerce-market.ts';
import { VerifyMarketEligibilityV1Api } from './apis/verify-market-eligibility-v1.ts';
// </generated-governed-http-api-imports>

export const commerceMarketCatalogMarkerSchema = Schema.Struct({
  ...MicroVerticalBuildMarkerSchema.fields,
  kind: Schema.Literal('microvertical-delivery-unit'),
  schemaVersion: Schema.Literal(1),
});
export type CommerceMarketCatalogMarker = typeof commerceMarketCatalogMarkerSchema.Type;

export const commerceMarketCatalogReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: commerceMarketCatalogMarkerSchema,
});
export type CommerceMarketCatalogReadiness = typeof commerceMarketCatalogReadinessSchema.Type;

export type OperationContext = MicroVerticalOperationContext;

export const commerceMarketCatalogFoundationApi = HttpApi.make('CommerceMarketCatalogApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/commerce-market-catalog/readiness', {
      success: commerceMarketCatalogReadinessSchema,
    }),
  ),
);

export const commerceMarketCatalogApi = HttpApi.make('CommerceMarketCatalogApi')
  .addHttpApi(commerceMarketCatalogFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(CurrentMarketCatalogApi)
  .addHttpApi(EligibleMarketTuplesApi)
  .addHttpApi(MarketHistoryApi)
  .addHttpApi(PricingCurrentMarketEvidenceApi)
  .addHttpApi(ResolveCommerceMarketApi)
  .addHttpApi(VerifyMarketEligibilityV1Api)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);

export const commerceMarketCatalogOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'CommerceMarketCatalogApi:commerceMarketCatalog:readiness',
    routePath: '/commerce-market-catalog/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const commerceMarketCatalogApiContract = {
  apiPrefix: '/commerce-market-catalog-api',
  basePath: '/commerce-market-catalog-api/commerce-market-catalog',
  ownerId: 'commerce-market-catalog',
  readinessPath: '/commerce-market-catalog-api/commerce-market-catalog/readiness',
} as const;
