import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@modern-js/bff-effect/microvertical-api';
import type { MicroVerticalOperationContext } from '@modern-js/bff-effect/microvertical-api';
// oxlint-disable-next-line typescript/consistent-type-imports -- The framework baseline requires Schema in the exact value import.
import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';
import { identity } from 'effect';
// <generated-governed-http-api-imports>
import { CurrentStorefrontApplicationApi } from './apis/current-storefront-application.ts';
// </generated-governed-http-api-imports>

export const storefrontRegistryMarkerSchema: Schema.Codec<typeof MicroVerticalBuildMarkerSchema.Type> =
  MicroVerticalBuildMarkerSchema;
export type StorefrontRegistryMarker = typeof storefrontRegistryMarkerSchema.Type;

export const storefrontRegistryReadinessSchema: Schema.Codec<typeof MicroVerticalReadinessSchema.Type> =
  MicroVerticalReadinessSchema;
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
