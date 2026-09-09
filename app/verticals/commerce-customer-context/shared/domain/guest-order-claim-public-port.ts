import { Context } from 'effect';
import type { Effect } from 'effect';
import type { ClaimGuestOrderPayload } from './history-action-contracts.ts';
import type { HistoryActionUnavailable } from './history-action-unavailable.ts';

export interface GuestOrderClaimCommittedAttemptReceipt {
  /** Owner-issued receipt proving the sanitized attempt outcome committed before it was returned. */
  readonly committedAttemptEvidenceRef: {
    readonly moduleId: 'commerce.order';
    readonly resourceId: string;
    readonly resourceType: 'commerce.order.guest-order-claim-attempt';
    readonly tenantId: string;
  };
}

export type GuestOrderOwnerClaimOutcome = GuestOrderClaimCommittedAttemptReceipt &
  (
    | { readonly outcome: 'ALREADY_CLAIMED_EQUIVALENT' }
    | { readonly outcome: 'CLAIMED' }
    | {
        readonly outcome:
          | 'CLAIM_CONFLICT'
          | 'NOT_GUEST_ORDER'
          | 'PROOF_REJECTED'
          | 'RATE_LIMITED'
          | 'RECORD_NOT_CLAIMABLE';
      }
  );

export interface GuestOrderClaimPublicPort {
  /**
   * Atomically verifies/consumes the one-time proof before classifying the Order, durably records
   * a secret-free attempt outcome, commits it by capturing the typed rejection as an Exit inside
   * the owner transaction, and changes customer visibility only on success. The owner re-raises
   * only after commit and must return no existence/state classification for an unverified proof.
   */
  readonly claim: (
    input: ClaimGuestOrderPayload & {
      readonly actionInvocationId: string;
      readonly principalId: string;
    },
  ) => Effect.Effect<GuestOrderOwnerClaimOutcome, HistoryActionUnavailable>;
}

export class GuestOrderClaimOwner extends Context.Service<
  GuestOrderClaimOwner,
  GuestOrderClaimPublicPort
>()(
  '@app/commerce-customer-context/shared/domain/guest-order-claim-public-port/GuestOrderClaimOwner',
) {}
