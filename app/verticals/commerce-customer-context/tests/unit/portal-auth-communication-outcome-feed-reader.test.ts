import { CommunicationOutcomeFeedSchema } from '@app/communications-contracts/communication-history';
import { Effect, Layer, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CommercePortalAuthCommunicationOutcomeReader } from '../../src/portal-auth/communications/communication-outcome-reader.ts';
import {
  communicationOutcomeReaderLayer,
  portalAuthSourceOutcomeOf,
} from '../../src/portal-auth/communications/communication-outcome-feed-reader.ts';
import { VerificationReplayUnavailable } from '../../src/portal-auth/communications/verification-replay-unavailable.ts';
import { communicationOutcomeTransportUnavailableLayer } from '../../src/portal-auth/communications/communication-outcome-transport-unavailable.ts';
import { CommercePortalAuthCommunicationOutcomeTransport } from '../../src/portal-auth/communications/communication-outcome-transport.ts';
import {
  PORTAL_AUTH_EMAIL_FLOWS,
  PortalAuthIssuanceRefSchema,
  portalAuthCommunicationPurposeOf,
} from '../../shared/portal-auth-communications.ts';
import type { PortalAuthEmailFlow } from '../../shared/portal-auth-communications.ts';

/**
 * [#1402 H-13 AC-07, #1406 AC-09] Auth reads what Communications proves about the message of one issuance through the published
 * `communication-outcome-feed` Read. The transport is scripted here (the real Read is exercised by the end-to-end suites); the
 * question Auth puts, the decoding of the answer and its reading are the production code. Every identity below is FICTIONAL.
 */

const ISSUANCE = Schema.decodeSync(PortalAuthIssuanceRefSchema)('pa-fictional-issuance');
const decodeFeed = Schema.decodeUnknownSync(CommunicationOutcomeFeedSchema);
const IDS = {
  decision: '11111111-1111-4111-8111-111111111111',
  intent: '22222222-2222-4222-8222-222222222222',
  request: '33333333-3333-4333-8333-333333333333',
};
const RECIPIENT = { moduleId: 'commerce.customer-context', resourceId: 'subject-1', resourceType: 'account' };

interface Message {
  readonly attention: string;
  readonly reason?: string;
  readonly status: string;
}
const feedOf = (messages: readonly Message[], noMessageReason?: string) => ({
  decisionId: IDS.decision,
  messages: messages.map((message) => ({
    ...message,
    intentId: IDS.intent,
    recipientRef: RECIPIENT,
    slotKey: 'primary',
  })),
  noMessageReason,
  partial: false,
  requestId: IDS.request,
  requiredOutcome: 'NO_FAILURE',
  sourceImpact: 'SOURCE_OWNER_DECIDES',
  unresolvedSlots: [],
});

const readerOver = (answer: () => Effect.Effect<unknown, { readonly _tag: string }>, asked: unknown[] = []) =>
  CommercePortalAuthCommunicationOutcomeReader.pipe(
    Effect.provide(
      communicationOutcomeReaderLayer.pipe(
        Layer.provide(
          Layer.succeed(CommercePortalAuthCommunicationOutcomeTransport, {
            ask: (request) => {
              asked.push(request);
              return answer();
            },
          }),
        ),
      ),
    ),
  );

const outcomeOf = (flow: PortalAuthEmailFlow, answer: () => Effect.Effect<unknown, { readonly _tag: string }>) =>
  readerOver(answer).pipe(Effect.flatMap((reader) => reader.outcomeOf({ flow, issuanceRef: ISSUANCE })));

