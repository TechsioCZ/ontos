import { makeEffectBffClientOptions } from '@app/shared-contracts/client-runtime';
import { Effect, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import { Context, Layer } from 'effect';
import type { HttpApi, HttpApiClient } from 'effect/http-api';

import { paymentApiContract, paymentApi, paymentOperationContexts } from '../../shared/api.ts';

// <generated-action-http-client-exports>
export {
  executeAcceptPaymentObservation,
  executeAcceptPaymentObservationWithAuthorization,
} from './accept-payment-observation-action-client.ts';
export type { AcceptPaymentObservationActionClientOptions } from './accept-payment-observation-action-client.ts';
export {
  executeConfigurePaymentMethodEnablement,
  executeConfigurePaymentMethodEnablementWithAuthorization,
} from './configure-payment-method-enablement-action-client.ts';
export type { ConfigurePaymentMethodEnablementActionClientOptions } from './configure-payment-method-enablement-action-client.ts';
export {
  executeConfigurePaymentSourceAuthority,
  executeConfigurePaymentSourceAuthorityWithAuthorization,
} from './configure-payment-source-authority-action-client.ts';
export type { ConfigurePaymentSourceAuthorityActionClientOptions } from './configure-payment-source-authority-action-client.ts';
export { executeCreatePayment, executeCreatePaymentWithAuthorization } from './create-payment-action-client.ts';
export type { CreatePaymentActionClientOptions } from './create-payment-action-client.ts';
export {
  executeIssuePaymentAuthorization,
  executeIssuePaymentAuthorizationWithAuthorization,
} from './issue-payment-authorization-action-client.ts';
export type { IssuePaymentAuthorizationActionClientOptions } from './issue-payment-authorization-action-client.ts';
export {
  executeRecordPaymentLocalEvidence,
  executeRecordPaymentLocalEvidenceWithAuthorization,
} from './record-payment-local-evidence-action-client.ts';
export type { RecordPaymentLocalEvidenceActionClientOptions } from './record-payment-local-evidence-action-client.ts';
export {
  executeRecordPaymentReconciliationDecision,
  executeRecordPaymentReconciliationDecisionWithAuthorization,
} from './record-payment-reconciliation-decision-action-client.ts';
export type { RecordPaymentReconciliationDecisionActionClientOptions } from './record-payment-reconciliation-decision-action-client.ts';
export {
  executeRequestPaymentCancellation,
  executeRequestPaymentCancellationWithAuthorization,
} from './request-payment-cancellation-action-client.ts';
export type { RequestPaymentCancellationActionClientOptions } from './request-payment-cancellation-action-client.ts';
export {
  executeRequestPaymentOperationRecovery,
  executeRequestPaymentOperationRecoveryWithAuthorization,
} from './request-payment-operation-recovery-action-client.ts';
export type { RequestPaymentOperationRecoveryActionClientOptions } from './request-payment-operation-recovery-action-client.ts';
export {
  executeRequestPaymentRefund,
  executeRequestPaymentRefundWithAuthorization,
} from './request-payment-refund-action-client.ts';
export type { RequestPaymentRefundActionClientOptions } from './request-payment-refund-action-client.ts';
export {
  executeStartPaymentCollection,
  executeStartPaymentCollectionWithAuthorization,
} from './start-payment-collection-action-client.ts';
export type { StartPaymentCollectionActionClientOptions } from './start-payment-collection-action-client.ts';
// </generated-action-http-client-exports>

type PaymentApiGroups = typeof paymentApi extends HttpApi.HttpApi<string, infer Groups> ? Groups : never;
/** Only the foundation group is reachable through this Service; the business groups have standalone clients. */
type FoundationClient = Pick<HttpApiClient.Client<PaymentApiGroups>, 'foundation'>;
type ClientOptionsEffect = ReturnType<typeof makeEffectBffClientOptions>;
const foundationClient: Effect.Effect<FoundationClient, Effect.Error<ClientOptionsEffect>> = Effect.gen(
  function* acquirePaymentFoundationClient() {
    const clientOptions = yield* makeEffectBffClientOptions({
      defaultApiPrefix: paymentApiContract.apiPrefix,
      requestContext: { operationContext: paymentOperationContexts.readiness },
    });
    return yield* makeEffectHttpApiClient(paymentApi, clientOptions);
  },
);
/** Readiness transport is acquired once per composed Layer lifetime. */
export class PaymentFoundationClient extends Context.Service<PaymentFoundationClient, FoundationClient>()(
  '@app/payment/api/payment-client/PaymentFoundationClient',
) {}
export const PaymentFoundationClientLive = Layer.effect(PaymentFoundationClient, foundationClient);
/** Business operations use their standalone assertion-bound generated clients. */
export const getPaymentReadiness = PaymentFoundationClient.pipe(
  Effect.flatMap((client) => client.foundation.readiness({})),
);
