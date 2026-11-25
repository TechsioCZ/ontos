import { Schema } from 'effect';

/**
 * Template Type and Template Revision contract (#1398). A Template Type is the stable identity of one transactional
 * template per message type, channel, language and allowed scope; a Template Revision is one immutable text of it.
 * Nothing here carries a recipient, a token or any personalised value: placeholders are names, never values.
 */
const uuid = Schema.String.check(Schema.isUUID());
export const TemplateTypeIdSchema = uuid.pipe(Schema.brand('TemplateTypeId'));
export const TemplateRevisionIdSchema = uuid.pipe(Schema.brand('TemplateRevisionId'));
export const TemplateActivationIdSchema = uuid.pipe(Schema.brand('TemplateActivationId'));
export const TemplatePrincipalIdSchema = uuid.pipe(Schema.brand('TemplatePrincipalId'));
export const TemplateLegalEntityIdSchema = uuid.pipe(Schema.brand('TemplateLegalEntityId'));
export const TemplateScopeKeySchema = Schema.String.pipe(Schema.brand('TemplateScopeKey'));
const timestamp = Schema.DateTimeUtcFromString;
const reasonText = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(500));

/** The approved message type key; the catalog lane owns which keys exist, this lane only keeps the key well-formed. */
export const TemplateMessageTypeSchema = Schema.String.check(
  Schema.isMaxLength(120),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u),
);
/** Email is the only channel approved for step 21. */
export const TemplateChannelSchema = Schema.Literal('email');
/** The approved initial language scope (#1399 PO 2A). */
export const TemplateLanguageSchema = Schema.Literals(['cs', 'en']);
export const TemplatePlaceholderNameSchema = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z][a-z0-9_]*$/u),
);
/** Tenant-wide, or one Legal Entity; brand scope exists only where an approved owner rule introduces it. */
export const TemplateScopeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('tenant') }),
  Schema.Struct({ kind: Schema.Literal('legal-entity'), legalEntityId: TemplateLegalEntityIdSchema }),
]);
export type TemplateScope = typeof TemplateScopeSchema.Type;

export const TemplateIdentitySchema = Schema.Struct({
  channel: TemplateChannelSchema,
  language: TemplateLanguageSchema,
  messageType: TemplateMessageTypeSchema,
  scope: TemplateScopeSchema,
});
export type TemplateIdentity = typeof TemplateIdentitySchema.Type;

/** Stable scope identity string, also the persisted `scope_key`. */
export const templateScopeKey = (scope: TemplateScope): string =>
  scope.kind === 'tenant' ? 'tenant' : `legal-entity:${scope.legalEntityId}`;

export const PrepareTemplateRevisionPayloadSchema = Schema.Struct({
  ...TemplateIdentitySchema.fields,
  body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
  optionalPlaceholders: Schema.Array(TemplatePlaceholderNameSchema).check(Schema.isMaxLength(50)),
  reason: reasonText,
  requiredPlaceholders: Schema.Array(TemplatePlaceholderNameSchema).check(Schema.isMaxLength(50)),
  subject: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
});
export const PrepareTemplateRevisionResultSchema = Schema.Struct({
  contentDigest: Schema.String,
  revisionId: TemplateRevisionIdSchema,
  revisionNumber: Schema.Number,
  templateTypeId: TemplateTypeIdSchema,
});

export const ActivateTemplateRevisionPayloadSchema = Schema.Struct({
  reason: reasonText,
  revisionId: TemplateRevisionIdSchema,
});
export const ActivateTemplateRevisionResultSchema = Schema.Struct({
  activatedAt: timestamp,
  activationId: TemplateActivationIdSchema,
  replacedRevisionId: Schema.optional(TemplateRevisionIdSchema),
  revisionId: TemplateRevisionIdSchema,
  revisionNumber: Schema.Number,
  templateTypeId: TemplateTypeIdSchema,
});

export const DeactivateTemplateRevisionPayloadSchema = Schema.Struct({
  reason: reasonText,
  revisionId: TemplateRevisionIdSchema,
});
export const DeactivateTemplateRevisionResultSchema = Schema.Struct({
  activationId: TemplateActivationIdSchema,
  endedAt: timestamp,
  revisionId: TemplateRevisionIdSchema,
  templateTypeId: TemplateTypeIdSchema,
});

export const InvalidateTemplateRevisionPayloadSchema = Schema.Struct({
  reason: reasonText,
  revisionId: TemplateRevisionIdSchema,
});
export const InvalidateTemplateRevisionResultSchema = Schema.Struct({
  endedActivationId: Schema.optional(TemplateActivationIdSchema),
  invalidatedAt: timestamp,
  revisionId: TemplateRevisionIdSchema,
});

/**
 * Which text a message used (#1398): only a revision an authorised administrator of the Tenant prepared AND activated.
 * There is no shared or built-in text, so a message can never name any other source (R-D1).
 */
export const TemplateTextSourceSchema = Schema.Literal('TENANT_REVISION');
export type TemplateTextSource = typeof TemplateTextSourceSchema.Type;

/**
 * The pin the Message Intent lane stores at the first approved creation of one intent. A retry reuses it verbatim and
 * never resolves again; only a new business request resolves a new pin against the then-active revision. Its identity
 * records the scope of the revision that was CHOSEN: a Legal Entity request that fell back to the Tenant-wide approved
 * revision (R-D7) carries the Tenant scope here, never the scope it was asked in.
 */
