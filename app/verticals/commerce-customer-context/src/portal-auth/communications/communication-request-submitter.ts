import type { CommunicationRequestEncoded } from '@app/communications-contracts/communication-request';
import { Context } from 'effect';
import type { Effect } from 'effect';

import type { PortalAuthCommunicationUnavailable } from './communication-unavailable.ts';

/** The safe part of the decision Communications stored for one request: identities and closed codes, never content. */
export interface PortalAuthIntentSummary {
  readonly intentId: string;
  readonly reason?: string;
  readonly status: 'NOT_SENT' | 'PENDING_HANDOFF' | 'SUPPRESSED';
}

export type PortalAuthSubmission =
  | {
      readonly decision:
        | { readonly intents: readonly PortalAuthIntentSummary[]; readonly kind: 'MESSAGE_INTENTS' }
        | { readonly kind: 'NO_MESSAGE'; readonly reason: string };
      readonly decisionId: string;
      readonly outcome: 'DECIDED';
      readonly replayed: boolean;
      readonly requestId: string;
    }
  | { readonly originalDecisionId: string; readonly outcome: 'CONFLICT'; readonly requestId: string };

/**
 * What the transport answers for one request: Communications' stored decision (or conflict) when it reaches the Action in
 * process, or RELAYED when it durably queued the request for this module's source worker (not yet decided; the decision
 * reaches Auth through the outcome Read).
 */
export type PortalAuthTransportAnswer = PortalAuthSubmission | { readonly outcome: 'RELAYED' };

export interface CommunicationRequestSubmitterService {
  /**
   * Submits ONE request to the public `submit-communication-request` Action of Communications. The same request again
   * returns the stored decision; a request with the same identity and another meaning is a CONFLICT. Only the relay of the
   * Auth-local outbox calls it (`request-relay.ts`), after the issuance and its request committed together, so the
   * user-triggered flow never needs a principal of its own. The production transport (`relay-transport.ts`) answers RELAYED:
   * it queues the request for this module's source worker, which alone may call the public Action.
   */
  readonly submit: (
    request: CommunicationRequestEncoded,
  ) => Effect.Effect<PortalAuthTransportAnswer, PortalAuthCommunicationUnavailable>;
}

export class CommercePortalAuthCommunicationRequestSubmitter extends Context.Service<
  CommercePortalAuthCommunicationRequestSubmitter,
  CommunicationRequestSubmitterService
>()(
  '@app/commerce-customer-context/portal-auth/communications/communication-request-submitter/CommercePortalAuthCommunicationRequestSubmitter',
) {}
