import { Schema } from 'effect';

/**
 * Closed set of safe reasons why a Counterparty invitation may not be claimed for an Enrollment
 * Attempt.  Every reason is decided from a read alone, before the claim owner effect runs, so a
 * rejection never leaves a partially applied claim behind and never needs a compensating write.
 *
 * Infrastructure failures are deliberately absent: an unavailable invitation read stays a
 * retryable `CounterpartyAccessUnavailable`, because "we could not confirm the invitation" must
 * never be reported to a recipient as "your invitation is invalid".
 */
export class CounterpartyInvitationClaimRejected extends Schema.TaggedError<CounterpartyInvitationClaimRejected>()(
  'CounterpartyInvitationClaimRejected',
  {
    code: Schema.Literals([
      /** The invitation expired, or its own lifecycle already recorded expiry. */
      'invitation_expired',
      /** A claim already consumed this invitation's one-time proof. */
      'invitation_replayed',
      /** The invitation is held by a different Principal than the enrolling claimant. */
      'invitation_recipient_mismatch',
      /** The invitation, Counterparty or claimant belongs to a different Tenant. */
      'invitation_tenant_mismatch',
      /** The invitation no longer covers the Permission scope the claim was planned for. */
      'invitation_scope_mismatch',
      /** Revoked, or otherwise not in a state a claim may begin from. */
      'invitation_not_claimable',
      /** An invited Permission is no longer delegable in that scope under the Current catalog. */
      'invitation_catalog_revision_changed',
      /** The inviter lost Current authority to delegate at least one invited Permission. */
      'invitation_grantor_authority_lost',
    ]),
    reason: Schema.String,
    retryable: Schema.Boolean,
  },
) {}

export const rejectCounterpartyInvitationClaim = (
  code: typeof CounterpartyInvitationClaimRejected.Type.code,
  reason: string,
): CounterpartyInvitationClaimRejected =>
  new CounterpartyInvitationClaimRejected({ code, reason: reason.slice(0, 500), retryable: false });