export const TemplatePinSchema = Schema.Struct({
  ...TemplateIdentitySchema.fields,
  /** The digest of the exact subject, body and declared placeholders the message uses. */
  contentDigest: Schema.optionalKey(Schema.String),
  decisionTime: timestamp,
  revisionId: TemplateRevisionIdSchema,
  revisionNumber: Schema.Number,
  /** Always a Tenant revision; absent only on a pin stored before the source was recorded. */
  source: Schema.optionalKey(TemplateTextSourceSchema),
  templateTypeId: TemplateTypeIdSchema,
});
export type TemplatePin = typeof TemplatePinSchema.Type;

export const TemplateLifecycleStateSchema = Schema.Literals(['draft', 'active', 'retired', 'invalidated-unsafe']);
export type TemplateLifecycleState = typeof TemplateLifecycleStateSchema.Type;

const AuditActivationSchema = Schema.Struct({
  activatedAt: timestamp,
  activatedByPrincipalId: TemplatePrincipalIdSchema,
  activationId: TemplateActivationIdSchema,
  activationReason: Schema.String,
  endedAt: Schema.optionalKey(timestamp),
  endedByPrincipalId: Schema.optionalKey(TemplatePrincipalIdSchema),
  endedKind: Schema.optionalKey(Schema.Literals(['replaced', 'deactivated', 'invalidated-unsafe'])),
  endReason: Schema.optionalKey(Schema.String),
  scopeKey: TemplateScopeKeySchema,
});
/**
 * The safe answer to "which revision, language and scope did this message use": identity, digest and the
 * who/what/when/scope/why trace. It never carries subject, body, placeholder values or any recipient data.
 */
export const TemplateUseAuditSchema = Schema.Struct({
  activations: Schema.Array(AuditActivationSchema),
  activeAtDecisionTime: Schema.Boolean,
  contentDigest: Schema.String,
  decisionTime: timestamp,
  identity: TemplateIdentitySchema,
  invalidation: Schema.optionalKey(
    Schema.Struct({
      invalidatedAt: timestamp,
      invalidatedByPrincipalId: TemplatePrincipalIdSchema,
      reason: Schema.String,
    }),
  ),
  lifecycleState: TemplateLifecycleStateSchema,
  /** The placeholder names this revision itself declared; names only, never a value. */
  optionalPlaceholders: Schema.Array(TemplatePlaceholderNameSchema),
  requiredPlaceholders: Schema.Array(TemplatePlaceholderNameSchema),
  revisionId: TemplateRevisionIdSchema,
  revisionNumber: Schema.Number,
  source: TemplateTextSourceSchema,
  templateTypeId: TemplateTypeIdSchema,
});
export type TemplateUseAudit = typeof TemplateUseAuditSchema.Type;

const ReviewedTextFields = {
  body: Schema.String,
  contentDigest: Schema.String,
  optionalPlaceholders: Schema.Array(TemplatePlaceholderNameSchema),
  requiredPlaceholders: Schema.Array(TemplatePlaceholderNameSchema),
  subject: Schema.String,
};

/** One of the Tenant's own revisions of the identity, with its exact text: placeholders are names, never values. */
const TenantTemplateRevisionReviewSchema = Schema.Struct({
  ...ReviewedTextFields,
  createdAt: timestamp,
  /** Whether this revision carries exactly the seed subject and body. */
  isBuiltInDefaultText: Schema.Boolean,
  lifecycleState: TemplateLifecycleStateSchema,
  revisionId: TemplateRevisionIdSchema,
  revisionNumber: Schema.Number,
});

/**
 * The text a new message of the identity uses now, decided by the same rule as template resolution: the one active
 * revision the Tenant's administrator activated, or nothing.
 */
const TemplateInForceSchema = Schema.Union([
  Schema.Struct({
    contentDigest: Schema.String,
    revisionId: TemplateRevisionIdSchema,
    revisionNumber: Schema.Number,
    source: Schema.Literal('TENANT_REVISION'),
  }),
  /** Nothing is in force: Communications sends nothing of the identity and records this typed reason. */
  Schema.Struct({
    reason: Schema.Literals(['template_active_revision_ambiguous', 'template_no_active_revision']),
    source: Schema.Literal('NONE'),
  }),
]);

/**
 * One seed text next to the Tenant's own revisions of exactly the same identity. The seed text is content an
 * administrator MAY prepare and activate as an own revision; it is never in force by itself, and no approval of its
 * wording is confirmed yet (R-D1), so the entry says so instead of claiming one.
 */
export const BuiltInTemplateDefaultEntrySchema = Schema.Struct({
  builtInDefault: Schema.Struct({
    ...ReviewedTextFields,
    approval: Schema.Literal('PENDING-APPROVER'),
    version: Schema.Number,
  }),
  identity: TemplateIdentitySchema,
  inForce: TemplateInForceSchema,
  revisions: Schema.Array(TenantTemplateRevisionReviewSchema),
});
export type BuiltInTemplateDefaultEntry = typeof BuiltInTemplateDefaultEntrySchema.Type;
