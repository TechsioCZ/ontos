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
import type { IntentHistorySummary, RecoveryFacts } from './timeline.ts';

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

const statusAttention = (status: HistoryStatus): MessageAttention =>
  Match.value(status).pipe(
    Match.whenOr('DELIVERED', 'PROVIDER_ACCEPTED', () => 'NO_FAILURE' as const),
    // a handoff that began without an answer is not "in progress": its effect is unknown, reconciled and never resent;
    // a soft bounce is no sure failure either: the delivery is deferred and unknown
    Match.whenOr('DELIVERY_DEFERRED', 'INDETERMINATE', 'PROVIDER_SUBMITTED', () => 'UNKNOWN' as const),
    Match.when('PREPARED', () => 'IN_PROGRESS' as const),
    // a stop that proved nothing is not a failure of the message: it must be evaluated again
    Match.when('HELD_UNPROVEN', () => 'NEEDS_REEVALUATION' as const),
    Match.whenOr('FAILED', 'NO_MESSAGE', 'SUPPRESSED', () => 'FAILURE' as const),
    Match.exhaustive,
  );

/**
 * What the source must do ABOUT this message: a proven failure, an unknown effect, work still in progress, a re-evaluation, a
 * reconciliation of conflicting provider evidence, or nothing. A conflict never erases the headline fact and never softens a
 * PROVEN failure; on any other message it asks for reconciliation instead of reporting a quiet success.
 */
export const attentionOf = (
  status: HistoryStatus,
  needsReconciliation = false,
  recovery?: Pick<RecoveryFacts, 'outcome' | 'proven'>,
): MessageAttention => {
  const attention = statusAttention(status);
  // a PROVEN non-acceptance whose recovery was stopped only because a fact could not be established is not a final failure:
  // nothing is proven against the message and the next Current evaluation may continue it (#1403)
  if (attention === 'FAILURE' && status === 'FAILED' && recovery?.outcome === 'STOPPED' && !recovery.proven) {
    return 'NEEDS_REEVALUATION';
  }
  return needsReconciliation && attention !== 'FAILURE' ? 'NEEDS_RECONCILIATION' : attention;
};

/**
 * The ONE derivation of what the owner says about one message: its attention and its concrete reason. The source outcome feed and
 * the safe history Read (#1409) both call it, so the two can never disagree about what the source must do. The reason is the
 * closed code of the decision, else why recovery did not continue the message.
 */
export const messageHeadlineOf = (summary: IntentHistorySummary, decisionReason: string | undefined) => ({
  attention: attentionOf(summary.status, summary.needsReconciliation, summary.recovery),
  reason: decisionReason ?? summary.recovery?.code,
});

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
  if (attentions.has('UNKNOWN') || attentions.has('NEEDS_RECONCILIATION')) {
    return { partial: false, requiredOutcome: 'UNKNOWN' } as const;
  }
  if (attentions.has('NEEDS_REEVALUATION')) {
    return { partial: false, requiredOutcome: 'NEEDS_REEVALUATION' } as const;
  }
  return { partial: false, requiredOutcome: attentions.has('IN_PROGRESS') ? 'IN_PROGRESS' : 'NO_FAILURE' } as const;
};

/** The typed outcome feed of one request, from the decision and the headline of each of its intents. */
export const sourceOutcomeFeedOf = (facts: RequestOutcomeFacts): CommunicationOutcomeFeed => {
  const messages = facts.intents.map(({ intentId, reason, recipientRef, slotKey, summary }): MessageOutcome => ({
    ...messageHeadlineOf(summary, reason),
    intentId,
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
