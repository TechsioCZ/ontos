import { CommunicationResourceRefSchema } from '@app/communications-contracts/communication-request';
import { OntosModuleIdSchema } from '@app/core-runtime/modules/manifest';
import { LegalEntityRefSchema } from '@app/core-runtime/resources/legal-entity';
import { Schema } from 'effect';

import { HistorySlotKeySchema, HistoryStatusSchema, MessageAttentionSchema } from './communication-history.ts';
import {
  CommunicationDecisionIdSchema,
  CommunicationRequestIdSchema,
  MessageIntentIdSchema,
} from './communication-intake.ts';
import {
  TemplateLifecycleStateSchema,
  TemplatePrincipalIdSchema,
  TemplateRevisionIdSchema,
  TemplateScopeSchema,
  TemplateTextSourceSchema,
} from './template-revision.ts';

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
  /** The digest of the exact subject and body used (#1406); a fingerprint, never the text and never a secret. */
  contentDigest: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u))),
  language: Schema.Literals(['cs', 'en']),
  messageType: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
  mode: Schema.optionalKey(Schema.Literals(['A', 'B'])),
  notice: Schema.Literal(TEMPLATE_PREVIEW_MARKER),
  /** The Tenant revision number, or the catalog version of the built-in default text. */
  revisionNumber: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** Which text the message used: the Tenant's own revision or the built-in default (#1398, #1406). */
  source: TemplateTextSourceSchema,
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

/** One document the owner approved for disclosure with the message: a reference and a form, never a byte, link or name. */
export const MessageHistoryDocumentSchema = Schema.Struct({
  document: CommunicationResourceRefSchema,
  form: Schema.Literals(['ATTACHMENT', 'LINK']),
  pinnedAt: Schema.DateTimeUtcFromString,
  position: Schema.Int.check(Schema.isBetween({ maximum: 9, minimum: 0 })),
});
export type MessageHistoryDocument = typeof MessageHistoryDocumentSchema.Type;

/**
 * Explicit Resend, told from either end (#1402 D9, AC-09): `RESEND_OF` says this message was issued as a new request to resend
 * the named original; `RESENT_AS` says the named message is a resend of this one. The reason is from the closed approved list.
 */
export const MessageHistoryResendLinkSchema = Schema.Struct({
  direction: Schema.Literals(['RESEND_OF', 'RESENT_AS']),
  intentId: MessageIntentIdSchema,
  kind: Schema.Literal('EXPLICIT_RESEND'),
  reasonCode: ClosedCodeSchema,
});
/**
 * Technical Retry (#1402 H-09, #1403): a later attempt of the SAME message, with the earlier attempt it follows and why that one
 * no longer blocked it. Both attempt numbers are named, so the link explains itself from either attempt.
 */
export const MessageHistoryRetryLinkSchema = Schema.Struct({
  attemptNumber: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  basisKind: Schema.Literals(['PRIOR_NOT_ATTEMPTED', 'PRIOR_REJECTED', 'RECONCILED_NON_ACCEPTANCE']),
  kind: Schema.Literal('TECHNICAL_RETRY'),
  previousAttemptNumber: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  reasonCode: ClosedCodeSchema,
});
export const MessageHistoryLinkSchema = Schema.Union([MessageHistoryResendLinkSchema, MessageHistoryRetryLinkSchema]);
export type MessageHistoryLink = typeof MessageHistoryLinkSchema.Type;

/**
 * The audit of the template a message used (#1398 AC-02, T-07): which revision, whether it was in force at the decision, and who
 * activated it, when, for which scope and why. It carries identity, a digest, a Principal reference and the reason the
 * administrator gave (bounded text, never a template text), so it has its OWN field permission and is omitted without it.
 */
export const MessageHistoryTemplateUseSchema = Schema.Struct({
  activation: Schema.optionalKey(
    Schema.Struct({
      activatedAt: Schema.DateTimeUtcFromString,
      activatedByPrincipalId: TemplatePrincipalIdSchema,
      reason: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(500)),
      scope: TemplateScopeSchema,
    }),
  ),
  activeAtDecisionTime: Schema.Boolean,
  contentDigest: Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u)),
  lifecycleState: TemplateLifecycleStateSchema,
  revisionId: TemplateRevisionIdSchema,
  revisionNumber: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  scope: TemplateScopeSchema,
  source: TemplateTextSourceSchema,
});
export type MessageHistoryTemplateUse = typeof MessageHistoryTemplateUseSchema.Type;

