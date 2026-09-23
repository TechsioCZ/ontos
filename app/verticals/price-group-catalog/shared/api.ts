import { identity } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, Schema } from '@modern-js/bff-effect/effect-client';
import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@modern-js/bff-effect/microvertical-api';
import type { MicroVerticalOperationContext } from '@modern-js/bff-effect/microvertical-api';

// <generated-governed-http-api-imports>
import { CreatePriceGroupActionApi } from './apis/create-price-group-action.ts';
import { CreatePriceGroupDefinitionRevisionActionApi } from './apis/create-price-group-definition-revision-action.ts';
import { PriceGroupDefinitionApi } from './apis/price-group-definition.ts';
import { RetirePriceGroupActionApi } from './apis/retire-price-group-action.ts';
import { ValidatePriceGroupCompatibilityApi } from './apis/validate-price-group-compatibility.ts';
// </generated-governed-http-api-imports>

export const priceGroupCatalogMarkerSchema = MicroVerticalBuildMarkerSchema;
export type PriceGroupCatalogMarker = typeof priceGroupCatalogMarkerSchema.Type;

export const priceGroupCatalogItemSchema = Schema.Struct({
  id: Schema.String,
  marker: priceGroupCatalogMarkerSchema,
  title: Schema.String,
});
export type PriceGroupCatalogItem = typeof priceGroupCatalogItemSchema.Type;

export const priceGroupCatalogReadinessSchema = MicroVerticalReadinessSchema;
export type PriceGroupCatalogReadiness = typeof priceGroupCatalogReadinessSchema.Type;

export const priceGroupCatalogCreatePayloadSchema = Schema.Struct({
  title: Schema.String,
});
export type PriceGroupCatalogCreatePayload = typeof priceGroupCatalogCreatePayloadSchema.Type;

export interface PriceGroupCatalogListResponse {
  readonly items: readonly PriceGroupCatalogItem[];
}

export interface PriceGroupCatalogCreateResponse {
  readonly item: PriceGroupCatalogItem;
}

export const priceGroupCatalogNotFoundSchema = Schema.TaggedStruct('PriceGroupCatalogNotFound', {
  id: Schema.String,
}).pipe(HttpApiSchema.status(404));
export type PriceGroupCatalogNotFound = typeof priceGroupCatalogNotFoundSchema.Type;

export type OperationContext = MicroVerticalOperationContext;

export const priceGroupCatalogFoundationApi = HttpApi.make('PriceGroupCatalogApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/price-group-catalog/readiness', {
      success: priceGroupCatalogReadinessSchema,
    }),
  ),
);

export const priceGroupCatalogApi = HttpApi.make('PriceGroupCatalogApi')
  .addHttpApi(priceGroupCatalogFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(CreatePriceGroupActionApi)
  .addHttpApi(CreatePriceGroupDefinitionRevisionActionApi)
  .addHttpApi(PriceGroupDefinitionApi)
  .addHttpApi(RetirePriceGroupActionApi)
  .addHttpApi(ValidatePriceGroupCompatibilityApi)
  // </generated-governed-http-api-additions>
  .pipe(identity);

export const priceGroupCatalogOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'PriceGroupCatalogApi:priceGroupCatalog:readiness',
    routePath: '/price-group-catalog/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const priceGroupCatalogApiContract = {
  apiPrefix: '/price-group-catalog-api',
  basePath: '/price-group-catalog-api/price-group-catalog',
  ownerId: 'price-group-catalog',
  readinessPath: '/price-group-catalog-api/price-group-catalog/readiness',
} as const;
