import { identity } from 'effect';
import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@modern-js/bff-effect/microvertical-api';
import type { MicroVerticalOperationContext } from '@modern-js/bff-effect/microvertical-api';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';

// <generated-governed-http-api-imports>
import { AcceptPaymentObservationActionApi } from './apis/accept-payment-observation-action.ts';
import { ConfigurePaymentMethodEnablementActionApi } from './apis/configure-payment-method-enablement-action.ts';
import { ConfigurePaymentSourceAuthorityActionApi } from './apis/configure-payment-source-authority-action.ts';
import { CreatePaymentActionApi } from './apis/create-payment-action.ts';
import { CurrentPaymentApi } from './apis/current-payment.ts';
import { IssuePaymentAuthorizationActionApi } from './apis/issue-payment-authorization-action.ts';
import { PaymentAuthorizationValidationApi } from './apis/payment-authorization-validation.ts';
import { PaymentHistoryApi } from './apis/payment-history.ts';
import { PaymentMethodApplicabilityApi } from './apis/payment-method-applicability.ts';
import { PaymentReconciliationDebtApi } from './apis/payment-reconciliation-debt.ts';
import { RecordPaymentLocalEvidenceActionApi } from './apis/record-payment-local-evidence-action.ts';
import { RecordPaymentReconciliationDecisionActionApi } from './apis/record-payment-reconciliation-decision-action.ts';
import { RequestPaymentCancellationActionApi } from './apis/request-payment-cancellation-action.ts';
import { RequestPaymentOperationRecoveryActionApi } from './apis/request-payment-operation-recovery-action.ts';
import { RequestPaymentRefundActionApi } from './apis/request-payment-refund-action.ts';
import { StartPaymentCollectionActionApi } from './apis/start-payment-collection-action.ts';
// </generated-governed-http-api-imports>

export const paymentMarkerSchema = Schema.Struct({
  ...MicroVerticalBuildMarkerSchema.fields,
  kind: Schema.Literal('microvertical-delivery-unit'),
  schemaVersion: Schema.Literal(1),
});
export type PaymentMarker = typeof paymentMarkerSchema.Type;

export const paymentReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: paymentMarkerSchema,
});
export type PaymentReadiness = typeof paymentReadinessSchema.Type;

export type OperationContext = MicroVerticalOperationContext;

export const paymentFoundationApi = HttpApi.make('PaymentApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/payment/readiness', { success: paymentReadinessSchema }),
  ),
);

export const paymentApi = HttpApi.make('PaymentApi')
  .addHttpApi(paymentFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(AcceptPaymentObservationActionApi)
  .addHttpApi(ConfigurePaymentMethodEnablementActionApi)
  .addHttpApi(ConfigurePaymentSourceAuthorityActionApi)
  .addHttpApi(CreatePaymentActionApi)
  .addHttpApi(CurrentPaymentApi)
  .addHttpApi(IssuePaymentAuthorizationActionApi)
  .addHttpApi(PaymentAuthorizationValidationApi)
  .addHttpApi(PaymentHistoryApi)
  .addHttpApi(PaymentMethodApplicabilityApi)
  .addHttpApi(PaymentReconciliationDebtApi)
  .addHttpApi(RecordPaymentLocalEvidenceActionApi)
  .addHttpApi(RecordPaymentReconciliationDecisionActionApi)
  .addHttpApi(RequestPaymentCancellationActionApi)
  .addHttpApi(RequestPaymentOperationRecoveryActionApi)
  .addHttpApi(RequestPaymentRefundActionApi)
  .addHttpApi(StartPaymentCollectionActionApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);

export const paymentOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'PaymentApi:payment:readiness',
    routePath: '/payment/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const paymentApiContract = {
  apiPrefix: '/payment-api',
  basePath: '/payment-api/payment',
  ownerId: 'payment',
  readinessPath: '/payment-api/payment/readiness',
} as const;
