import { Effect, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import type {
  HttpClientError,
  HttpApi,
  HttpApiClient,
  HttpApiGroup,
  Schema,
} from '@modern-js/bff-effect/effect-client';

import {
  storefrontRegistryApi,
  storefrontRegistryApiContract,
  storefrontRegistryOperationContexts,
} from '../../shared/api.ts';
import type { OperationContext, StorefrontRegistryReadiness } from '../../shared/api.ts';

// oxlint-disable-next-line effect-native/no-scattered-browser-effect-run -- This generated public compatibility surface remains until the vertical adds a centralized browser runtime.
export { Effect, runEffectRequest } from '@modern-js/bff-effect/effect-client';
export {
  executeCurrentStorefrontApplication,
  executeCurrentStorefrontApplicationWithAuthorization,
} from './current-storefront-application-client.ts';

type StorefrontRegistryApiGroups =
  typeof storefrontRegistryApi extends HttpApi.HttpApi<infer _ApiId, infer Groups> ? Groups : never;

export type StorefrontRegistryClient = HttpApiClient.Client<
  Extract<StorefrontRegistryApiGroups, HttpApiGroup.Constraint>
>;

export type StorefrontRegistryClientError = HttpClientError.HttpClientError | Schema.SchemaError;
export type StorefrontRegistryClientEffect<Success> = Effect.Effect<Success, StorefrontRegistryClientError>;

export interface StorefrontRegistryClientOptions {
  baseUrl?: string | URL;
  locale?: string;
  operationContext?: OperationContext;
  // oxlint-disable-next-line effect-native/no-threaded-correlation-parameter -- This public option is the caller-provided W3C wire header consumed by the generated HTTP transport.
  traceparent?: string;
}

export const createStorefrontRegistryClient = (
  options: StorefrontRegistryClientOptions = {},
): StorefrontRegistryClientEffect<StorefrontRegistryClient> => {
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
  // oxlint-disable-next-line effect-native/no-per-operation-http-api-client -- The generated public factory binds caller-specific base URL and request metadata for one operation.
  return makeEffectHttpApiClient(storefrontRegistryApi, {
    baseUrl: options.baseUrl ?? storefrontRegistryApiContract.apiPrefix,
    requestContext,
  });
};

export const getStorefrontRegistryReadiness = (
  options: StorefrontRegistryClientOptions = {},
): StorefrontRegistryClientEffect<StorefrontRegistryReadiness> =>
  // oxlint-disable-next-line effect-native/no-per-operation-http-api-client -- The generated public wrapper delegates caller-specific request metadata without shared cross-request state.
  createStorefrontRegistryClient({
    ...options,
    operationContext: options.operationContext ?? storefrontRegistryOperationContexts.readiness,
  }).pipe(Effect.flatMap((client) => client.foundation.readiness({})));
