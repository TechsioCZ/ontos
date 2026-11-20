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

export interface CommunicationRequestSubmitterService {
  /**
   * Submits ONE request to the public `submit-communication-request` Action of Communications. The same request again
   * returns the stored decision; a request with the same identity and another meaning is a CONFLICT. The transport is the
   * composition's decision: Communications admits only a registered source worker, so a production caller is the Auth
   * after-commit worker under a registered workload (PROPOSED: see the #1406 report).
   */
  readonly submit: (
    request: CommunicationRequestEncoded,
  ) => Effect.Effect<PortalAuthSubmission, PortalAuthCommunicationUnavailable>;
}

export class CommercePortalAuthCommunicationRequestSubmitter extends Context.Service<
  CommercePortalAuthCommunicationRequestSubmitter,
  CommunicationRequestSubmitterService
>()(
  '@app/commerce-customer-context/portal-auth/communications/communication-request-submitter/CommercePortalAuthCommunicationRequestSubmitter',
) {}
