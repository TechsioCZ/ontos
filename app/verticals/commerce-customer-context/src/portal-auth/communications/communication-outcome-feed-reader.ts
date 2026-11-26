import {
  CommunicationOutcomeFeedRequestSchema,
  CommunicationOutcomeFeedResponseSchema,
} from '@app/communications-contracts/communication-outcome-feed';
import type { CommunicationOutcomeFeed } from '@app/communications-contracts/communication-history';
import { Effect, Layer, Match, Option, Schema } from 'effect';

import { withSafeCause } from '../../../api/portal-auth/provider/safe-failure.ts';
import {
  PORTAL_AUTH_ISSUANCE_REVISION,
  portalAuthCommunicationPurposeOf,
} from '../../../shared/portal-auth-communications.ts';
import { CommercePortalAuthCommunicationOutcomeReader } from './communication-outcome-reader.ts';
import { CommercePortalAuthCommunicationOutcomeTransport } from './communication-outcome-transport.ts';
import type { PortalAuthSourceOutcome } from './communication-outcome-reader.ts';
import { VerificationReplayUnavailable } from './verification-replay-unavailable.ts';

/**
 * The Auth reading of the `communication-outcome-feed` Read Communications publishes for a registered source workflow
 * (#1402 H-13, AC-07; #1394 PO 2A): what Communications proves about the message of ONE issuance, learned by the occurrence Auth
 * itself committed (the issuance reference), never by an identity only a successful submit carries.
 *
 * Auth never reads Communications' tables or private source. How ONE question reaches the Read is the only part a composition
 * supplies (`CommercePortalAuthCommunicationOutcomeTransport`); the question, the decoding of the answer and the reading of it
 * below are always the code in this file, so a source that cannot reach Communications can never read an answer as a fact.
 */

const decodeRequest = Schema.decodeUnknownOption(CommunicationOutcomeFeedRequestSchema, { onExcessProperty: 'error' });
const decodeResponse = Schema.decodeUnknownOption(CommunicationOutcomeFeedResponseSchema, {
  onExcessProperty: 'error',
});

/** What one message of the feed means for an enrollment replay. Never more than the feed proves. */
const messageOutcomeOf = (message: CommunicationOutcomeFeed['messages'][number]): PortalAuthSourceOutcome =>
  Match.value(message).pipe(
    // accepted by the provider or delivered: the effect exists; a soft bounce after acceptance does not undo the acceptance
    Match.when({ attention: 'NO_FAILURE' }, () => 'ACCEPTED' as const),
    Match.when({ status: 'DELIVERY_DEFERRED' }, () => 'ACCEPTED' as const),
    // prepared, not handed over yet, or held without proof and awaiting a new evaluation: a message is still owed
    Match.when({ attention: 'IN_PROGRESS' }, () => 'IN_PROGRESS' as const),
    Match.when({ attention: 'NEEDS_REEVALUATION' }, () => 'IN_PROGRESS' as const),
    // the provider effect is unknown, or its evidence disagrees with itself: reconciled, never resent
    Match.whenOr({ attention: 'UNKNOWN' }, { attention: 'NEEDS_RECONCILIATION' }, () => 'UNCERTAIN' as const),
    // a proven failure whose automatic recovery was evaluated and did not continue it (a closed recovery code names why, for
    // the three Portal Auth types `NO_RECOVERY_RULE`): nothing more will leave, and Auth never repairs it by issuing another
    // while a proven non-acceptance whose recovery has not been evaluated yet (no code) may still continue as the SAME intent
    Match.when({ attention: 'FAILURE', status: 'FAILED' }, ({ reason }) =>
      reason === undefined ? ('NON_ACCEPTANCE_PROVEN' as const) : ('STOPPED' as const),
    ),
    // suppressed, not sent or no message: Communications decided that nothing leaves
    Match.orElse(() => 'STOPPED' as const),
  );

/** Strongest first: a message that exists or is owed outweighs a stop, so a replay never claims "nothing leaves" while one does. */
const OUTCOME_PRIORITY = [
  'UNCERTAIN',
  'ACCEPTED',
  'IN_PROGRESS',
  'NON_ACCEPTANCE_PROVEN',
  'STOPPED',
] as const satisfies readonly PortalAuthSourceOutcome[];

/**
 * What the feed of ONE request means for an enrollment replay. No request is NOT_SUBMITTED; a request that decided no message
 * is STOPPED; otherwise the strongest outcome of its messages (a Portal Auth request carries exactly one).
 */
export const portalAuthSourceOutcomeOf = (feed: Option.Option<CommunicationOutcomeFeed>): PortalAuthSourceOutcome =>
  Option.match(feed, {
    onNone: () => 'NOT_SUBMITTED' as const,
    onSome: ({ messages }) => {
      const outcomes = new Set(messages.map(messageOutcomeOf));
      return OUTCOME_PRIORITY.find((outcome) => outcomes.has(outcome)) ?? 'STOPPED';
    },
  });

const unavailable = (cause: unknown) =>
  withSafeCause(new VerificationReplayUnavailable({ reason: 'OUTCOME_UNAVAILABLE' }), cause);

/** The outcome reader over a transport to the Read: the real question, the real decoding, the real reading. */
export const communicationOutcomeReaderLayer = Layer.effect(
  CommercePortalAuthCommunicationOutcomeReader,
  Effect.gen(function* makeCommunicationOutcomeReader() {
    const transport = yield* CommercePortalAuthCommunicationOutcomeTransport;
    return {
      outcomeOf: Effect.fn('CommercePortalAuthCommunicationOutcomeReader.outcomeOf')(function* outcomeOf({
        flow,
        issuanceRef,
      }) {
        // the occurrence Auth committed IS the issuance, an issuance is never revised, and the purpose is its flow's
        const request = decodeRequest({
          occurrence: { occurrenceId: issuanceRef, revision: PORTAL_AUTH_ISSUANCE_REVISION },
          purpose: portalAuthCommunicationPurposeOf(flow),
        });
        if (Option.isNone(request)) {
          return yield* unavailable('request-invalid');
        }
        // an owner that cannot answer is a typed failure, never an absent result: absence is "no request", which is a fact
        const answer = yield* transport.ask(request.value).pipe(Effect.mapError(unavailable));
        const feed = decodeResponse(answer);
        if (Option.isNone(feed)) {
          return yield* unavailable('answer-invalid');
        }
        return portalAuthSourceOutcomeOf(feed.value);
      }),
    };
  }),
);
