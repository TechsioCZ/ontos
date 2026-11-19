import { tenantRlsPolicies } from '@app/core-runtime';
import { defineRelations, sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const COMMUNICATIONS_SCHEMA_NAME = 'communications';
/**
 * The one Communications schema. Leaf lanes declare governed tables with `communicationsSchema.table.withRLS(...)`
 * and attach `tenantRlsPolicies` or `tenantLegalEntityRlsPolicies` from `@app/core-runtime`.
 */
export const communicationsSchema = pgSchema(COMMUNICATIONS_SCHEMA_NAME);

/** Pre-authentication ingress replay identity; never stores credentials or trusted business scope. */
export const gatewayAssertionRedemptions = communicationsSchema.table(
  'gateway_assertion_redemptions',
  {
    audience: text('audience').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    issuer: text('issuer').notNull(),
    jti: uuid('jti').notNull(),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('communications_gateway_assertion_redemptions_identity_uk').on(table.issuer, table.audience, table.jti),
    index('communications_gateway_assertion_redemptions_expiry_idx').on(table.expiresAt),
  ],
);

/**
 * Template Type: the stable identity of one transactional template, per message type, channel, language and allowed
 * scope (#1398). It is immutable and carries identity only: every declared placeholder belongs to a Template Revision,
 * because a change in meaning is a new revision. `scope_key` is `tenant` or `legal-entity:<uuid>` so the identity is one
 * plain unique key.
 */
export const templateTypes = communicationsSchema.table.withRLS(
  'template_types',
  {
    actionInvocationId: uuid('action_invocation_id').notNull(),
    channel: text('channel').$type<'email'>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    language: text('language').$type<'cs' | 'en'>().notNull(),
    legalEntityId: uuid('legal_entity_id'),
    messageType: text('message_type').notNull(),
    scopeKey: text('scope_key').notNull(),
    scopeKind: text('scope_kind').notNull(),
    templateTypeId: uuid('template_type_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    unique('communications_template_types_tenant_identity_uk').on(table.tenantId, table.templateTypeId),
    // the target of the activation's scope foreign key: an activation can only carry the scope of its own Type
    unique('communications_template_types_scope_identity_uk').on(table.tenantId, table.templateTypeId, table.scopeKey),
    unique('communications_template_types_identity_uk').on(
      table.tenantId,
      table.messageType,
      table.channel,
      table.language,
      table.scopeKey,
    ),
    check('communications_template_types_channel_ck', sql`${table.channel} in ('email')`),
    check('communications_template_types_language_ck', sql`${table.language} in ('cs', 'en')`),
    check(
      'communications_template_types_scope_ck',
      sql`(${table.scopeKind} = 'tenant' and ${table.legalEntityId} is null and ${table.scopeKey} = 'tenant') or (${table.scopeKind} = 'legal-entity' and ${table.legalEntityId} is not null and ${table.scopeKey} = 'legal-entity:' || ${table.legalEntityId}::text)`,
    ),
    ...tenantRlsPolicies('communications_template_types', table.tenantId),
  ],
);

/**
 * Immutable Template Revision: any change in meaning or text is a new revision, never an update. A revision declares its
 * own required and optional placeholders (names only), so activation checks its text against what it itself declares.
 */
export const templateRevisions = communicationsSchema.table.withRLS(
  'template_revisions',
  {
    actionInvocationId: uuid('action_invocation_id').notNull(),
    body: text('body').notNull(),
    contentDigest: text('content_digest').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    optionalPlaceholders: jsonb('optional_placeholders').$type<readonly string[]>().notNull(),
    placeholdersUsed: jsonb('placeholders_used').$type<readonly string[]>().notNull(),
    reason: text('reason').notNull(),
    requiredPlaceholders: jsonb('required_placeholders').$type<readonly string[]>().notNull(),
    revisionId: uuid('revision_id').primaryKey(),
    revisionNumber: integer('revision_number').notNull(),
    subject: text('subject').notNull(),
    templateTypeId: uuid('template_type_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    unique('communications_template_revisions_tenant_identity_uk').on(table.tenantId, table.revisionId),
    // the target of the activation's revision foreign key: an activation can only name the Type of its own revision
    unique('communications_template_revisions_type_identity_uk').on(
      table.tenantId,
      table.revisionId,
      table.templateTypeId,
    ),
    unique('communications_template_revisions_number_uk').on(
      table.tenantId,
      table.templateTypeId,
      table.revisionNumber,
    ),
    foreignKey({
      columns: [table.tenantId, table.templateTypeId],
      foreignColumns: [templateTypes.tenantId, templateTypes.templateTypeId],
      name: 'communications_template_revisions_type_fk',
    }).onDelete('restrict'),
    check('communications_template_revisions_number_ck', sql`${table.revisionNumber} > 0`),
    check(
      'communications_template_revisions_placeholders_ck',
      sql`jsonb_typeof(${table.requiredPlaceholders}) = 'array' and jsonb_typeof(${table.optionalPlaceholders}) = 'array' and jsonb_typeof(${table.placeholdersUsed}) = 'array'`,
    ),
    ...tenantRlsPolicies('communications_template_revisions', table.tenantId),
  ],
);

/**
 * One row per activation period of a revision: who, what, when, for which scope and why. Only the closing columns are
 * ever updated, and only once: a database trigger refuses any update of a closed row, so closed history is append-only.
 * The partial unique index keeps at most one open activation per Template Type, and the composite foreign keys tie the
 * activation's Type and scope to its revision's Type.
 */
export const templateActivations = communicationsSchema.table.withRLS(
  'template_activations',
  {
    activatedAt: timestamp('activated_at', { withTimezone: true }).notNull(),
    activatedByPrincipalId: uuid('activated_by_principal_id').notNull(),
    activationId: uuid('activation_id').primaryKey(),
    activationInvocationId: uuid('activation_invocation_id').notNull(),
    activationReason: text('activation_reason').notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endedByPrincipalId: uuid('ended_by_principal_id'),
    endedKind: text('ended_kind').$type<'replaced' | 'deactivated' | 'invalidated-unsafe'>(),
    endInvocationId: uuid('end_invocation_id'),
    endReason: text('end_reason'),
    legalEntityId: uuid('legal_entity_id'),
    revisionId: uuid('revision_id').notNull(),
    scopeKey: text('scope_key').notNull(),
    templateTypeId: uuid('template_type_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.revisionId, table.templateTypeId],
      foreignColumns: [templateRevisions.tenantId, templateRevisions.revisionId, templateRevisions.templateTypeId],
      name: 'communications_template_activations_revision_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.templateTypeId, table.scopeKey],
      foreignColumns: [templateTypes.tenantId, templateTypes.templateTypeId, templateTypes.scopeKey],
      name: 'communications_template_activations_type_fk',
    }).onDelete('restrict'),
    check(
      'communications_template_activations_scope_ck',
      sql`(${table.scopeKey} = 'tenant' and ${table.legalEntityId} is null) or (${table.legalEntityId} is not null and ${table.scopeKey} = 'legal-entity:' || ${table.legalEntityId}::text)`,
    ),
    uniqueIndex('communications_template_activations_open_uk')
      .on(table.tenantId, table.templateTypeId)
      .where(sql`${table.endedAt} is null`),
    index('communications_template_activations_revision_idx').on(table.tenantId, table.revisionId),
    check(
      'communications_template_activations_end_ck',
      sql`(${table.endedAt} is null and ${table.endedKind} is null and ${table.endedByPrincipalId} is null and ${table.endReason} is null and ${table.endInvocationId} is null) or (${table.endedAt} is not null and ${table.endedAt} >= ${table.activatedAt} and ${table.endedKind} in ('replaced', 'deactivated', 'invalidated-unsafe') and ${table.endedByPrincipalId} is not null and ${table.endReason} is not null and ${table.endInvocationId} is not null)`,
    ),
    ...tenantRlsPolicies('communications_template_activations', table.tenantId),
  ],
);

/** Append-only unsafe marker: a Current security gate for a revision, never a mutation of an earlier decision. */
export const templateRevisionInvalidations = communicationsSchema.table.withRLS(
  'template_revision_invalidations',
  {
    actionInvocationId: uuid('action_invocation_id').notNull(),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }).notNull(),
    invalidatedByPrincipalId: uuid('invalidated_by_principal_id').notNull(),
    invalidationId: uuid('invalidation_id').primaryKey(),
    reason: text('reason').notNull(),
    revisionId: uuid('revision_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    unique('communications_template_revision_invalidations_revision_uk').on(table.tenantId, table.revisionId),
    foreignKey({
      columns: [table.tenantId, table.revisionId],
      foreignColumns: [templateRevisions.tenantId, templateRevisions.revisionId],
      name: 'communications_template_revision_invalidations_revision_fk',
    }).onDelete('restrict'),
    ...tenantRlsPolicies('communications_template_revision_invalidations', table.tenantId),
  ],
);

/** Every owner table, so the verifier and the schema contract test reach each one through its typed reference. */
export const COMMUNICATIONS_TABLES = [
  gatewayAssertionRedemptions,
  templateTypes,
  templateRevisions,
  templateActivations,
  templateRevisionInvalidations,
] as const;

export const COMMUNICATIONS_TABLE_INVENTORY = [
  'gateway_assertion_redemptions',
  'template_types',
  'template_revisions',
  'template_activations',
  'template_revision_invalidations',
] as const;

/** Relational Queries v2 entry point for this owner. */
export const communicationsRelations = defineRelations({
  gatewayAssertionRedemptions,
  templateActivations,
  templateRevisionInvalidations,
  templateRevisions,
  templateTypes,
});
