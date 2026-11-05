import type { OperationalScope } from '@app/core-runtime';
import { Context, Effect } from 'effect';
import type { Redacted } from 'effect';

import { PaymentTermAffectedUseAssessmentUnavailable } from './payment-term-errors.ts';

/** Acts for the verified requester of the synchronous Payment Term action; that requester is the subject. */
export interface CustomerContextGatewayCredentialIssuer {
  readonly issue: (input: {
    readonly audience: 'commerce-customer-context';
    readonly requestCorrelation: string;
    readonly scope: OperationalScope;
  }) => Effect.Effect<Redacted.Redacted, PaymentTermAffectedUseAssessmentUnavailable>;
}

export class CustomerContextGatewayCredentialService extends Context.Service<
  CustomerContextGatewayCredentialService,
  CustomerContextGatewayCredentialIssuer
>()(
  '@app/payment-term-catalog/shared/domain/customer-context-gateway-credential/CustomerContextGatewayCredentialService',
) {}

export const unavailableCustomerContextGatewayCredentialIssuer: CustomerContextGatewayCredentialIssuer = Object.freeze({
  issue: () =>
    Effect.fail(
      new PaymentTermAffectedUseAssessmentUnavailable({
        code: 'payment_term_affected_use_assessment_unavailable',
        reason: 'No server-owned Commerce Customer Context credential issuer is configured',
      }),
    ),
});
