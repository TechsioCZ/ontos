import { CommunicationResourceRefSchema } from '@app/communications-contracts/communication-request';
import { Option, Schema } from 'effect';

import { HistorySlotKeySchema } from '../../../shared/communication-history.ts';
import type { CommunicationOutcomeFeed } from '../../../shared/communication-history.ts';
import {
  CommunicationDecisionIdSchema,
  CommunicationRequestIdSchema,
  MessageIntentIdSchema,
} from '../../../shared/communication-intake.ts';
import { CommunicationOutcome, RecipientDecision } from '../../../src/domain/catalog/decision.ts';
import type { CommunicationDecision } from '../../../src/domain/catalog/decision.ts';
import { sourceOutcomeFeedOf } from '../../../src/domain/history/source-outcome.ts';
import type { RequestOutcomeFacts } from '../../../src/domain/history/source-outcome.ts';
import { stopReasonCodeOf, summarizeIntent } from '../../../src/domain/history/timeline.ts';
import { MessageHandoffDecision } from '../../../src/domain/privacy/suppression.ts';
import type { MessageHandoffDecisionCase } from '../../../src/domain/privacy/suppression.ts';
import { attempt, factsOf, stop } from './history-fixtures.ts';

/**
 * TEST-ONLY: the facts the owner STORES about a request, derived from a decision or from the decisions of the last stoppable
 * handoff, so that the ONE derivation of the outcome a required type owes the source (`sourceOutcomeFeedOf`) is proven over
 * the same facts production hands it. Nothing here derives an outcome itself.
 */
const REQUEST_ID = CommunicationRequestIdSchema.make('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
const DECISION_ID = CommunicationDecisionIdSchema.make('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1');
const decodeRef = Schema.decodeUnknownSync(CommunicationResourceRefSchema);

interface Who {
  readonly recipient: { readonly moduleId: string; readonly resourceId: string; readonly resourceType: string };
  readonly slotKey: string;
}

const intentFacts = (
  index: number,
  who: Who,
  parts: Parameters<typeof factsOf>[0],
  reason?: string,
): RequestOutcomeFacts['intents'][number] => ({
  intentId: MessageIntentIdSchema.make(`cccccccc-cccc-4ccc-8ccc-${String(index).padStart(12, '0')}`),
  reason,
  recipientRef: decodeRef(who.recipient),
  slotKey: HistorySlotKeySchema.make(who.slotKey),
  summary: summarizeIntent(factsOf(parts)),
});

/** The request-level facts of a decision, as stored: whatever the caller does not name is simply not stated. */
const requestFacts = (
  requiredness: 'OPTIONAL' | 'REQUIRED' | undefined,
  outcome: RequestOutcomeFacts['decision']['outcome'],
  unresolved: readonly { readonly reason: string; readonly slotKey: string }[] = [],
  noMessageReason?: string,
): RequestOutcomeFacts['decision'] => ({
  decisionId: DECISION_ID,
  noMessageReason,
  outcome,
  requiredness,
  unresolvedSlots: unresolved.map(({ reason, slotKey }) => ({ reason, slotKey: HistorySlotKeySchema.make(slotKey) })),
});

/** The outcome feed of a request as its decision stored it: eligible candidates are pending, suppressed ones carry their reason. */
export const feedOfDecision = (decision: CommunicationDecision): CommunicationOutcomeFeed => {
  const candidates = CommunicationOutcome.$match(decision.outcome, {
    Candidates: (found) => found.candidates,
    NoMessage: () => [],
  });
  const unresolvedSlots = CommunicationOutcome.$match(decision.outcome, {
    Candidates: (found) => found.unresolvedSlots,
    NoMessage: (none) => none.unresolvedSlots,
  });
  const noMessage = CommunicationOutcome.$match(decision.outcome, {
    Candidates: () => Option.none<string>(),
    NoMessage: ({ reason }) => Option.some<string>(reason),
  });
  return sourceOutcomeFeedOf({
    decision: requestFacts(
      decision.type.pipe(
        Option.map(({ requiredness }) => requiredness),
        Option.getOrUndefined,
      ),
      candidates.length > 0 ? 'MESSAGE_INTENTS' : 'NO_MESSAGE',
      unresolvedSlots,
      Option.getOrUndefined(noMessage),
    ),
    intents: candidates.map(({ identity, recipient }, index) =>
      RecipientDecision.$match(recipient, {
        Eligible: () => intentFacts(index + 1, identity, {}),
        Suppressed: ({ reason }) => intentFacts(index + 1, identity, { intentStatus: 'SUPPRESSED', reason }, reason),
      }),
    ),
    requestId: REQUEST_ID,
  });
};

/**
 * The outcome feed of a request after the last stoppable handoff decided each of its messages: a stop is stored with its
 * reasons, an unknown effect is an attempt without an answer, a proven handoff is an acceptance, and a message that may proceed
 * is still pending its attempt.
 */
export const feedOfHandoff = (
  requiredness: 'OPTIONAL' | 'REQUIRED',
  decisions: readonly MessageHandoffDecisionCase[],
): CommunicationOutcomeFeed =>
  sourceOutcomeFeedOf({
    decision: requestFacts(requiredness, 'MESSAGE_INTENTS'),
    intents: decisions.map((decision, index) =>
      MessageHandoffDecision.$match(decision, {
        AlreadyHandedOff: ({ identity }) => intentFacts(index + 1, identity, { attempts: [attempt('ACCEPTED')] }),
        Proceed: ({ identity }) => intentFacts(index + 1, identity, {}),
        ReconciliationRequired: ({ identity }) =>
          intentFacts(index + 1, identity, { attempts: [attempt('INDETERMINATE')] }),
        Suppressed: ({ identity, primary, reasons }) =>
          intentFacts(index + 1, identity, {
            stops: [stop({ proven: primary.proven, reasonCodes: reasons.map(stopReasonCodeOf) })],
          }),
      }),
    ),
    requestId: REQUEST_ID,
  });

/** The outcome feed of a request whose messages have exactly these stored facts (one message per entry, all in one slot). */
export const feedOfFacts = (
  requiredness: 'OPTIONAL' | 'REQUIRED',
  messages: readonly Parameters<typeof factsOf>[0][],
): CommunicationOutcomeFeed =>
  sourceOutcomeFeedOf({
    decision: requestFacts(requiredness, 'MESSAGE_INTENTS'),
    intents: messages.map((parts, index) =>
      intentFacts(
        index + 1,
        {
          recipient: {
            moduleId: 'fixture.party',
            resourceId: `recipient-${String(index + 1)}`,
            resourceType: 'fixture.recipient',
          },
          slotKey: 'primary',
        },
        parts,
      ),
    ),
    requestId: REQUEST_ID,
  });

/** What a test asserts about the feed: what the source owner learns, never a derived field of its own. */
export const feedSummary = ({ messages, partial, requiredOutcome, sourceImpact }: CommunicationOutcomeFeed) => ({
  attentions: messages.map(({ attention }) => attention),
  partial,
  reasons: messages.map(({ reason }) => reason),
  requiredOutcome,
  sourceImpact,
});
