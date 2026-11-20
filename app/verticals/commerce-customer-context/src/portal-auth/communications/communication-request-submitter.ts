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
   * composition's decision, and it is OPEN: nothing here claims that a production composition can call the Action.
   *
   * OPEN ITEM (D1): Communications admits only a registered source worker, so the caller of the Action needs an authenticated
   * principal, and the user-triggered Auth flows (sign-up, password reset, sending a one-time code) have none after the
   * commit: Better Auth runs these callbacks outside any transaction of ours and exposes no hook around them. The two ways to
   * give the dispatch a principal are (a) an Auth-realm system workload binding that Auth itself calls after the commit, or
   * (b) an Auth-written row (the issuance, committed with the flow) that a Core sweeper turns into the Action call under its
   * own registered worker. Neither exists yet; until one does, this port is wired only by tests and by a composition that
   * supplies its own transport, and no document claims production reachability of this path.
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
