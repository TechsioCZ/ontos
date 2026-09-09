import { Context, Effect } from 'effect';
import type { Redacted } from 'effect';
import type {
  AccessInstant,
  CounterpartyPermissionScope,
  CounterpartyRef,
} from './access-contract.ts';
import { CounterpartyAccessUnavailable } from './counterparty-access-unavailable.ts';
import type { InvitationClaimProofReference } from './invitation-contract.ts';
import type { CounterpartyAccessInvitationRef } from '../resources/counterparty-access-invitation.ts';

export interface CounterpartyInvitationProofDeliveryService {
  /**
   * Seal the proof into a secure, idempotent queue/vault handoff. The downstream worker MUST NOT
   * release it until re-invoking `stage_invitation_claim_proof_delivery` for the exact scoped
   * invitation/proof/action returns `REPLAYED`; that is the owner-confirmed committed release gate.
   * A rolled-back, revoked, expired, claimed, or rotated row instead returns `INVALID` and is
   * discarded.
   * Implementations may persist only encrypted/sealed material, never plaintext `rawProof`.
   */
  readonly stage: (input: {
    readonly actionInvocationId: string;
    readonly counterpartyRef: CounterpartyRef;
    readonly deliveryMethod: 'VERIFIED_CONTACT_POINT' | 'APPROVED_RECIPIENT_DISCOVERY';
    readonly deliveryReference: string;
    readonly expiresAt: AccessInstant;
    readonly invitationRef: CounterpartyAccessInvitationRef;
    readonly legalEntityId: string;
    readonly proofReference: InvitationClaimProofReference;
    readonly rawProof: Redacted.Redacted;
    readonly scope: CounterpartyPermissionScope;
  }) => Effect.Effect<void, CounterpartyAccessUnavailable>;
}

/** Deployable secure-queue boundary used by production hosts. */
export interface CounterpartyInvitationProofSecureQueue {
  readonly enqueueSealed: (
    input: Parameters<CounterpartyInvitationProofDeliveryService['stage']>[0],
  ) => Effect.Effect<'ENQUEUED' | 'ALREADY_ENQUEUED', CounterpartyAccessUnavailable>;
}

export class CounterpartyInvitationProofDelivery extends Context.Service<
  CounterpartyInvitationProofDelivery,
  CounterpartyInvitationProofDeliveryService
>()(
  '@app/commerce-customer-context/shared/domain/invitation-proof-delivery/CounterpartyInvitationProofDelivery',
) {}

export const unavailableCounterpartyInvitationProofDelivery = (
  reason = 'Secure invitation proof delivery staging is unavailable',
): CounterpartyInvitationProofDeliveryService => ({
  stage: () =>
    Effect.fail(
      new CounterpartyAccessUnavailable({ code: 'counterparty_access_unavailable', reason }),
    ),
});

/**
 * Owner adapter for a deployment-provided encrypted queue or vault. Queue idempotency is the
 * action invocation plus proof reference; release is gated by the committed owner row described
 * above. This adapter deliberately exposes no plaintext result.
 */
export const secureQueuedCounterpartyInvitationProofDelivery = (
  secureQueue: CounterpartyInvitationProofSecureQueue,
): CounterpartyInvitationProofDeliveryService =>
  Object.freeze({
    stage: (input: Parameters<CounterpartyInvitationProofDeliveryService['stage']>[0]) =>
      secureQueue.enqueueSealed(input).pipe(Effect.asVoid),
  });