describe('The Auth reading of the Communications outcome feed (#1406, #1402)', () => {
  it('maps what the feed proves to what an enrollment replay needs, never more', () => {
    const only = (message: Message) => portalAuthSourceOutcomeOf(Option.some(decodeFeed(feedOf([message]))));
    expect(portalAuthSourceOutcomeOf(Option.none())).toBe('NOT_SUBMITTED');
    expect(only({ attention: 'NO_FAILURE', status: 'PROVIDER_ACCEPTED' })).toBe('ACCEPTED');
    expect(only({ attention: 'NO_FAILURE', status: 'DELIVERED' })).toBe('ACCEPTED');
    expect(only({ attention: 'UNKNOWN', status: 'DELIVERY_DEFERRED' })).toBe('ACCEPTED');
    expect(only({ attention: 'IN_PROGRESS', status: 'PREPARED' })).toBe('IN_PROGRESS');
    expect(only({ attention: 'NEEDS_REEVALUATION', status: 'HELD_UNPROVEN' })).toBe('IN_PROGRESS');
    expect(only({ attention: 'UNKNOWN', status: 'PROVIDER_SUBMITTED' })).toBe('UNCERTAIN');
    expect(only({ attention: 'UNKNOWN', status: 'INDETERMINATE' })).toBe('UNCERTAIN');
    expect(only({ attention: 'NEEDS_RECONCILIATION', status: 'PROVIDER_ACCEPTED' })).toBe('UNCERTAIN');
    // a proven non-acceptance whose recovery was not evaluated yet may still continue as the SAME intent ...
    expect(only({ attention: 'FAILURE', status: 'FAILED' })).toBe('NON_ACCEPTANCE_PROVEN');
    // ... and once recovery was evaluated and did not continue it (R-D14: no rule for the Auth types) nothing more leaves
    expect(only({ attention: 'FAILURE', reason: 'NO_RECOVERY_RULE', status: 'FAILED' })).toBe('STOPPED');
    expect(only({ attention: 'FAILURE', reason: 'PRIVACY_NOT_ALLOWED', status: 'SUPPRESSED' })).toBe('STOPPED');
    expect(only({ attention: 'FAILURE', reason: 'CZECH_REVISION_UNAVAILABLE', status: 'NOT_SENT' })).toBe('STOPPED');
    // a request that decided no message at all
    expect(portalAuthSourceOutcomeOf(Option.some(decodeFeed(feedOf([], 'UNKNOWN_PURPOSE'))))).toBe('STOPPED');
  });

  it.effect(
    'asks the Read about the occurrence Auth committed and the purpose of its flow, for each of the three flows',
    () =>
      Effect.gen(function* threeFlows() {
        for (const flow of PORTAL_AUTH_EMAIL_FLOWS) {
          const asked: unknown[] = [];
          const reader = yield* readerOver(() => Effect.succeed(null), asked);
          const outcome = yield* reader.outcomeOf({ flow, issuanceRef: ISSUANCE });
          // Communications holds no request of this source for the occurrence: nothing was submitted
          expect(outcome).toBe('NOT_SUBMITTED');
          expect(asked).toStrictEqual([
            { occurrence: { occurrenceId: ISSUANCE, revision: 1 }, purpose: portalAuthCommunicationPurposeOf(flow) },
          ]);
        }
      }),
  );

  it.effect('reads an answered feed through the published contract', () =>
    Effect.gen(function* answered() {
      const outcome = yield* outcomeOf('otp', () =>
        Effect.succeed(feedOf([{ attention: 'NO_FAILURE', status: 'PROVIDER_ACCEPTED' }])),
      );
      expect(outcome).toBe('ACCEPTED');
    }),
  );

  it.effect(
    'an unreachable Communications and an unreadable answer are the typed unavailable, never an empty success',
    () =>
      Effect.gen(function* unreachable() {
        for (const flow of PORTAL_AUTH_EMAIL_FLOWS) {
          const outage = yield* Effect.flip(
            outcomeOf(flow, () => Effect.fail({ _tag: 'OutcomeFeedUnavailableProblem' })),
          );
          expect(Schema.is(VerificationReplayUnavailable)(outage)).toBe(true);
          expect(outage.reason).toBe('OUTCOME_UNAVAILABLE');
        }
        // an answer that is not the published feed is not read as a fact, and an unknown field is refused
        for (const answer of [{ unrelated: true }, { ...feedOf([]), address: 'holder@example.test' }, 'ok']) {
          const refused = yield* Effect.flip(outcomeOf('verify-email', () => Effect.succeed(answer)));
          expect(refused.reason).toBe('OUTCOME_UNAVAILABLE');
        }
      }),
  );

  it.effect(
    'the API process composes the transport without a request-time authority: every ask is a typed failure',
    () =>
      Effect.gen(function* noAuthority() {
        const reader = yield* CommercePortalAuthCommunicationOutcomeReader.pipe(
          Effect.provide(
            communicationOutcomeReaderLayer.pipe(Layer.provide(communicationOutcomeTransportUnavailableLayer)),
          ),
        );
        const failure = yield* Effect.flip(reader.outcomeOf({ flow: 'verify-email', issuanceRef: ISSUANCE }));
        expect(failure.reason).toBe('OUTCOME_UNAVAILABLE');
      }),
  );
});
