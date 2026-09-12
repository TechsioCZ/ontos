import {
  executePaymentTermAffectedUseAssessment,
  executePaymentTermAffectedUseAssessmentWithAuthorization,
} from '@app/customer-payment-term-contracts/payment-term-affected-use-assessment/client';
import type {
  PaymentTermAffectedUseAssessmentRequest,
  PaymentTermAffectedUseAssessmentResponse,
} from '@app/customer-payment-term-contracts/payment-term-affected-use-assessment';
import { Effect, Option, Redacted } from 'effect';

import {
  PaymentTermAffectedUseAssessmentRejected,
  PaymentTermAffectedUseAssessmentUnavailable,
} from '../../shared/domain/payment-term-errors.ts';
import { CustomerContextGatewayCredentialService } from '../../shared/domain/customer-context-gateway-credential.ts';
import type { PaymentTermAffectedUseAuthority } from '../actions/retire-payment-term.action.ts';

export { CustomerContextGatewayCredentialService } from '../../shared/domain/customer-context-gateway-credential.ts';

type AffectedUseClientError =
  ReturnType<typeof executePaymentTermAffectedUseAssessment> extends Effect.Effect<unknown, infer Failure, unknown>
    ? Failure
    : never;
type AffectedUseExecutor = (
  payload: PaymentTermAffectedUseAssessmentRequest,
  requestCorrelation: string,
) => Effect.Effect<
  PaymentTermAffectedUseAssessmentResponse,
  AffectedUseClientError | PaymentTermAffectedUseAssessmentUnavailable
>;
type AuthorizedAffectedUseExecutor = (
  payload: PaymentTermAffectedUseAssessmentRequest,
  credential: Redacted.Redacted,
  requestCorrelation: string,
) => Effect.Effect<
  PaymentTermAffectedUseAssessmentResponse,
  AffectedUseClientError | PaymentTermAffectedUseAssessmentUnavailable
>;
const executeAuthorizedAffectedUse: AuthorizedAffectedUseExecutor = (payload, credential, requestCorrelation) =>
  executePaymentTermAffectedUseAssessmentWithAuthorization(payload, Redacted.value(credential), requestCorrelation);

const unavailable = (cause: unknown): PaymentTermAffectedUseAssessmentUnavailable => {
  const failure = new PaymentTermAffectedUseAssessmentUnavailable({
    code: 'payment_term_affected_use_assessment_unavailable',
    reason: 'The authoritative Customer and Accepted Order affected-use assessment is unavailable',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

export const customerPaymentTermAffectedUseAuthority = (
  requestCorrelation: string,
  execute: AffectedUseExecutor = executePaymentTermAffectedUseAssessment,
): PaymentTermAffectedUseAuthority => ({
  verifyRetirementGovernance: (input) =>
    execute(
      {
        claimedAssessment: input.claimedAssessment,
        claimedDisposition: input.claimedDisposition,
        effectiveAt: input.effectiveAt,
        equivalentPaymentTermRefs: [...input.equivalentPaymentTermRefs].slice(1),
        paymentTermRef: input.paymentTermRef,
      },
      requestCorrelation,
    ).pipe(
      Effect.mapError(unavailable),
      Effect.flatMap((response) =>
        response.kind === 'VERIFIED'
          ? Effect.succeed({
              assessment: response.assessment,
              disposition: response.disposition,
            })
          : Effect.fail(
              new PaymentTermAffectedUseAssessmentRejected({
                code: 'payment_term_affected_use_assessment_rejected',
                reason: response.reason,
              }),
            ),
      ),
    ),
});

const unavailableAuthority: PaymentTermAffectedUseAuthority = {
  verifyRetirementGovernance: () =>
    Effect.fail(unavailable('No server-owned Commerce Customer Context credential issuer is configured')),
};

export const customerPaymentTermAffectedUseAuthorityFromEnvironment = (
  requestCorrelation: string,
  execute: AuthorizedAffectedUseExecutor = executeAuthorizedAffectedUse,
): Effect.Effect<PaymentTermAffectedUseAuthority> =>
  Effect.serviceOption(CustomerContextGatewayCredentialService).pipe(
    Effect.map((issuerOption) => {
      if (Option.isNone(issuerOption)) {
        return unavailableAuthority;
      }
      return customerPaymentTermAffectedUseAuthority(requestCorrelation, (payload, correlation) =>
        issuerOption.value
          .issue({
            audience: 'commerce-customer-context',
            requestCorrelation: correlation,
          })
          .pipe(Effect.flatMap((credential) => execute(payload, credential, correlation))),
      );
    }),
  );
