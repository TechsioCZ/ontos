import { Schema } from 'effect';

import {
  PaymentApplicabilityFindingSchema,
  PaymentNotAvailableApplicabilityOutcomeSchema,
} from './applicability-contract.ts';
import type { PaymentApplicabilityFinding, PaymentNotAvailableApplicabilityOutcome } from './applicability-contract.ts';

/**
 * Create-time applicability refusal (#1147/#1148). Each non-AVAILABLE outcome has its own public code,
 * so the HTTP Problem carries the exact typed outcome instead of one generic refusal; the domain error
 * also carries the outcome and every finding.
 */
export const PAYMENT_METHOD_NOT_APPLICABLE_CODE_BY_OUTCOME = Object.freeze({
  CONFLICTING_CONFIGURATION: 'payment_method_configuration_conflict',
  INCOMPATIBLE_TERM: 'payment_method_term_incompatible',
  MISSING_REQUIRED_INPUT: 'payment_method_input_required',
  NOT_ENABLED: 'payment_method_not_enabled',
  UNAVAILABLE_TO_VERIFY: 'payment_method_evidence_unavailable',
  UNSUPPORTED_CAPABILITY: 'payment_method_capability_unsupported',
} as const satisfies Record<PaymentNotAvailableApplicabilityOutcome, string>);

export const PaymentMethodNotApplicableCodeSchema = Schema.Literals([
  'payment_method_configuration_conflict',
  'payment_method_term_incompatible',
  'payment_method_input_required',
  'payment_method_not_enabled',
  'payment_method_evidence_unavailable',
  'payment_method_capability_unsupported',
] satisfies readonly (typeof PAYMENT_METHOD_NOT_APPLICABLE_CODE_BY_OUTCOME)[PaymentNotAvailableApplicabilityOutcome][]);

/** The selected method branch is not AVAILABLE at this execution: no Payment intent is created. */
export class PaymentMethodNotApplicable extends Schema.TaggedError<PaymentMethodNotApplicable>()(
  'PaymentMethodNotApplicable',
  {
    code: PaymentMethodNotApplicableCodeSchema,
    findings: Schema.NonEmptyArray(PaymentApplicabilityFindingSchema),
    outcome: PaymentNotAvailableApplicabilityOutcomeSchema,
    reason: Schema.String,
  },
) {}

export const paymentMethodNotApplicable = (
  outcome: PaymentNotAvailableApplicabilityOutcome,
  findings: readonly [PaymentApplicabilityFinding, ...PaymentApplicabilityFinding[]],
): PaymentMethodNotApplicable =>
  new PaymentMethodNotApplicable({
    code: PAYMENT_METHOD_NOT_APPLICABLE_CODE_BY_OUTCOME[outcome],
    findings,
    outcome,
    reason: `The selected Payment Method is ${outcome}`,
  });
