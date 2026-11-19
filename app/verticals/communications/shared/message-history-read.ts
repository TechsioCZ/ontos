import { CommunicationResourceRefSchema } from '@app/communications-contracts/communication-request';
import { OntosModuleIdSchema } from '@app/core-runtime/modules/manifest';
import { LegalEntityRefSchema } from '@app/core-runtime/resources/legal-entity';
import { Schema } from 'effect';

import { HistorySlotKeySchema, HistoryStatusSchema, MessageAttentionSchema } from './communication-history.ts';
import { CommunicationRequestIdSchema, MessageIntentIdSchema } from './communication-intake.ts';

/**
 * Published, schema-only SAFE projection of the message history (#1409). This is the ONLY shape a history Read can
 * return: a typed allow-list of fields, so a body, a template text, an address, a link, a token, a provider payload or a
 * secret has no field to travel in, whatever the store holds (ACC-01, ACC-05). Reading history is never reading the
 * source Resource: every source fact is a `ResourceRef`, and a reference grants nothing (ACC-03).
 *
 * The template revision is shown as a PREVIEW marker only: the text of a revision is not the e-mail that was sent
 * (ACC-01, AC-04), and no personalised body is stored or rebuilt anywhere.
 */

/**
 * The one technical page cap of the history list, defined once. It bounds one response and the work of one Read; it
 * is not a business number. A larger `limit` is refused at decoding instead of being silently clamped.
 */
export const MESSAGE_HISTORY_MAX_PAGE_SIZE = 50;

/** Closed marker every returned template pin carries: the revision is a preview, not proof of the sent text. */
export const TEMPLATE_PREVIEW_MARKER = 'TEMPLATE_PREVIEW_NOT_EXACT_SENT_EMAIL';
/** The fixed wording a surface shows for the marker. Never a template text. */
export const TEMPLATE_PREVIEW_NOTICE = 'template preview, not the exact sent e-mail';

/** A closed code: a letter, then letters, digits and underscores. No free text, address, link or markup fits. */
const ClosedCodeSchema = Schema.String.check(Schema.isMaxLength(80), Schema.isPattern(/^[A-Za-z][A-Za-z0-9_]*$/u));

const OccurrenceIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
).pipe(Schema.brand('CommunicationOccurrenceId'));
const MessageTypeIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)).pipe(
  Schema.brand('CommunicationMessageTypeId'),
);

/**
 * The ONE fixed shape of a mask, defined once: at most three visible characters, then at least three hiding characters, then
 * either nothing, a short visible tail of at most four characters, or `@` and a domain without any whitespace or another `@`.
 * A text that shows the local part of an address (`*john.smith@example.com`), shows nothing hidden or has another shape is
 * not a mask, however many hiding characters it contains.
 */
export const ENDPOINT_MASK_MAX_VISIBLE_PREFIX = 3;
export const ENDPOINT_MASK_MIN_HIDDEN = 3;
export const ENDPOINT_MASK_MAX_VISIBLE_TAIL = 4;
export const ENDPOINT_MASK_MAX_DOMAIN = 60;
const ENDPOINT_MASK_PATTERN = new RegExp(
  `^[^\\s@*\u2022]{0,${String(ENDPOINT_MASK_MAX_VISIBLE_PREFIX)}}[*\u2022]{${String(ENDPOINT_MASK_MIN_HIDDEN)},}` +
    `(?:@[^\\s@]{1,${String(ENDPOINT_MASK_MAX_DOMAIN)}}|[^\\s@*\u2022]{0,${String(ENDPOINT_MASK_MAX_VISIBLE_TAIL)}})$`,
  'u',
);

/**
 * The owner's mask of the ORIGINAL endpoint. It is representable only when it is structurally a mask (the fixed shape above):
 * a text that reads as a whole address, or hides nothing, cannot be one. The stored mask was vetted when it was stored; this is
 * the independent second check of the projection.
 */
export const EndpointMaskSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
  Schema.isPattern(ENDPOINT_MASK_PATTERN),
);

export const HistoryChannelSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(40),
  Schema.isPattern(/^[a-z][a-z0-9-]*$/u),
);

/**
 * The EXACT scope a history is read in. Every dimension is a reference; an absent dimension selects only requests that
 * have none: the scope is matched exactly, never widened (ACC-02). Tenant and Legal Entity are not request fields:
 * Core's trusted operation scope is the only way to choose them.
 */
export const HistorySourceScopeSelectionSchema = Schema.Struct({
  counterpartyRef: Schema.optionalKey(CommunicationResourceRefSchema),
  profileRef: Schema.optionalKey(CommunicationResourceRefSchema),
  storefrontRef: Schema.optionalKey(CommunicationResourceRefSchema),
});
export type HistorySourceScopeSelection = typeof HistorySourceScopeSelectionSchema.Type;

/** The scope a listed message was requested in, as references only. */
export const MessageHistoryScopeSchema = Schema.Struct({
  ...HistorySourceScopeSelectionSchema.fields,
  legalEntityId: Schema.optionalKey(LegalEntityRefSchema.fields.resourceId),
});

export const MessageHistorySourceSchema = Schema.Struct({
  moduleId: OntosModuleIdSchema,
  occurrence: Schema.Struct({
    occurrenceId: OccurrenceIdSchema,
    revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }),
  /** The business purpose the source asked for, as its stable key. */
  purpose: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  scope: MessageHistoryScopeSchema,
});

