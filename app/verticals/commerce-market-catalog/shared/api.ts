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
import { CurrentMarketCatalogApi } from './apis/current-market-catalog.ts';
import { EligibleMarketTuplesApi } from './apis/eligible-market-tuples.ts';
import { MarketHistoryApi } from './apis/market-history.ts';
import { ResolveCommerceMarketApi } from './apis/resolve-commerce-market.ts';
// </generated-governed-http-api-imports>

export const commerceMarketCatalogMarkerSchema: Schema.Codec<typeof MicroVerticalBuildMarkerSchema.Type> =
  MicroVerticalBuildMarkerSchema;
export type CommerceMarketCatalogMarker = typeof commerceMarketCatalogMarkerSchema.Type;

export const commerceMarketCatalogReadinessSchema: Schema.Codec<typeof MicroVerticalReadinessSchema.Type> =
  MicroVerticalReadinessSchema;
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
  .addHttpApi(ResolveCommerceMarketApi)
  // </generated-governed-http-api-additions>
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
