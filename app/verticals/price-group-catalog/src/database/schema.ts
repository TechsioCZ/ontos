/* oxlint-disable perfectionist/sort-objects -- Drizzle declaration order is the physical owner contract; expires: 2027-03-31. */
import { tenantRlsPolicies } from '@app/core-runtime';
import { defineRelations, sql } from 'drizzle-orm';
import { bigint, check, foreignKey, index, pgSchema, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

export const PRICE_GROUP_CATALOG_SCHEMA_NAME = 'price_group_catalog';

export const PRICE_GROUP_CATALOG_TABLE_INVENTORY = [
  'gateway_assertion_redemptions',
  'price_group_catalog_ledger',
  'price_group_compatibility_support',
  'price_group_containment_projection_intents',
  'price_group_definition_effective_intervals',
  'price_group_definition_revisions',
  'price_group_retirements',
  'price_groups',
] as const;

export const priceGroupCatalogSchema = pgSchema(PRICE_GROUP_CATALOG_SCHEMA_NAME);

const recordedAt = () => timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull();
const catalogRevision = (name: string) => bigint(name, { mode: 'number' }).notNull();

export const gatewayAssertionRedemptions = priceGroupCatalogSchema.table(
  'gateway_assertion_redemptions',
  {
    audience: text('audience').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    issuer: text('issuer').notNull(),
    jti: uuid('jti').notNull(),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('price_group_catalog_gateway_assertion_redemptions_identity_uk').on(table.issuer, table.audience, table.jti),
    index('price_group_catalog_gateway_assertion_redemptions_expiry_idx').on(table.expiresAt),
  ],
);

export const priceGroupCatalogLedger = priceGroupCatalogSchema.table.withRLS(
  'price_group_catalog_ledger',
  {
    catalogLedgerEntryId: uuid('catalog_ledger_entry_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    expectedCatalogRevision: bigint('expected_catalog_revision', { mode: 'number' }).notNull(),
    catalogRevision: catalogRevision('catalog_revision'),
    operationKind: text('operation_kind').notNull(),
    priceGroupId: uuid('price_group_id').notNull(),
    definitionRevisionId: uuid('definition_revision_id').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    trustedEffectiveAt: timestamp('trusted_effective_at', { withTimezone: true }).notNull(),
    reason: text('reason').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('price_group_catalog_ledger_scope_revision_uk').on(table.tenantId, table.catalogRevision),
    unique('price_group_catalog_ledger_scope_invocation_uk').on(table.tenantId, table.actionInvocationId),
    index('price_group_catalog_ledger_group_idx').on(table.tenantId, table.priceGroupId, table.catalogRevision),
    check(
      'price_group_catalog_ledger_revision_ck',
      sql`${table.expectedCatalogRevision} >= 0 and ${table.catalogRevision} = ${table.expectedCatalogRevision} + 1`,
    ),
    check(
      'price_group_catalog_ledger_operation_ck',
      sql`${table.operationKind} in ('CREATE_PRICE_GROUP', 'CREATE_DEFINITION_REVISION', 'RETIRE_PRICE_GROUP')`,
    ),
    check(
      'price_group_catalog_ledger_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('price_group_catalog_ledger_scope', table.tenantId),
  ],
);

export const priceGroups = priceGroupCatalogSchema.table.withRLS(
  'price_groups',
  {
    priceGroupId: uuid('price_group_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    businessCode: text('business_code').notNull(),
    canonicalMeaning: text('canonical_meaning').notNull(),
    meaningFingerprint: text('meaning_fingerprint').notNull(),
    lifecycleState: text('lifecycle_state').default('ACTIVE').notNull(),
    activeFrom: timestamp('active_from', { withTimezone: true }).notNull(),
    retiredEffectiveAt: timestamp('retired_effective_at', { withTimezone: true }),
    currentDefinitionScheduleRevision: catalogRevision('current_definition_schedule_revision'),
    createdAtCatalogRevision: catalogRevision('created_at_catalog_revision'),
    createdByActionInvocationId: uuid('created_by_action_invocation_id').notNull(),
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    creationReason: text('creation_reason').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('price_group_catalog_groups_scope_id_uk').on(table.tenantId, table.priceGroupId),
    unique('price_group_catalog_groups_scope_code_uk').on(table.tenantId, table.businessCode),
    unique('price_group_catalog_groups_scope_canonical_meaning_uk').on(table.tenantId, table.canonicalMeaning),
    unique('price_group_catalog_groups_scope_meaning_uk').on(table.tenantId, table.meaningFingerprint),
    foreignKey({
      columns: [table.tenantId, table.currentDefinitionScheduleRevision],
      foreignColumns: [priceGroupCatalogLedger.tenantId, priceGroupCatalogLedger.catalogRevision],
      name: 'price_group_catalog_groups_current_schedule_ledger_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.createdAtCatalogRevision],
      foreignColumns: [priceGroupCatalogLedger.tenantId, priceGroupCatalogLedger.catalogRevision],
      name: 'price_group_catalog_groups_creation_ledger_fk',
    }).onDelete('restrict'),
    index('price_group_catalog_groups_lifecycle_idx').on(table.tenantId, table.lifecycleState),
    check('price_group_catalog_groups_code_ck', sql`${table.businessCode} ~ '^[A-Z][A-Z0-9_]{0,63}$'`),
    check(
      'price_group_catalog_groups_canonical_meaning_ck',
      sql`${table.canonicalMeaning} = regexp_replace(lower(btrim(${table.canonicalMeaning})), '[[:space:]]+', ' ', 'g') and length(${table.canonicalMeaning}) between 1 and 1000`,
    ),
    check('price_group_catalog_groups_fingerprint_ck', sql`${table.meaningFingerprint} ~ '^[0-9a-f]{64}$'`),
    check('price_group_catalog_groups_lifecycle_ck', sql`${table.lifecycleState} in ('ACTIVE', 'RETIRED')`),
    check(
      'price_group_catalog_groups_retirement_ck',
      sql`(${table.lifecycleState} = 'ACTIVE' and ${table.retiredEffectiveAt} is null) or (${table.lifecycleState} = 'RETIRED' and ${table.retiredEffectiveAt} is not null and ${table.retiredEffectiveAt} >= ${table.activeFrom})`,
    ),
    check(
      'price_group_catalog_groups_creation_reason_ck',
      sql`${table.creationReason} = btrim(${table.creationReason}) and length(${table.creationReason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('price_group_catalog_groups_scope', table.tenantId),
  ],
);

export const priceGroupDefinitionRevisions = priceGroupCatalogSchema.table.withRLS(
  'price_group_definition_revisions',
  {
    definitionRevisionId: uuid('definition_revision_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    priceGroupId: uuid('price_group_id').notNull(),
    revisionNumber: bigint('revision_number', { mode: 'number' }).notNull(),
    previousDefinitionRevisionId: uuid('previous_definition_revision_id'),
    comparedDefinitionRevisionId: uuid('compared_definition_revision_id'),
    semanticContinuityDecision: text('semantic_continuity_decision'),
    displayName: text('display_name').notNull(),
    description: text('description').notNull(),
    classificationPurpose: text('classification_purpose').notNull(),
    meaningFingerprint: text('meaning_fingerprint').notNull(),
    acceptedCatalogRevision: catalogRevision('accepted_catalog_revision'),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    reason: text('reason').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('price_group_catalog_definitions_scope_id_uk').on(
      table.tenantId,
      table.priceGroupId,
      table.definitionRevisionId,
    ),
    unique('price_group_catalog_definitions_number_uk').on(table.tenantId, table.priceGroupId, table.revisionNumber),
    unique('price_group_catalog_definitions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.acceptedCatalogRevision],
      foreignColumns: [priceGroupCatalogLedger.tenantId, priceGroupCatalogLedger.catalogRevision],
      name: 'price_group_catalog_definitions_ledger_fk',
    }).onDelete('restrict'),
    index('price_group_catalog_definitions_history_idx').on(table.tenantId, table.priceGroupId, table.revisionNumber),
    check('price_group_catalog_definitions_revision_ck', sql`${table.revisionNumber} > 0`),
    check(
      'price_group_catalog_definitions_predecessor_ck',
      sql`(${table.revisionNumber} = 1 and ${table.previousDefinitionRevisionId} is null) or (${table.revisionNumber} > 1 and ${table.previousDefinitionRevisionId} is not null and ${table.previousDefinitionRevisionId} <> ${table.definitionRevisionId})`,
    ),
    check(
      'price_group_catalog_definitions_continuity_ck',
      sql`(${table.revisionNumber} = 1 and ${table.comparedDefinitionRevisionId} is null and ${table.semanticContinuityDecision} is null) or (${table.revisionNumber} > 1 and ${table.semanticContinuityDecision} = 'SAME_MEANING' and ${table.comparedDefinitionRevisionId} = ${table.previousDefinitionRevisionId})`,
    ),
    check(
      'price_group_catalog_definitions_display_ck',
      sql`${table.displayName} = btrim(${table.displayName}) and length(${table.displayName}) between 1 and 160 and ${table.description} = btrim(${table.description}) and length(${table.description}) between 1 and 2000`,
    ),
    check(
      'price_group_catalog_definitions_purpose_ck',
      sql`${table.classificationPurpose} = btrim(${table.classificationPurpose}) and length(${table.classificationPurpose}) between 1 and 1000`,
    ),
    check('price_group_catalog_definitions_fingerprint_ck', sql`${table.meaningFingerprint} ~ '^[0-9a-f]{64}$'`),
    check(
      'price_group_catalog_definitions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('price_group_catalog_definitions_scope', table.tenantId),
  ],
);

export const priceGroupDefinitionEffectiveIntervals = priceGroupCatalogSchema.table.withRLS(
  'price_group_definition_effective_intervals',
  {
    definitionEffectiveIntervalId: uuid('definition_effective_interval_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    priceGroupId: uuid('price_group_id').notNull(),
    definitionRevisionId: uuid('definition_revision_id').notNull(),
    scheduleCatalogRevision: catalogRevision('schedule_catalog_revision'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    reason: text('reason').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('price_group_catalog_intervals_scope_id_uk').on(
      table.tenantId,
      table.priceGroupId,
      table.definitionEffectiveIntervalId,
    ),
    unique('price_group_catalog_intervals_revision_uk').on(
      table.tenantId,
      table.priceGroupId,
      table.scheduleCatalogRevision,
      table.definitionRevisionId,
    ),
    unique('price_group_catalog_intervals_effective_start_uk').on(
      table.tenantId,
      table.priceGroupId,
      table.scheduleCatalogRevision,
      table.effectiveFrom,
    ),
    foreignKey({
      columns: [table.tenantId, table.priceGroupId, table.definitionRevisionId],
      foreignColumns: [
        priceGroupDefinitionRevisions.tenantId,
        priceGroupDefinitionRevisions.priceGroupId,
        priceGroupDefinitionRevisions.definitionRevisionId,
      ],
      name: 'price_group_catalog_intervals_definition_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.scheduleCatalogRevision],
      foreignColumns: [priceGroupCatalogLedger.tenantId, priceGroupCatalogLedger.catalogRevision],
      name: 'price_group_catalog_intervals_schedule_ledger_fk',
    }).onDelete('restrict'),
    index('price_group_catalog_intervals_current_lookup_idx').on(
      table.tenantId,
      table.priceGroupId,
      table.scheduleCatalogRevision,
      table.effectiveFrom,
      table.effectiveTo,
    ),
    check(
      'price_group_catalog_intervals_period_ck',
      sql`${table.effectiveTo} is null or ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
    check(
      'price_group_catalog_intervals_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('price_group_catalog_intervals_scope', table.tenantId),
  ],
);

export const priceGroupCompatibilitySupport = priceGroupCatalogSchema.table.withRLS(
  'price_group_compatibility_support',
  {
    compatibilitySupportId: uuid('compatibility_support_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    priceGroupId: uuid('price_group_id').notNull(),
    definitionRevisionId: uuid('definition_revision_id').notNull(),
    contractId: text('contract_id').notNull(),
    contractVersion: bigint('contract_version', { mode: 'number' }).notNull(),
    declaredAtCatalogRevision: catalogRevision('declared_at_catalog_revision'),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    reason: text('reason').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('price_group_catalog_compatibility_exact_contract_uk').on(
      table.tenantId,
      table.priceGroupId,
      table.definitionRevisionId,
      table.contractId,
      table.contractVersion,
    ),
    foreignKey({
      columns: [table.tenantId, table.priceGroupId, table.definitionRevisionId],
      foreignColumns: [
        priceGroupDefinitionRevisions.tenantId,
        priceGroupDefinitionRevisions.priceGroupId,
        priceGroupDefinitionRevisions.definitionRevisionId,
      ],
      name: 'price_group_catalog_compatibility_definition_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.declaredAtCatalogRevision],
      foreignColumns: [priceGroupCatalogLedger.tenantId, priceGroupCatalogLedger.catalogRevision],
      name: 'price_group_catalog_compatibility_ledger_fk',
    }).onDelete('restrict'),
    index('price_group_catalog_compatibility_lookup_idx').on(
      table.tenantId,
      table.priceGroupId,
      table.contractId,
      table.contractVersion,
      table.definitionRevisionId,
    ),
    check(
      'price_group_catalog_compatibility_contract_id_ck',
      sql`${table.contractId} ~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*$' and length(${table.contractId}) between 1 and 160`,
    ),
    check('price_group_catalog_compatibility_contract_version_ck', sql`${table.contractVersion} > 0`),
    check(
      'price_group_catalog_compatibility_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('price_group_catalog_compatibility_scope', table.tenantId),
  ],
);

export const priceGroupRetirements = priceGroupCatalogSchema.table.withRLS(
  'price_group_retirements',
  {
    priceGroupRetirementId: uuid('price_group_retirement_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    priceGroupId: uuid('price_group_id').notNull(),
    currentDefinitionRevisionId: uuid('current_definition_revision_id').notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    expectedCatalogRevision: catalogRevision('expected_catalog_revision'),
    acceptedCatalogRevision: catalogRevision('accepted_catalog_revision'),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    reason: text('reason').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('price_group_catalog_retirements_group_uk').on(table.tenantId, table.priceGroupId),
    unique('price_group_catalog_retirements_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.priceGroupId],
      foreignColumns: [priceGroups.tenantId, priceGroups.priceGroupId],
      name: 'price_group_catalog_retirements_group_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.priceGroupId, table.currentDefinitionRevisionId],
      foreignColumns: [
        priceGroupDefinitionRevisions.tenantId,
        priceGroupDefinitionRevisions.priceGroupId,
        priceGroupDefinitionRevisions.definitionRevisionId,
      ],
      name: 'price_group_catalog_retirements_definition_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.expectedCatalogRevision],
      foreignColumns: [priceGroupCatalogLedger.tenantId, priceGroupCatalogLedger.catalogRevision],
      name: 'price_group_catalog_retirements_expected_ledger_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.acceptedCatalogRevision],
      foreignColumns: [priceGroupCatalogLedger.tenantId, priceGroupCatalogLedger.catalogRevision],
      name: 'price_group_catalog_retirements_ledger_fk',
    }).onDelete('restrict'),
    check(
      'price_group_catalog_retirements_fence_ck',
      sql`${table.expectedCatalogRevision} > 0 and ${table.acceptedCatalogRevision} = ${table.expectedCatalogRevision} + 1`,
    ),
    check(
      'price_group_catalog_retirements_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('price_group_catalog_retirements_scope', table.tenantId),
  ],
);

export const priceGroupContainmentProjectionIntents = priceGroupCatalogSchema.table.withRLS(
  'price_group_containment_projection_intents',
  {
    mutationId: uuid('mutation_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    priceGroupId: uuid('price_group_id').notNull(),
    definitionRevisionId: uuid('definition_revision_id').notNull(),
    definitionCatalogRevision: catalogRevision('definition_catalog_revision'),
    sourceActionInvocationId: uuid('source_action_invocation_id').notNull(),
    operation: text('operation').notNull(),
    catalogVersion: text('catalog_version').notNull(),
    state: text('state').default('PENDING').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('price_group_catalog_containment_intents_scope_mutation_uk').on(table.tenantId, table.mutationId),
    unique('price_group_catalog_containment_intents_scope_action_uk').on(
      table.tenantId,
      table.sourceActionInvocationId,
    ),
    unique('price_group_catalog_containment_intents_scope_group_uk').on(table.tenantId, table.priceGroupId),
    foreignKey({
      columns: [table.tenantId, table.priceGroupId, table.definitionRevisionId],
      foreignColumns: [
        priceGroupDefinitionRevisions.tenantId,
        priceGroupDefinitionRevisions.priceGroupId,
        priceGroupDefinitionRevisions.definitionRevisionId,
      ],
      name: 'price_group_catalog_containment_intents_definition_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.definitionCatalogRevision],
      foreignColumns: [priceGroupCatalogLedger.tenantId, priceGroupCatalogLedger.catalogRevision],
      name: 'price_group_catalog_containment_intents_ledger_fk',
    }).onDelete('restrict'),
    index('price_group_catalog_containment_intents_pending_idx').on(table.tenantId, table.state, table.requestedAt),
    check('price_group_catalog_containment_intents_operation_ck', sql`${table.operation} = 'TOUCH_CONTAINMENT'`),
    check('price_group_catalog_containment_intents_catalog_version_ck', sql`${table.catalogVersion} = '1'`),
    check('price_group_catalog_containment_intents_state_ck', sql`${table.state} in ('PENDING', 'APPLIED')`),
    check(
      'price_group_catalog_containment_intents_completion_ck',
      sql`(${table.state} = 'PENDING' and ${table.completedAt} is null) or (${table.state} = 'APPLIED' and ${table.completedAt} is not null and ${table.completedAt} >= ${table.requestedAt})`,
    ),
    ...tenantRlsPolicies('price_group_catalog_containment_intents_scope', table.tenantId),
  ],
);

const priceGroupCatalogDatabaseSchema = {
  gatewayAssertionRedemptions,
  priceGroupCatalogLedger,
  priceGroupCompatibilitySupport,
  priceGroupContainmentProjectionIntents,
  priceGroupDefinitionEffectiveIntervals,
  priceGroupDefinitionRevisions,
  priceGroupRetirements,
  priceGroups,
} as const;

export const PRICE_GROUP_CATALOG_TABLES = [
  gatewayAssertionRedemptions,
  priceGroupCatalogLedger,
  priceGroupCompatibilitySupport,
  priceGroupContainmentProjectionIntents,
  priceGroupDefinitionEffectiveIntervals,
  priceGroupDefinitionRevisions,
  priceGroupRetirements,
  priceGroups,
] as const;

/** Relational Queries v2 entry point for this owner. */
export const priceGroupCatalogRelations = defineRelations(priceGroupCatalogDatabaseSchema);