export const MessageHistoryItemSchema = Schema.Struct({
  decidedAt: Schema.DateTimeUtcFromString,
  /** The documents the owner disclosed with this message, in the order they were pinned; empty when none. */
  documents: Schema.Array(MessageHistoryDocumentSchema),
  headline: MessageHistoryHeadlineSchema,
  intentId: MessageIntentIdSchema,
  lastEventAt: Schema.DateTimeUtcFromString,
  /** Explicit Resend and Technical Retry links of this message, from either end; empty when it has none. */
  links: Schema.Array(MessageHistoryLinkSchema),
  recipient: MessageHistoryRecipientSchema,
  requestId: CommunicationRequestIdSchema,
  slotKey: HistorySlotKeySchema,
  source: MessageHistorySourceSchema,
  /** Absent when the message was stopped before any template was pinned. */
  template: Schema.optionalKey(MessageHistoryTemplateSchema),
  /** Governed by its own field permission: omitted from the result when the caller may not read it, and from a list. */
  templateUse: Schema.optionalKey(MessageHistoryTemplateUseSchema),
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
  'INTENT_NOT_SENT',
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
  /** The Explicit Resend or Technical Retry links this fact belongs to; absent when it has none. */
  links: Schema.optionalKey(Schema.Array(MessageHistoryLinkSchema)),
  observationKind: Schema.optionalKey(TimelineObservationKindSchema),
  occurredAt: Schema.DateTimeUtcFromString,
  outOfOrder: Schema.Boolean,
  reasonCodes: Schema.Array(ClosedCodeSchema),
  recordedAt: Schema.DateTimeUtcFromString,
  status: HistoryStatusSchema,
  technical: Schema.optionalKey(TimelineTechnicalEvidenceSchema),
});
export type MessageHistoryTimelineEntry = typeof MessageHistoryTimelineEntrySchema.Type;

/**
 * A request the catalog decided NO message for, or that left a slot unresolved (#1402 H-01, AC-01; #1401 I-07): a readable row
 * of its own, because it has no Message Intent to list. `NO_MESSAGE` is the catalog's zero-message decision; `NOT_SENT` is a
 * request whose slots could not be resolved to a legal recipient, so those messages do not exist. Neither is a provider failure
 * and neither is a delivered message.
 */
export const MessageHistoryRequestItemSchema = Schema.Struct({
  decidedAt: Schema.DateTimeUtcFromString,
  decisionId: CommunicationDecisionIdSchema,
  headline: Schema.Struct({
    /** The closed reason of the no-message decision, when there is one. */
    reasonCodes: Schema.Array(ClosedCodeSchema),
    status: Schema.Literals(['NO_MESSAGE', 'NOT_SENT']),
  }),
  requestId: CommunicationRequestIdSchema,
  source: MessageHistorySourceSchema,
  /** Slots a required type could not resolve to a recipient, each with its closed reason. */
  unresolvedSlots: Schema.Array(Schema.Struct({ reason: ClosedCodeSchema, slotKey: HistorySlotKeySchema })),
});
export type MessageHistoryRequestItem = typeof MessageHistoryRequestItemSchema.Type;

/**
 * The position after the last returned row (newest first). A row is a message (by its intent) or a request-level decision (by its
 * request); both are ordered by their decision time and then by their identity. The caller only echoes it back; the scope is
 * never taken from it.
 */
export const MessageHistoryCursorSchema = Schema.Union([
  Schema.Struct({ createdAt: Schema.DateTimeUtcFromString, intentId: MessageIntentIdSchema }),
  Schema.Struct({ createdAt: Schema.DateTimeUtcFromString, requestId: CommunicationRequestIdSchema }),
]);
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
  /** Present exactly when more rows exist after this page. */
  nextCursor: Schema.optionalKey(MessageHistoryCursorSchema),
  /** The request-level rows of this page (no-message and unresolved decisions); absent when the page has none. */
  requests: Schema.optionalKey(Schema.Array(MessageHistoryRequestItemSchema)),
});

/** The detail of ONE message (by its intent), or of ONE request-level decision that has no message (by its request). */
export const MessageHistoryDetailResultSchema = Schema.Union([
  Schema.Struct({
    message: MessageHistoryItemSchema,
    timeline: Schema.Array(MessageHistoryTimelineEntrySchema),
  }),
  Schema.Struct({ request: MessageHistoryRequestItemSchema }),
]);
