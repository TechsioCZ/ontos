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
 * The pin the Message Intent lane stores at the first approved creation of one intent. A retry reuses it verbatim and
 * never resolves again; only a new business request resolves a new pin against the then-active revision.
 */
/**
 * Which text a message used (#1398, #1406): a revision the Tenant stored and activated, or the built-in default text in
 * code the product owner approved, used for an identity the Tenant never took over.
 */
export const TemplateTextSourceSchema = Schema.Literals(['TENANT_REVISION', 'BUILT_IN_DEFAULT']);
export type TemplateTextSource = typeof TemplateTextSourceSchema.Type;

export const TemplatePinSchema = Schema.Struct({
  ...TemplateIdentitySchema.fields,
  /** The digest of the exact subject and body the message uses; absent only on a pin stored before #1406 Option A. */
  contentDigest: Schema.optionalKey(Schema.String),
  decisionTime: timestamp,
  /** The Tenant revision, or the stable reference of the built-in text (derived from its content digest). */
  revisionId: TemplateRevisionIdSchema,
  /** The Tenant revision number, or the catalog version of the built-in text. */
  revisionNumber: Schema.Number,
  /** Absent only on a pin stored before #1406 Option A: such a pin always names a Tenant revision. */
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
  /** Empty for a built-in default: nobody activated it, the product owner approved its text. */
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

/**
 * Whether the built-in default text (#1398, #1406) is still in force for its exact identity: IN_USE while the Tenant
 * never activated an own revision of it, REPLACED once it did (whether or not that revision is still active).
 */
const BuiltInTemplateDefaultStateSchema = Schema.Literals(['BUILT_IN_DEFAULT_IN_USE', 'BUILT_IN_DEFAULT_REPLACED']);

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
  /** Whether this revision carries exactly the built-in default subject and body. */
  isBuiltInDefaultText: Schema.Boolean,
  lifecycleState: TemplateLifecycleStateSchema,
  revisionId: TemplateRevisionIdSchema,
  revisionNumber: Schema.Number,
});

/** The text a new message of the identity uses now, decided by the same rule as template resolution. */
const TemplateInForceSchema = Schema.Union([
  Schema.Struct({
    contentDigest: Schema.String,
    revisionId: TemplateRevisionIdSchema,
    revisionNumber: Schema.Number,
    source: Schema.Literal('TENANT_REVISION'),
  }),
  Schema.Struct({
    contentDigest: Schema.String,
    source: Schema.Literal('BUILT_IN_DEFAULT'),
    version: Schema.Number,
  }),
  /** Nothing is in force: Communications sends nothing of the identity and records this typed reason. */
  Schema.Struct({
    reason: Schema.Literals(['template_active_revision_ambiguous', 'template_no_active_revision']),
    source: Schema.Literal('NONE'),
  }),
]);

/** One built-in default next to the Tenant's own revisions of exactly the same identity. */
export const BuiltInTemplateDefaultEntrySchema = Schema.Struct({
  builtInDefault: Schema.Struct({
    ...ReviewedTextFields,
    /** The product owner's approval of the TEXT as the default. */
    approval: Schema.Literal('APPROVED-DEFAULT-TEXT'),
    approvedOn: Schema.String,
    state: BuiltInTemplateDefaultStateSchema,
    version: Schema.Number,
  }),
  identity: TemplateIdentitySchema,
  inForce: TemplateInForceSchema,
  revisions: Schema.Array(TenantTemplateRevisionReviewSchema),
});
export type BuiltInTemplateDefaultEntry = typeof BuiltInTemplateDefaultEntrySchema.Type;
