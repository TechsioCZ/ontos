import { identity } from 'effect';
import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@app/shared-contracts';
import type {
  MicroVerticalBuildMarker,
  MicroVerticalOperationContext,
  MicroVerticalReadiness,
} from '@app/shared-contracts';
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  Schema,
} from '@modern-js/plugin-bff/effect-client';

export type PaymentTermCatalogMarker = MicroVerticalBuildMarker;

export type PaymentTermCatalogReadiness = MicroVerticalReadiness;

export const paymentTermCatalogMarkerSchema: Schema.Codec<PaymentTermCatalogMarker> =
  MicroVerticalBuildMarkerSchema;

export const paymentTermCatalogReadinessSchema: Schema.Codec<PaymentTermCatalogReadiness> =
  MicroVerticalReadinessSchema;

export type OperationContext = MicroVerticalOperationContext;

export const paymentTermCatalogFoundationApi = HttpApi.make('PaymentTermCatalogApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/payment-term-catalog/readiness', {
      success: paymentTermCatalogReadinessSchema,
    }),
  ),
);

// <generated-governed-http-api-imports>
import { CorrectPaymentTermActionApi } from './apis/correct-payment-term-action.ts';
import { CreatePaymentTermActionApi } from './apis/create-payment-term-action.ts';
import { CurrentPaymentTermsApi } from './apis/current-payment-terms.ts';
import { PaymentTermHistoryApi } from './apis/payment-term-history.ts';
import { ReconcilePaymentTermReferenceActionApi } from './apis/reconcile-payment-term-reference-action.ts';
import { RetirePaymentTermActionApi } from './apis/retire-payment-term-action.ts';
// </generated-governed-http-api-imports>

export * from './apis/current-payment-terms.ts';
export * from './apis/payment-term-history.ts';

export const paymentTermCatalogApi = HttpApi.make('PaymentTermCatalogApi')
  .addHttpApi(paymentTermCatalogFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(CorrectPaymentTermActionApi)
  .addHttpApi(CreatePaymentTermActionApi)
  .addHttpApi(CurrentPaymentTermsApi)
  .addHttpApi(PaymentTermHistoryApi)
  .addHttpApi(ReconcilePaymentTermReferenceActionApi)
  .addHttpApi(RetirePaymentTermActionApi)
  // </generated-governed-http-api-additions>
  .pipe(identity);
export const paymentTermCatalogOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'PaymentTermCatalogApi:paymentTermCatalog:readiness',
    routePath: '/payment-term-catalog/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const paymentTermCatalogApiContract = {
  apiPrefix: '/payment-term-catalog-api',
  basePath: '/payment-term-catalog-api/payment-term-catalog',
  ownerId: 'payment-term-catalog',
  readinessPath: '/payment-term-catalog-api/payment-term-catalog/readiness',
} as const;
