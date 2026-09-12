import { Effect, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import type {
  HttpClientError,
  HttpApi,
  HttpApiClient,
  HttpApiGroup,
  Schema,
} from '@modern-js/bff-effect/effect-client';

import {
  paymentTermCatalogApiContract,
  paymentTermCatalogApi,
  paymentTermCatalogOperationContexts,
} from '../../shared/api.ts';
import type { OperationContext, PaymentTermCatalogReadiness } from '../../shared/api.ts';

// oxlint-disable-next-line effect-native/no-scattered-browser-effect-run -- This generated public compatibility surface must retain its existing runner export until route consumers migrate to the centralized browser runtime.
export { Effect, runEffectRequest } from '@modern-js/bff-effect/effect-client';
// <generated-action-http-client-exports>
export * from './correct-payment-term-action-client.ts';
export * from './create-payment-term-action-client.ts';
export * from './reconcile-payment-term-reference-action-client.ts';
export * from './retire-payment-term-action-client.ts';
// </generated-action-http-client-exports>
export * from './current-payment-terms-client.ts';
export * from './payment-term-history-client.ts';
export {
  CurrentPaymentTermsRequestSchema,
  CurrentPaymentTermsResponseSchema,
  PaymentTermHistoryRequestSchema,
  PaymentTermHistoryResponseSchema,
} from '../../shared/api.ts';
export type {
  CurrentPaymentTermsRequest,
  CurrentPaymentTermsResponse,
  PaymentTermHistoryRequest,
  PaymentTermHistoryResponse,
} from '../../shared/api.ts';

type PaymentTermCatalogApiGroups =
  typeof paymentTermCatalogApi extends HttpApi.HttpApi<infer _ApiId, infer Groups> ? Groups : never;

export type PaymentTermCatalogClient = HttpApiClient.Client<
  Extract<PaymentTermCatalogApiGroups, HttpApiGroup.Constraint>
>;

export type PaymentTermCatalogClientError = HttpClientError.HttpClientError | Schema.SchemaError;

export type PaymentTermCatalogClientEffect<Success> = Effect.Effect<Success, PaymentTermCatalogClientError>;

export interface PaymentTermCatalogClientOptions {
  baseUrl?: string | URL;
  locale?: string;
  operationContext?: OperationContext;
  // oxlint-disable-next-line effect-native/no-threaded-correlation-parameter -- This public option is the caller-provided W3C wire header consumed by the generated HTTP transport, not ambient application state.
  traceparent?: string;
}

export const createPaymentTermCatalogClient = (
  options: PaymentTermCatalogClientOptions = {},
): PaymentTermCatalogClientEffect<PaymentTermCatalogClient> => {
  const baseUrl = options.baseUrl ?? paymentTermCatalogApiContract.apiPrefix;
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
  return makeEffectHttpApiClient(paymentTermCatalogApi, {
    baseUrl,
    requestContext,
  });
};

export const getPaymentTermCatalogReadiness = (
  options: PaymentTermCatalogClientOptions = {},
): PaymentTermCatalogClientEffect<PaymentTermCatalogReadiness> =>
  // oxlint-disable-next-line effect-native/no-per-operation-http-api-client -- This generated public wrapper delegates caller-specific base URL and request metadata without introducing shared cross-request state.
  createPaymentTermCatalogClient({
    ...options,
    operationContext: options.operationContext ?? paymentTermCatalogOperationContexts.readiness,
  }).pipe(Effect.flatMap((client) => client.foundation.readiness({})));
