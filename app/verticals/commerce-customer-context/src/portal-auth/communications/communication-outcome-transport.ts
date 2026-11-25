import type { CommunicationOutcomeFeedRequestSchema } from '@app/communications-contracts/communication-outcome-feed';
import { Context } from 'effect';
import type { Effect } from 'effect';

/** A failed ask of Communications (an outage, a refusal, a timeout): a tagged failure that says nothing about what it holds. */
export interface CommunicationOutcomeTransportFailure {
  readonly _tag: string;
}

export interface CommunicationOutcomeTransportService {
  /** Asks the Read for ONE request. The answer is decoded here, never trusted. */
  readonly ask: (
    request: typeof CommunicationOutcomeFeedRequestSchema.Encoded,
  ) => Effect.Effect<unknown, CommunicationOutcomeTransportFailure>;
}

export class CommercePortalAuthCommunicationOutcomeTransport extends Context.Service<
  CommercePortalAuthCommunicationOutcomeTransport,
  CommunicationOutcomeTransportService
>()(
  '@app/commerce-customer-context/portal-auth/communications/communication-outcome-transport/CommercePortalAuthCommunicationOutcomeTransport',
) {}
