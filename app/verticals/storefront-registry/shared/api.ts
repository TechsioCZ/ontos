import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@modern-js/bff-effect/microvertical-api';
import type { MicroVerticalOperationContext } from '@modern-js/bff-effect/microvertical-api';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';
import { identity } from 'effect';
// <generated-governed-http-api-imports>
import { CurrentStorefrontApplicationApi } from './apis/current-storefront-application.ts';
// </generated-governed-http-api-imports>

export const storefrontRegistryMarkerSchema = Schema.Struct({
  ...MicroVerticalBuildMarkerSchema.fields,
  kind: Schema.Literal('microvertical-delivery-unit'),
  schemaVersion: Schema.Literal(1),
});
export type StorefrontRegistryMarker = typeof storefrontRegistryMarkerSchema.Type;

export const storefrontRegistryReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: storefrontRegistryMarkerSchema,
});
export type StorefrontRegistryReadiness = typeof storefrontRegistryReadinessSchema.Type;

export type OperationContext = MicroVerticalOperationContext;

export const storefrontRegistryFoundationApi = HttpApi.make('StorefrontRegistryApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/storefront-registry/readiness', {
      success: storefrontRegistryReadinessSchema,
    }),
  ),
);

export const storefrontRegistryApi = HttpApi.make('StorefrontRegistryApi')
  .addHttpApi(storefrontRegistryFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(CurrentStorefrontApplicationApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);

export const storefrontRegistryOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'StorefrontRegistryApi:storefrontRegistry:readiness',
    routePath: '/storefront-registry/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const storefrontRegistryApiContract = {
  apiPrefix: '/storefront-registry-api',
  basePath: '/storefront-registry-api/storefront-registry',
  ownerId: 'storefront-registry',
  readinessPath: '/storefront-registry-api/storefront-registry/readiness',
} as const;
