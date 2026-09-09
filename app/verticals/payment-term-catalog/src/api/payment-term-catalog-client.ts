import { Effect, makeEffectHttpApiClient } from '@modern-js/plugin-bff/effect-client';
import type {
  HttpClientError,
  HttpApi,
  HttpApiClient,
  HttpApiGroup,
  Schema,
} from '@modern-js/plugin-bff/effect-client';

import {
  paymentTermCatalogApiContract,
  paymentTermCatalogApi,
  paymentTermCatalogOperationContexts,
} from '../../shared/api.ts';
import type { OperationContext, PaymentTermCatalogReadiness } from '../../shared/api.ts';

export { Effect, runEffectRequest } from '@modern-js/plugin-bff/effect-client';
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
  Extract<PaymentTermCatalogApiGroups, HttpApiGroup.Constraint>,
  never,
  never
>;

export type PaymentTermCatalogClientError = HttpClientError.HttpClientError | Schema.SchemaError;

export type PaymentTermCatalogClientEffect<Success> = Effect.Effect<
  Success,
  PaymentTermCatalogClientError,
  never
>;

export interface PaymentTermCatalogClientOptions {
  baseUrl?: string | URL;
  locale?: string;
  operationContext?: OperationContext;
  traceparent?: string;
}

export const createPaymentTermCatalogClient = (
  options: PaymentTermCatalogClientOptions = {},
): PaymentTermCatalogClientEffect<PaymentTermCatalogClient> =>
  makeEffectHttpApiClient(paymentTermCatalogApi, {
    baseUrl: options.baseUrl ?? paymentTermCatalogApiContract.apiPrefix,
    requestContext: {
      ...(options.locale === undefined ? {} : { locale: options.locale }),
      ...(options.operationContext === undefined
        ? {}
        : { operationContext: options.operationContext }),
      ...(options.traceparent === undefined ? {} : { traceparent: options.traceparent }),
    },
  });

export const getPaymentTermCatalogReadiness = (
  options: PaymentTermCatalogClientOptions = {},
): PaymentTermCatalogClientEffect<PaymentTermCatalogReadiness> =>
  createPaymentTermCatalogClient({
    ...options,
    operationContext: options.operationContext ?? paymentTermCatalogOperationContexts.readiness,
  }).pipe(Effect.flatMap((client) => client.foundation.readiness({})));
