import type { EmailDeliveryRejected } from '@app/email-delivery/server';
import { Schema } from 'effect';

/**
 * Closed vocabularies of the recovery of ONE Message Intent (#1403). Recovery means exactly three different follow-up actions
 * and none of them is ever another:
 * - Technical Retry: another ATTEMPT of the SAME intent, only after the previous one provably did not leave;
 * - Reconciliation: finding out what an UNKNOWN external effect was; nothing is submitted while it is unknown;
 * - Explicit Resend: a NEW intent decided by a NEW source request (`intake`, `resend-admission.ts`).
 * Nothing in these vocabularies is a count, an interval or a waiting time: those exist only where an owner approved them.
 */

/**
 * Why a later attempt of the same intent may follow the earlier one: nothing was submitted, the provider provably refused it,
 * or a reconciliation proved non-acceptance of an unknown effect (and names the observation that proved it).
 */
export type RetryBasis =
  | { readonly kind: 'PRIOR_NOT_ATTEMPTED' }
  | { readonly kind: 'PRIOR_REJECTED' }
  | { readonly kind: 'RECONCILED_NON_ACCEPTANCE'; readonly observationId: string };

/** The closed reason code written with a technical retry link; it says what kind of continuation it is, never why in prose. */
export const RETRY_REASON_CODE = {
  PRIOR_NOT_ATTEMPTED: 'PRIOR_NOT_SUBMITTED',
  PRIOR_REJECTED: 'PRIOR_NOT_ACCEPTED',
  RECONCILED_NON_ACCEPTANCE: 'RECONCILED_NOT_ACCEPTED',
} as const satisfies Record<RetryBasis['kind'], string>;

/** The closed reason code written with the resolution of a provider observation conflict. */
export const CONFLICT_RESOLUTION_REASON_CODE = 'RECONCILED_BY_PROVIDER_EVIDENCE';

/**
 * Why automatic action did NOT continue an intent although nothing is known to have been accepted. A halt proves nothing against
 * the message and is evaluated again whenever the facts change:
 * - NO_RECOVERY_RULE: the approved type has no recovery rule (`NONE`, the default), so a proven non-acceptance is not retried
 *   automatically and the source owner decides;
 * - RECOVERY_LIMIT_REACHED: the owner's own approved limit of submitted attempts was reached;
 * - REFUSAL_UNCLASSIFIED: the provider provably refused, but no approved rule classifies that refusal as temporary or permanent,
 *   so it is neither retried nor stopped for good (R-D10);
 * - MESSAGE_INVALID: the Messaging Adapter proved that our own message was malformed and the provider was never asked. That is
 *   a certain failure, not an unknown effect, so no reconciliation is awaited; it is no temporary condition either, so the same
 *   pinned message is not retried automatically and the source owner decides.
 */
export const RecoveryHaltCodeSchema = Schema.Literals([
  'MESSAGE_INVALID',
  'NO_RECOVERY_RULE',
  'RECOVERY_LIMIT_REACHED',
  'REFUSAL_UNCLASSIFIED',
]);
export type RecoveryHaltCode = typeof RecoveryHaltCodeSchema.Type;

/**
 * How the provider's closed refusal reason is read for recovery. Never a count, a delay or a retry schedule. INDETERMINATE is a
 * refusal that no approved rule classifies: it is neither recovered automatically nor stopped for good (R-D10).
 */
export const RejectionClassSchema = Schema.Literals(['PERMANENT', 'TEMPORARY', 'INDETERMINATE']);
export type RejectionClass = typeof RejectionClassSchema.Type;

/**
 * The classification of a provider REFUSAL. It is keyed by the provider vocabulary of `@app/email-delivery`, so a new refusal
 * reason fails to compile until it is classified. Only a refusal that names itself a rate limit is read as TEMPORARY. The
 * generic `provider_rejected` is not documented as final (it also carries a provider's own server error), so it stays
 * INDETERMINATE until an owner approves a mapping, and any reason that cannot be read is INDETERMINATE too: an unknown
 * refusal never becomes a PERMANENT stop by default.
 */
const REJECTION_CLASS_BY_REASON = {
  provider_rejected: 'INDETERMINATE',
  rate_limited: 'TEMPORARY',
} as const satisfies Record<EmailDeliveryRejected['reason'], RejectionClass>;

export const rejectionClassOf = (reason: string | undefined): RejectionClass =>
  Object.entries(REJECTION_CLASS_BY_REASON).find(([known]) => known === reason)?.[1] ?? 'INDETERMINATE';

/** A stop reason in the shape every handoff stop of this owner uses. */
export interface RecoveryStopReason {
  readonly category: string;
  readonly cause: string;
  readonly proven: boolean;
}

/** The provider documented that it refuses this message for good: no automatic recovery exists, whatever the type's rule. */
export const PERMANENT_REJECTION_REASON: RecoveryStopReason = {
  category: 'PERMANENT_REJECTION',
  cause: 'PROVIDER_REJECTED',
  proven: true,
};
