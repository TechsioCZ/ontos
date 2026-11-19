import { Match } from 'effect';

import type {
  CommunicationOutcomeFeed,
  HistorySlotKey,
  HistoryStatus,
  MessageAttention,
  MessageOutcome,
} from '../../../shared/communication-history.ts';
import type {
  CommunicationDecisionIdSchema,
  CommunicationRequestIdSchema,
  MessageIntentIdSchema,
} from '../../../shared/communication-intake.ts';
import { isStaleSourceReason } from '../catalog/decision.ts';
import type { IntentHistorySummary } from './timeline.ts';

/**
 * The result Communications gives the SOURCE workflow about one request (#1402, H-13, AC-07). It is derived from the same
 * facts as the history, so the source never learns more or less than the history proves, and it carries references and closed
 * codes only: no address, token, link, markup or provider payload.
 *
 * A required message that did not go out is reported as a Communications RESULT. It never pretends that the source's business
 * fact was committed or rolled back and never changes it: `sourceImpact` is always `SOURCE_OWNER_DECIDES`, because only the
 * source owner decides pausing, recovery or only recording.
 */

export interface RequestOutcomeFacts {
  readonly decision: {
    readonly decisionId: typeof CommunicationDecisionIdSchema.Type;
    readonly noMessageReason: string | undefined;
    readonly outcome: 'MESSAGE_INTENTS' | 'NO_MESSAGE';
    /** Absent when no approved type usable by the issuer carries the purpose. */
    readonly requiredness: 'OPTIONAL' | 'REQUIRED' | undefined;
    readonly unresolvedSlots: readonly { readonly reason: string; readonly slotKey: HistorySlotKey }[];
  };
  readonly intents: readonly {
    readonly intentId: typeof MessageIntentIdSchema.Type;
    readonly reason: string | undefined;
    readonly recipientRef: MessageOutcome['recipientRef'];
    readonly slotKey: HistorySlotKey;
    readonly summary: IntentHistorySummary;
  }[];
  readonly requestId: typeof CommunicationRequestIdSchema.Type;
}

/** What the source must do ABOUT this message: a proven failure, an unknown effect, work still in progress, or nothing. */
export const attentionOf = (status: HistoryStatus): MessageAttention =>
  Match.value(status).pipe(
    Match.whenOr('DELIVERED', 'PROVIDER_ACCEPTED', () => 'NO_FAILURE' as const),
    // a handoff that began without an answer is not "in progress": its effect is unknown, reconciled and never resent
    Match.whenOr('INDETERMINATE', 'PROVIDER_SUBMITTED', () => 'UNKNOWN' as const),
    Match.when('PREPARED', () => 'IN_PROGRESS' as const),
    Match.whenOr('FAILED', 'NO_MESSAGE', 'SUPPRESSED', () => 'FAILURE' as const),
    Match.exhaustive,
  );

const requiredOutcomeOf = (facts: RequestOutcomeFacts, messages: readonly MessageOutcome[]) => {
  const { decision } = facts;
  if (decision.requiredness === undefined) {
    return { partial: false, requiredOutcome: 'REQUIREDNESS_UNKNOWN' } as const;
  }
  if (decision.requiredness === 'OPTIONAL') {
    return { partial: false, requiredOutcome: 'NOT_REQUIRED' } as const;
  }
  if (decision.outcome === 'NO_MESSAGE') {
    const stale = decision.noMessageReason !== undefined && isStaleSourceReason(decision.noMessageReason);
    return { partial: false, requiredOutcome: stale ? 'SOURCE_STALE' : 'FAILED' } as const;
  }
  const attentions = new Set(messages.map(({ attention }) => attention));
  if (attentions.has('FAILURE') || decision.unresolvedSlots.length > 0) {
    // partial: something else of the same request is not a failure
    return { partial: messages.some(({ attention }) => attention !== 'FAILURE'), requiredOutcome: 'FAILED' } as const;
  }
  if (attentions.has('UNKNOWN')) {
    return { partial: false, requiredOutcome: 'UNKNOWN' } as const;
  }
  return { partial: false, requiredOutcome: attentions.has('IN_PROGRESS') ? 'IN_PROGRESS' : 'NO_FAILURE' } as const;
};

/** The typed outcome feed of one request, from the decision and the headline of each of its intents. */
export const sourceOutcomeFeedOf = (facts: RequestOutcomeFacts): CommunicationOutcomeFeed => {
  const messages = facts.intents.map(({ intentId, reason, recipientRef, slotKey, summary }): MessageOutcome => ({
    attention: attentionOf(summary.status),
    intentId,
    reason,
    recipientRef,
    slotKey,
    status: summary.status,
  }));
  const { partial, requiredOutcome } = requiredOutcomeOf(facts, messages);
  const { decision } = facts;
  return {
    decisionId: decision.decisionId,
    messages,
    noMessageReason: decision.noMessageReason,
    partial,
    requestId: facts.requestId,
    requiredOutcome,
    sourceImpact: 'SOURCE_OWNER_DECIDES',
    unresolvedSlots: decision.unresolvedSlots.map(({ reason, slotKey }) => ({ reason, slotKey })),
  };
};
