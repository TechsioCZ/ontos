import {
  CommunicationRequestSchema,
  CommunicationResourceRefSchema,
} from '@app/communications-contracts/communication-request';
import { Schema } from 'effect';

/**
 * Public contract of the Communication Request intake (#1401). The payload IS the published, schema-only request of
 * `@app/communications-contracts`: this owner keeps no second copy of it, so the contract and the intake cannot
 * drift. The scope inside it is a CLAIM of the source, checked against the trusted operation scope and never used to
 * choose where anything is stored.
 *
 * The result is the stored decision of the request, so a duplicate returns exactly what the first call returned.
 * Nothing in it claims transport, provider acceptance or delivery: `PENDING_HANDOFF` only says the intent is decided,
 * pinned and queued for the last stoppable handoff.
 */
export const SubmitCommunicationRequestPayloadSchema = CommunicationRequestSchema;
export type SubmitCommunicationRequestPayload = typeof SubmitCommunicationRequestPayloadSchema.Type;

const uuid = Schema.String.check(Schema.isUUID());
const closedCode = Schema.String.check(Schema.isMaxLength(80), Schema.isPattern(/^[A-Z][A-Z0-9_]*$/u));

/** The four durable identities of one communication. Each is its own type, so none can stand in for another. */
export const CommunicationRequestIdSchema = uuid.pipe(Schema.brand('CommunicationRequestId'));
export const CommunicationDecisionIdSchema = uuid.pipe(Schema.brand('CommunicationDecisionId'));
export const MessageIntentIdSchema = uuid.pipe(Schema.brand('MessageIntentId'));
export const DeliveryAttemptIdSchema = uuid.pipe(Schema.brand('DeliveryAttemptId'));
const SlotKeySchema = Schema.String.check(Schema.isMaxLength(120)).pipe(Schema.brand('CommunicationAudienceSlotKey'));
const RuleKeySchema = Schema.String.check(Schema.isMaxLength(120)).pipe(Schema.brand('CommunicationApprovedRuleKey'));

/**
 * One Message Intent as the source learns it:
 * - PENDING_HANDOFF: decided, pinned and queued; the last stoppable handoff still re-checks every Current fact;
 * - SUPPRESSED: a concrete message was stopped at decision time by a Current fact (`reason`), never delivered;
 * - NOT_SENT: the message cannot be pinned to an approved template revision (`reason`), never delivered.
 */
export const MessageIntentStatusSchema = Schema.Literals(['PENDING_HANDOFF', 'SUPPRESSED', 'NOT_SENT']);
export type MessageIntentStatus = typeof MessageIntentStatusSchema.Type;

export const MessageIntentSummarySchema = Schema.Struct({
  intentId: MessageIntentIdSchema,
  reason: Schema.optionalKey(closedCode),
  recipientRef: CommunicationResourceRefSchema,
  slotKey: SlotKeySchema,
  status: MessageIntentStatusSchema,
});
export type MessageIntentSummary = typeof MessageIntentSummarySchema.Type;

export const CommunicationDecisionViewSchema = Schema.Union([
  Schema.Struct({
    intents: Schema.Array(MessageIntentSummarySchema),
    kind: Schema.Literal('MESSAGE_INTENTS'),
    unresolvedSlots: Schema.Array(Schema.Struct({ reason: closedCode, slotKey: SlotKeySchema })),
  }),
  Schema.Struct({
    kind: Schema.Literal('NO_MESSAGE'),
    reason: closedCode,
    ruleKey: Schema.optionalKey(RuleKeySchema),
  }),
]);
export type CommunicationDecisionView = typeof CommunicationDecisionViewSchema.Type;

export const SubmitCommunicationRequestResultSchema = Schema.Union([
  Schema.Struct({
    decision: CommunicationDecisionViewSchema,
    decisionId: CommunicationDecisionIdSchema,
    outcome: Schema.Literal('DECIDED'),
    /** True when this call only returned the stored decision of an earlier identical request. */
    replayed: Schema.Boolean,
    requestId: CommunicationRequestIdSchema,
    /** Absent when no approved type carries the purpose, so requiredness cannot be asserted. */
    requiredness: Schema.optionalKey(Schema.Literals(['REQUIRED', 'OPTIONAL'])),
  }),
  /**
   * The same source identity arrived with a different material meaning. The original decision is untouched and no
   * message is created; the conflict itself is recorded.
   */
  Schema.Struct({
    conflictingFingerprint: Schema.String,
    originalDecisionId: CommunicationDecisionIdSchema,
    outcome: Schema.Literal('CONFLICT'),
    requestId: CommunicationRequestIdSchema,
  }),
]);
export type SubmitCommunicationRequestResult = typeof SubmitCommunicationRequestResultSchema.Type;
