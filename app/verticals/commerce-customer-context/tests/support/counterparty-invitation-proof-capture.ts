import { Effect, Layer, Redacted } from 'effect';

import { CounterpartyInvitationProofDelivery } from '../../shared/domain/invitation-proof-delivery.ts';
import type { CounterpartyInvitationProofDeliveryService } from '../../shared/domain/invitation-proof-delivery.ts';

/**
 * The one seam a test may observe an invitation's raw secret through.
 *
 * Production binds `CounterpartyInvitationProofDelivery` to a fail-closed leaf, and every other
 * surface — the routine result, the invitation row, the Action result — carries only the proof
 * reference. Staging is therefore where the recipient's copy of the secret exists, so an acceptance
 * that has to present that secret captures it exactly where the deployment's secure queue would
 * receive it, rather than reaching into the digest the owner stored.
 */

interface CapturedCounterpartyInvitationProof {
  readonly claimProofReference: string;
  readonly deliveryReference: string;
  readonly invitationId: string;
  /** The one-time secret the delivery worker would release to the recipient. */
  readonly secret: string;
}

export interface CapturingCounterpartyInvitationProofDelivery {
  readonly delivery: CounterpartyInvitationProofDeliveryService;
  readonly live: Layer.Layer<CounterpartyInvitationProofDelivery>;
  /** Every staged delivery, in the order the owner staged it. */
  readonly staged: readonly CapturedCounterpartyInvitationProof[];
}

export const makeCapturingCounterpartyInvitationProofDelivery = (): CapturingCounterpartyInvitationProofDelivery => {
  const staged: CapturedCounterpartyInvitationProof[] = [];
  const delivery: CounterpartyInvitationProofDeliveryService = {
    stage: (input) =>
      Effect.sync(() => {
        staged.push({
          claimProofReference: input.proofReference,
          deliveryReference: input.deliveryReference,
          invitationId: input.invitationRef.resourceId,
          secret: Redacted.value(input.rawProof),
        });
      }),
  };
  return {
    delivery,
    live: Layer.succeed(CounterpartyInvitationProofDelivery, delivery),
    staged,
  };
};