/** The ORIGINAL recipient: a reference and a role, and the owner's mask unless the caller may not read it. */
export const MessageHistoryRecipientSchema = Schema.Struct({
  channel: Schema.optionalKey(HistoryChannelSchema),
  /** Governed by its own field permission: omitted from the result when the caller may not read it. */
  endpointMask: Schema.optionalKey(EndpointMaskSchema),
  ref: CommunicationResourceRefSchema,
  role: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
});

/** The language and template pins the message was decided under. The notice marks them as a preview, never as the sent text. */
export const MessageHistoryTemplateSchema = Schema.Struct({
  language: Schema.Literals(['cs', 'en']),
  messageType: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
  mode: Schema.optionalKey(Schema.Literals(['A', 'B'])),
  notice: Schema.Literal(TEMPLATE_PREVIEW_MARKER),
  revisionNumber: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

/** What the facts PROVE about the message, and nothing stronger; the same vocabulary the source outcome feed uses. */
export const MessageHistoryHeadlineSchema = Schema.Struct({
  attention: MessageAttentionSchema,
  contradictory: Schema.Boolean,
  deliveryProven: Schema.Boolean,
  needsReconciliation: Schema.Boolean,
  providerAccepted: Schema.Boolean,
  /** Closed reasons of a suppression or of a held or stopped handoff, in the order they were recorded. */
  reasonCodes: Schema.Array(ClosedCodeSchema),
  status: HistoryStatusSchema,
});

export const MessageHistoryItemSchema = Schema.Struct({
  decidedAt: Schema.DateTimeUtcFromString,
  headline: MessageHistoryHeadlineSchema,
  intentId: MessageIntentIdSchema,
  lastEventAt: Schema.DateTimeUtcFromString,
  recipient: MessageHistoryRecipientSchema,
  requestId: CommunicationRequestIdSchema,
  slotKey: HistorySlotKeySchema,
  source: MessageHistorySourceSchema,
  /** Absent when the message was stopped before any template was pinned. */
  template: Schema.optionalKey(MessageHistoryTemplateSchema),
  type: Schema.Struct({
    typeId: MessageTypeIdSchema,
    typeRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }),
});
export type MessageHistoryItem = typeof MessageHistoryItemSchema.Type;

/** The kinds of fact a timeline entry can be. Kept in step with the history domain by the projection's types. */
export const TimelineEntryKindSchema = Schema.Literals([
  'ATTEMPT_PREPARED',
  'HANDOFF_STOPPED',
  'INTENT_PREPARED',
  'INTENT_SUPPRESSED',
  'OBSERVATION_CONFLICTED',
  'PROVIDER_OBSERVED',
  'SUBMISSION_ANSWERED',
]);
export const TimelineObservationKindSchema = Schema.Literals([
  'ACCEPTANCE_PROVEN',
  'DELIVERY_FAILED',
  'DELIVERY_PROVEN',
  'NON_ACCEPTANCE_PROVEN',
]);
export const TimelineTechnicalEvidenceSchema = Schema.Literals([
  'ACCEPTANCE_INDETERMINATE',
  'MESSAGE_INVALID',
  'NOT_ATTEMPTED',
  'PROVIDER_ACCEPTED',
  'PROVIDER_REJECTED',
  'PROVIDER_UNAVAILABLE',
  'SUBMISSION_STARTED',
]);

/**
 * One provider observation or decision fact. No attempt or provider identity, payload, address or link: the entry says
 * WHAT was proven and WHEN, with the closed reasons. The provider's clock is a claim (`occurredAt`), the order is this
 * owner's own (`outOfOrder` marks a late callback; both facts stay).
 */
export const MessageHistoryTimelineEntrySchema = Schema.Struct({
  /** Absent for a fact that belongs to no attempt (the decision of the intent). */
  attemptNumber: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  kind: TimelineEntryKindSchema,
  observationKind: Schema.optionalKey(TimelineObservationKindSchema),
  occurredAt: Schema.DateTimeUtcFromString,
  outOfOrder: Schema.Boolean,
  reasonCodes: Schema.Array(ClosedCodeSchema),
  recordedAt: Schema.DateTimeUtcFromString,
  status: HistoryStatusSchema,
  technical: Schema.optionalKey(TimelineTechnicalEvidenceSchema),
});
export type MessageHistoryTimelineEntry = typeof MessageHistoryTimelineEntrySchema.Type;

/** The position after the last returned message (newest first). The caller only echoes it back; the scope is never taken from it. */
export const MessageHistoryCursorSchema = Schema.Struct({
  createdAt: Schema.DateTimeUtcFromString,
  intentId: MessageIntentIdSchema,
});
export type MessageHistoryCursor = typeof MessageHistoryCursorSchema.Type;

export const MessageHistoryListRequestFieldsSchema = Schema.Struct({
  cursor: Schema.optionalKey(MessageHistoryCursorSchema),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(MESSAGE_HISTORY_MAX_PAGE_SIZE)),
  ),
  occurrenceId: Schema.optionalKey(OccurrenceIdSchema),
  purpose: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))),
  scope: Schema.optionalKey(HistorySourceScopeSelectionSchema),
  sourceModule: Schema.optionalKey(OntosModuleIdSchema),
});

export const MessageHistoryListResultSchema = Schema.Struct({
  items: Schema.Array(MessageHistoryItemSchema),
  /** Present exactly when more messages exist after this page. */
  nextCursor: Schema.optionalKey(MessageHistoryCursorSchema),
});

export const MessageHistoryDetailResultSchema = Schema.Struct({
  message: MessageHistoryItemSchema,
  timeline: Schema.Array(MessageHistoryTimelineEntrySchema),
});
