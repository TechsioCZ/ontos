import { Effect, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import type {
  HttpClientError,
  HttpApi,
  HttpApiClient,
  HttpApiGroup,
  Schema,
} from '@modern-js/bff-effect/effect-client';

import {
  commerceMarketCatalogApiContract,
  commerceMarketCatalogApi,
  commerceMarketCatalogOperationContexts,
} from '../../shared/api.ts';
import type { OperationContext, CommerceMarketCatalogReadiness } from '../../shared/api.ts';
import { executeCurrentMarketCatalog } from './current-market-catalog-client.ts';
import { executeEligibleMarketTuples } from './eligible-market-tuples-client.ts';
import { executeMarketHistory } from './market-history-client.ts';
import { executeResolveCommerceMarket } from './resolve-commerce-market-client.ts';

// oxlint-disable-next-line effect-native/no-scattered-browser-effect-run -- This generated public compatibility surface remains until the vertical adds a centralized browser runtime.
export { Effect, runEffectRequest } from '@modern-js/bff-effect/effect-client';
export {
  CurrentMarketCatalogApi,
  CurrentMarketCatalogAuthenticationProblemSchema,
  CurrentMarketCatalogForbiddenProblemSchema,
  CurrentMarketCatalogInternalProblemSchema,
  CurrentMarketCatalogInvalidProblemSchema,
  CurrentMarketCatalogNotFoundProblemSchema,
  CurrentMarketCatalogPolicyConflictProblemSchema,
  CurrentMarketCatalogPolicyProblemSchema,
  CurrentMarketCatalogRequestSchema,
  CurrentMarketCatalogResponseSchema,
  CurrentMarketCatalogUnavailableProblemSchema,
} from '../../shared/apis/current-market-catalog.ts';
export type {
  CurrentMarketCatalogRequest,
  CurrentMarketCatalogResponse,
} from '../../shared/apis/current-market-catalog.ts';
export {
  EligibleMarketTuplesApi,
  EligibleMarketTuplesAuthenticationProblemSchema,
  EligibleMarketTuplesForbiddenProblemSchema,
  EligibleMarketTuplesInternalProblemSchema,
  EligibleMarketTuplesInvalidProblemSchema,
  EligibleMarketTuplesNotFoundProblemSchema,
  EligibleMarketTuplesPolicyConflictProblemSchema,
  EligibleMarketTuplesPolicyProblemSchema,
  EligibleMarketTuplesRequestSchema,
  EligibleMarketTuplesResponseSchema,
  EligibleMarketTuplesUnavailableProblemSchema,
} from '../../shared/apis/eligible-market-tuples.ts';
export type {
  EligibleMarketTuplesRequest,
  EligibleMarketTuplesResponse,
} from '../../shared/apis/eligible-market-tuples.ts';
export {
  MarketHistoryApi,
  MarketHistoryAuthenticationProblemSchema,
  MarketHistoryForbiddenProblemSchema,
  MarketHistoryInternalProblemSchema,
  MarketHistoryInvalidProblemSchema,
  MarketHistoryNotFoundProblemSchema,
  MarketHistoryPolicyConflictProblemSchema,
  MarketHistoryPolicyProblemSchema,
  MarketHistoryRequestSchema,
  MarketHistoryResponseSchema,
  MarketHistoryUnavailableProblemSchema,
} from '../../shared/apis/market-history.ts';
export type { MarketHistoryRequest, MarketHistoryResponse } from '../../shared/apis/market-history.ts';
export {
  ResolveCommerceMarketApi,
  ResolveCommerceMarketAuthenticationProblemSchema,
  ResolveCommerceMarketForbiddenProblemSchema,
  ResolveCommerceMarketInternalProblemSchema,
  ResolveCommerceMarketInvalidProblemSchema,
  ResolveCommerceMarketNotFoundProblemSchema,
  ResolveCommerceMarketPolicyConflictProblemSchema,
  ResolveCommerceMarketPolicyProblemSchema,
  ResolveCommerceMarketRequestSchema,
  ResolveCommerceMarketResponseSchema,
  ResolveCommerceMarketUnavailableProblemSchema,
} from '../../shared/apis/resolve-commerce-market.ts';
export type {
  ResolveCommerceMarketRequest,
  ResolveCommerceMarketResponse,
} from '../../shared/apis/resolve-commerce-market.ts';
export {
  executeCurrentMarketCatalog,
  executeCurrentMarketCatalogWithAuthorization,
} from './current-market-catalog-client.ts';
export type { CurrentMarketCatalogClientOptions } from './current-market-catalog-client.ts';
export {
  executeEligibleMarketTuples,
  executeEligibleMarketTuplesWithAuthorization,
} from './eligible-market-tuples-client.ts';
export type { EligibleMarketTuplesClientOptions } from './eligible-market-tuples-client.ts';
export { executeMarketHistory, executeMarketHistoryWithAuthorization } from './market-history-client.ts';
export type { MarketHistoryClientOptions } from './market-history-client.ts';
export {
  executeResolveCommerceMarket,
  executeResolveCommerceMarketWithAuthorization,
} from './resolve-commerce-market-client.ts';
export type { ResolveCommerceMarketClientOptions } from './resolve-commerce-market-client.ts';

type CommerceMarketCatalogApiGroups =
  typeof commerceMarketCatalogApi extends HttpApi.HttpApi<infer _ApiId, infer Groups> ? Groups : never;

export type CommerceMarketCatalogClient = HttpApiClient.Client<
  Extract<CommerceMarketCatalogApiGroups, HttpApiGroup.Constraint>
>;

export type CommerceMarketCatalogClientError = HttpClientError.HttpClientError | Schema.SchemaError;

export type CommerceMarketCatalogClientEffect<Success> = Effect.Effect<Success, CommerceMarketCatalogClientError>;

export interface CommerceMarketCatalogClientOptions {
  baseUrl?: string | URL;
  locale?: string;
  operationContext?: OperationContext;
  // oxlint-disable-next-line effect-native/no-threaded-correlation-parameter -- This public option is the caller-provided W3C wire header consumed by the generated HTTP transport.
  traceparent?: string;
}

export const createCommerceMarketCatalogClient = (
  options: CommerceMarketCatalogClientOptions = {},
): CommerceMarketCatalogClientEffect<CommerceMarketCatalogClient> => {
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
  return makeEffectHttpApiClient(commerceMarketCatalogApi, {
    baseUrl: options.baseUrl ?? commerceMarketCatalogApiContract.apiPrefix,
    requestContext,
  });
};

export const getCommerceMarketCatalogReadiness = (
  options: CommerceMarketCatalogClientOptions = {},
): CommerceMarketCatalogClientEffect<CommerceMarketCatalogReadiness> =>
  // oxlint-disable-next-line effect-native/no-per-operation-http-api-client -- The generated public wrapper delegates caller-specific request metadata without shared cross-request state.
  createCommerceMarketCatalogClient({
    ...options,
    operationContext: options.operationContext ?? commerceMarketCatalogOperationContexts.readiness,
  }).pipe(Effect.flatMap((client) => client.foundation.readiness({})));

export interface CommerceMarketCatalogOperationsClient {
  readonly executeCurrentMarketCatalog: typeof executeCurrentMarketCatalog;
  readonly executeEligibleMarketTuples: typeof executeEligibleMarketTuples;
  readonly executeMarketHistory: typeof executeMarketHistory;
  readonly executeResolveCommerceMarket: typeof executeResolveCommerceMarket;
  readonly getCommerceMarketCatalogReadiness: typeof getCommerceMarketCatalogReadiness;
}

export const commerceMarketCatalogClient = {
  executeCurrentMarketCatalog,
  executeEligibleMarketTuples,
  executeMarketHistory,
  executeResolveCommerceMarket,
  getCommerceMarketCatalogReadiness,
} satisfies CommerceMarketCatalogOperationsClient;
