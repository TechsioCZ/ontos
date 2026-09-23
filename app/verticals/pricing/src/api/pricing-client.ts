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
export {
  executeCurrentSupportedCurrencies,
  executeCurrentSupportedCurrenciesWithAuthorization,
} from './current-supported-currencies-client.ts';
export type { CurrentSupportedCurrenciesClientOptions } from './current-supported-currencies-client.ts';
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
