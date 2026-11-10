import { Context, Effect, Schema } from 'effect';

import {
  PaymentEvidenceRefSchema,
  PaymentOrderCommitmentAttemptIdSchema,
} from '../../shared/domain/payment-identifiers.ts';
import { ownerEvidenceUnavailable } from './owner-evidence-unavailable.ts';
import type { PaymentOwnerEvidenceUnavailable, PaymentOwnerScope } from './owner-evidence-unavailable.ts';

/** Why terminal non-commit is not established; timeout/unknown/open never authorize compensation (#1150 B). */
export const PAYMENT_COMMITMENT_NOT_CLOSED_REASONS = [
  'ORDER_COMMITTED',
  'ATTEMPT_OPEN',
  'OUTCOME_UNKNOWN',
  'NOT_CLOSED_AGAINST_LATE_COMMIT',
  'ATTEMPT_NOT_FOUND',
] as const;
export const PaymentCommitmentNotClosedReasonSchema = Schema.Literals(PAYMENT_COMMITMENT_NOT_CLOSED_REASONS);

/** Authoritative #331 terminal non-commit plus closure against late commit for one exact Attempt. */
export const PaymentCommitmentOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('NOT_COMMITTED_CLOSED', {
    attemptRef: PaymentOrderCommitmentAttemptIdSchema,
    terminalNonCommitEvidenceRef: PaymentEvidenceRefSchema,
  }),
  Schema.TaggedStruct('NOT_ESTABLISHED', {
    attemptRef: PaymentOrderCommitmentAttemptIdSchema,
    reason: PaymentCommitmentNotClosedReasonSchema,
  }),
]);
export type PaymentCommitmentOutcome = typeof PaymentCommitmentOutcomeSchema.Type;

export interface PaymentCommitmentOutcomeService {
  readonly verifyTerminalNonCommit: (input: {
    readonly attemptRef: string;
    readonly purchaseCorrelationId: string;
    readonly scope: PaymentOwnerScope;
    readonly terminalNonCommitEvidenceRef: string;
  }) => Effect.Effect<PaymentCommitmentOutcome, PaymentOwnerEvidenceUnavailable>;
}

/** Commitment/reconciliation owner (#331) terminal non-commit evidence (L4). */
export class CommitmentOutcomePort extends Context.Service<CommitmentOutcomePort, PaymentCommitmentOutcomeService>()(
  '@app/payment/ports/commitment-outcome-port/CommitmentOutcomePort',
) {}

export const unavailableCommitmentOutcome: PaymentCommitmentOutcomeService = Object.freeze({
  verifyTerminalNonCommit: () =>
    Effect.fail(
      ownerEvidenceUnavailable('COMMITMENT_OUTCOME', 'No commitment terminal non-commit evidence route is configured'),
    ),
});
