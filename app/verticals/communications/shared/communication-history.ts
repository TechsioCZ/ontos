import { CommunicationResourceRefSchema } from '@app/communications-contracts/communication-request';
import { Schema } from 'effect';

import {
  CommunicationDecisionIdSchema,
  CommunicationRequestIdSchema,
  MessageIntentIdSchema,
} from './communication-intake.ts';

/**
 * Published, schema-only vocabulary of the truthful message history (#1402) and the result Communications gives the
 * SOURCE workflow. It carries references and closed codes only: no address, secret, token, link, markup or provider payload
 * can be represented in it, so nothing here can leak by construction.
 *
 * Reading history is NOT part of this contract (that is the access lane, d21-09); this is only what the history MEANS.
 */

const closedCode = Schema.String.check(Schema.isMaxLength(80), Schema.isPattern(/^[A-Za-z][A-Za-z0-9_]*$/u));
export const HistorySlotKeySchema = Schema.String.check(Schema.isMaxLength(120)).pipe(
  Schema.brand('CommunicationHistorySlotKey'),
);
export type HistorySlotKey = typeof HistorySlotKeySchema.Type;

/**
 * What a message is, as far as it can be PROVEN. Each value is its own fact and none implies the next:
 * - NO_MESSAGE: the catalog decided that no concrete message exists. There is no intent and never an attempt;
 * - SUPPRESSED: a concrete intended message was stopped by a PROVEN Current fact. Not a provider failure;
 * - HELD_UNPROVEN: a concrete intended message was stopped only because a fact could not be established (an owner or an
 *   authority was unavailable, a mandatory input was not evidenced). Nothing is proven against the message: it is neither
 *   sent nor suppressed and must be re-evaluated, with the stop reason kept;
 * - PREPARED: an intent exists and was not handed to a provider. No provider was asked;
 * - PROVIDER_SUBMITTED: the handoff was begun and no provider answer is recorded. The effect is UNKNOWN; this is
 *   neither acceptance nor failure and no further send is allowed until it is reconciled;
 * - PROVIDER_ACCEPTED: the provider accepted the SUBMISSION. It says nothing about the recipient's inbox;
 * - DELIVERED: real provider delivery evidence exists. Never derived from an acceptance;
 * - DELIVERY_DEFERRED: the provider accepted it and then reported a TRANSIENT problem (a soft bounce). It is not a sure
 *   failure: it ends as DELIVERED or FAILED only with a later conclusive provider event;
 * - FAILED: a PROVEN failure: the provider refused the submission, a non-acceptance was proven, or a provider event proved a
 *   permanent failure after acceptance (the acceptance stays in the history);
 * - INDETERMINATE: an external fact is unknown (timeout, unreadable answer, unavailable provider, contradictory evidence). It
 *   is NOT the Privacy `INDETERMINATE` and is never a sure failure.
 */
export const HistoryStatusSchema = Schema.Literals([
  'NO_MESSAGE',
  'SUPPRESSED',
  'HELD_UNPROVEN',
  'PREPARED',
  'PROVIDER_SUBMITTED',
  'PROVIDER_ACCEPTED',
  'DELIVERED',
  'DELIVERY_DEFERRED',
  'FAILED',
  'INDETERMINATE',
]);
export type HistoryStatus = typeof HistoryStatusSchema.Type;

/**
 * What the source workflow must know about one message:
 * - FAILURE: a proven failure or a proven suppression; - NO_FAILURE: accepted or delivered;
 * - IN_PROGRESS: prepared, not handed over yet; - UNKNOWN: the external effect is unknown or deferred (reconcile, never resend);
 * - NEEDS_RECONCILIATION: the provider evidence of this message disagrees with itself (the same observation arrived again with
 *   another content); the earlier fact is kept and the disagreement must be reconciled;
 * - NEEDS_REEVALUATION: stopped without proof (HELD_UNPROVEN): the owner must re-evaluate it.
 * `SOURCE_OWNER_DECIDES` is the only impact Communications states.
 */
export const MessageAttentionSchema = Schema.Literals([
  'FAILURE',
  'IN_PROGRESS',
  'NEEDS_RECONCILIATION',
  'NEEDS_REEVALUATION',
  'NO_FAILURE',
  'UNKNOWN',
]);
export type MessageAttention = typeof MessageAttentionSchema.Type;

export const MessageOutcomeSchema = Schema.Struct({
  attention: MessageAttentionSchema,
  intentId: MessageIntentIdSchema,
  /** The safe closed reason of a suppression, when there is one. */
  reason: Schema.optional(closedCode),
  recipientRef: CommunicationResourceRefSchema,
  slotKey: HistorySlotKeySchema,
  status: HistoryStatusSchema,
});
export type MessageOutcome = typeof MessageOutcomeSchema.Type;

/**
 * The aggregate the source owner receives for ONE request. It is information, never an order:
 * - NOT_REQUIRED: the approved type is optional; nothing is owed;
 * - REQUIREDNESS_UNKNOWN: no approved type usable by the source carries the purpose;
 * - SOURCE_STALE: the source's own change made the request stale; Communications owes no failure;
 * - FAILED: at least one required message is proven not to be, or not to be able to be, sent (`partial` when others are fine);
 * - UNKNOWN: no proven failure, but at least one required message has an unknown provider effect or provider evidence that
 *   needs reconciliation (reconcile, never resend);
 * - NEEDS_REEVALUATION: no proven failure or unknown effect, but at least one required message was held only because a fact
 *   could not be established: nothing is proven against it, it was not sent and must be re-evaluated;
 * - IN_PROGRESS: nothing failed or unknown yet, some required message is still on its way;
 * - NO_FAILURE: every required message is at least provider-accepted. This is NOT delivery.
 */
export const RequiredOutcomeSchema = Schema.Literals([
  'FAILED',
  'IN_PROGRESS',
  'NEEDS_REEVALUATION',
  'NOT_REQUIRED',
  'NO_FAILURE',
  'REQUIREDNESS_UNKNOWN',
  'SOURCE_STALE',
  'UNKNOWN',
]);

export const CommunicationOutcomeFeedSchema = Schema.Struct({
  decisionId: CommunicationDecisionIdSchema,
  messages: Schema.Array(MessageOutcomeSchema),
  /** Present only when the catalog decided that no message exists: the safe closed reason. */
  noMessageReason: Schema.optional(closedCode),
  /** True when some required message failed while others did not: the source must not read it as all-or-nothing. */
  partial: Schema.Boolean,
  requestId: CommunicationRequestIdSchema,
  requiredOutcome: RequiredOutcomeSchema,
  /** Communications never commits, rolls back or repairs source state: the source owner alone decides its impact. */
  sourceImpact: Schema.Literal('SOURCE_OWNER_DECIDES'),
  /** Slots a required type could not resolve to a recipient (closed reason per slot). */
  unresolvedSlots: Schema.Array(Schema.Struct({ reason: closedCode, slotKey: HistorySlotKeySchema })),
});
export type CommunicationOutcomeFeed = typeof CommunicationOutcomeFeedSchema.Type;
