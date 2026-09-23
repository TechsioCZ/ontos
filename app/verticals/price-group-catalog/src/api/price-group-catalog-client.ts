/* eslint-disable oxc/no-barrel-file, sonarjs/no-wildcard-import -- This generated package API is the intentional aggregate for owner Action and governed Read clients; expires: 2027-03-31. */
import { Effect, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import type {
  HttpClientError,
  HttpApi,
  HttpApiClient,
  HttpApiGroup,
  Schema,
} from '@modern-js/bff-effect/effect-client';

import {
  priceGroupCatalogApiContract,
  priceGroupCatalogApi,
  priceGroupCatalogOperationContexts,
} from '../../shared/api.ts';
import type { PriceGroupCatalogNotFound, OperationContext, PriceGroupCatalogReadiness } from '../../shared/api.ts';

// oxlint-disable-next-line effect-native/no-scattered-browser-effect-run -- This generated public compatibility surface must retain its existing runner export until route consumers migrate to the centralized browser runtime.
export { Effect, runEffectRequest } from '@modern-js/bff-effect/effect-client';
// <generated-action-http-client-exports>
export * from './create-price-group-action-client.ts';
export * from './create-price-group-definition-revision-action-client.ts';
export * from './retire-price-group-action-client.ts';
// </generated-action-http-client-exports>
export {
  executePriceGroupDefinition,
  executePriceGroupDefinitionWithAuthorization,
} from './price-group-definition-client.ts';
export type { PriceGroupDefinitionClientOptions } from './price-group-definition-client.ts';
export {
  executeValidatePriceGroupCompatibility,
  executeValidatePriceGroupCompatibilityWithAuthorization,
} from './validate-price-group-compatibility-client.ts';
export type { ValidatePriceGroupCompatibilityClientOptions } from './validate-price-group-compatibility-client.ts';
export {
  PriceGroupDefinitionRequestSchema,
  PriceGroupDefinitionResponseSchema,
} from '../../shared/apis/price-group-definition.ts';
export {
  ValidatePriceGroupCompatibilityRequestSchema,
  ValidatePriceGroupCompatibilityResponseSchema,
} from '../../shared/apis/validate-price-group-compatibility.ts';
export type {
  PriceGroupDefinitionRequest,
  PriceGroupDefinitionResponse,
} from '../../shared/apis/price-group-definition.ts';
export type {
  ValidatePriceGroupCompatibilityRequest,
  ValidatePriceGroupCompatibilityResponse,
} from '../../shared/apis/validate-price-group-compatibility.ts';

type PriceGroupCatalogApiGroups =
  typeof priceGroupCatalogApi extends HttpApi.HttpApi<infer _ApiId, infer Groups> ? Groups : never;

export type PriceGroupCatalogClient = HttpApiClient.Client<
  Extract<PriceGroupCatalogApiGroups, HttpApiGroup.Constraint>
>;

export type PriceGroupCatalogClientError =
  | PriceGroupCatalogNotFound
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

export type PriceGroupCatalogClientEffect<Success> = Effect.Effect<Success, PriceGroupCatalogClientError>;

export interface PriceGroupCatalogClientOptions {
  baseUrl?: string | URL;
  locale?: string;
  operationContext?: OperationContext;
  // oxlint-disable-next-line effect-native/no-threaded-correlation-parameter -- This public option is the caller-provided W3C wire header consumed by the generated HTTP transport, not ambient application state.
  traceparent?: string;
}

export const createPriceGroupCatalogClient = (
  options: PriceGroupCatalogClientOptions = {},
): PriceGroupCatalogClientEffect<PriceGroupCatalogClient> => {
  const baseUrl = options.baseUrl ?? priceGroupCatalogApiContract.apiPrefix;
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
  // oxlint-disable-next-line effect-native/no-per-operation-http-api-client -- This generated public factory intentionally binds caller-specific base URL and request metadata for one operation; sharing it would alter API and header lifetime.
  return makeEffectHttpApiClient(priceGroupCatalogApi, {
    baseUrl,
    requestContext,
  });
};

export const getPriceGroupCatalogReadiness = (
  options: PriceGroupCatalogClientOptions = {},
): PriceGroupCatalogClientEffect<PriceGroupCatalogReadiness> =>
  // oxlint-disable-next-line effect-native/no-per-operation-http-api-client -- This generated public wrapper delegates caller-specific base URL and request metadata without introducing shared cross-request state.
  createPriceGroupCatalogClient({
    ...options,
    operationContext: options.operationContext ?? priceGroupCatalogOperationContexts.readiness,
  }).pipe(Effect.flatMap((client) => client.foundation.readiness({})));
