import { Context, Effect, Layer, Schema } from 'effect';

import type { PortalAuthEmailFlow, PortalAuthIssuanceRef } from '../../../shared/portal-auth-communications.ts';
import { VerificationReplayUnavailable } from './verification-replay-unavailable.ts';

/**
 * What Communications currently proves about the message of one issuance, as the SOURCE learns it (the outcome feed of
 * #1402), reduced to what an enrollment replay needs:
 * - NOT_SUBMITTED: Communications has no request for the issuance, so no message can exist for it;
 * - IN_PROGRESS / ACCEPTED: the message is prepared, handed over or provider-accepted; the effect exists or is on its way;
 * - UNCERTAIN: the provider effect is UNKNOWN (a timeout, an unreadable answer); it is reconciled, never resent;
 * - NON_ACCEPTANCE_PROVEN: the provider provably did not accept; the SAME intent may continue under its approved recovery rule;
 * - STOPPED: Communications decided no message leaves (a language, Privacy, recipient or source-state stop).
 */
export const PortalAuthSourceOutcomeSchema = Schema.Literals([
  'ACCEPTED',
  'IN_PROGRESS',
  'NON_ACCEPTANCE_PROVEN',
  'NOT_SUBMITTED',
  'STOPPED',
  'UNCERTAIN',
]);
export type PortalAuthSourceOutcome = typeof PortalAuthSourceOutcomeSchema.Type;

export interface CommunicationOutcomeReaderService {
  readonly outcomeOf: (input: {
    readonly flow: PortalAuthEmailFlow;
    readonly issuanceRef: PortalAuthIssuanceRef;
  }) => Effect.Effect<PortalAuthSourceOutcome, VerificationReplayUnavailable>;
}

export class CommercePortalAuthCommunicationOutcomeReader extends Context.Service<
  CommercePortalAuthCommunicationOutcomeReader,
  CommunicationOutcomeReaderService
>()(
  '@app/commerce-customer-context/portal-auth/communications/communication-outcome-reader/CommercePortalAuthCommunicationOutcomeReader',
) {}

/** No source outcome Read is published to Auth yet: an enrollment replay can establish nothing and therefore sends nothing new. */
export const unavailableCommunicationOutcomeReaderLayer = Layer.succeed(CommercePortalAuthCommunicationOutcomeReader, {
  outcomeOf: () => Effect.fail(new VerificationReplayUnavailable({ reason: 'OUTCOME_UNAVAILABLE' })),
});
