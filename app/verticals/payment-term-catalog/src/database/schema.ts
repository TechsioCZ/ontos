/* oxlint-disable perfectionist/sort-objects -- Drizzle declaration order is the generated physical column contract; expires: 2027-03-31. */
import { tenantLegalEntityRlsPolicies } from '@app/core-runtime';
import { defineRelations, sql } from 'drizzle-orm';
import {
  bigint,
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

export const PAYMENT_TERM_CATALOG_SCHEMA_NAME = 'payment_term_catalog';

export const PAYMENT_TERM_CATALOG_TABLE_INVENTORY = [
  'payment_term_aliases',
  'payment_term_lifecycle_events',
  'payment_term_revisions',
  'payment_term_source_acceptance_lineage',
  'payment_term_source_authorities',
  'payment_term_source_record_states',
  'payment_term_source_statements',
  'payment_terms',
] as const;

export const paymentTermCatalogSchema = pgSchema(PAYMENT_TERM_CATALOG_SCHEMA_NAME);

const recordedAt = () => timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull();

export const paymentTerms = paymentTermCatalogSchema.table.withRLS(
  'payment_terms',
  {
    paymentTermId: uuid('payment_term_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    businessCode: text('business_code').notNull(),
    lifecycleState: text('lifecycle_state').default('ACTIVE').notNull(),
    activeFrom: timestamp('active_from', { withTimezone: true }).notNull(),
    retiredEffectiveAt: timestamp('retired_effective_at', { withTimezone: true }),
    retirementReason: text('retirement_reason'),
    retiredByActionInvocationId: uuid('retired_by_action_invocation_id'),
    retiredByPrincipalId: uuid('retired_by_principal_id'),
    creationReason: text('creation_reason').notNull(),
    createdByActionInvocationId: uuid('created_by_action_invocation_id').notNull(),
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('payment_term_catalog_terms_scope_id_uk').on(table.tenantId, table.legalEntityId, table.paymentTermId),
    unique('payment_term_catalog_terms_scope_code_uk').on(table.tenantId, table.legalEntityId, table.businessCode),
    index('payment_term_catalog_terms_current_idx').on(table.tenantId, table.legalEntityId, table.lifecycleState),
    check('payment_term_catalog_terms_code_ck', sql`${table.businessCode} ~ '^[A-Z][A-Z0-9_]{0,63}$'`),
    check(
      'payment_term_catalog_terms_creation_reason_ck',
      sql`${table.creationReason} = btrim(${table.creationReason}) and length(${table.creationReason}) between 1 and 1000`,
    ),
    check('payment_term_catalog_terms_lifecycle_ck', sql`${table.lifecycleState} in ('ACTIVE', 'RETIRED')`),
    check(
      'payment_term_catalog_terms_effective_period_ck',
      sql`${table.retiredEffectiveAt} is null or ${table.retiredEffectiveAt} >= ${table.activeFrom}`,
    ),
    check(
      'payment_term_catalog_terms_retirement_ck',
      sql`(${table.lifecycleState} = 'ACTIVE' and ${table.retiredEffectiveAt} is null and ${table.retirementReason} is null and ${table.retiredByActionInvocationId} is null and ${table.retiredByPrincipalId} is null) or (${table.lifecycleState} = 'RETIRED' and ${table.retiredEffectiveAt} is not null and ${table.retirementReason} is not null and ${table.retirementReason} = btrim(${table.retirementReason}) and length(${table.retirementReason}) between 1 and 1000 and ${table.retiredByActionInvocationId} is not null and ${table.retiredByPrincipalId} is not null)`,
    ),
    ...tenantLegalEntityRlsPolicies('payment_term_catalog_terms_scope', table.tenantId, table.legalEntityId),
  ],
);

export const paymentTermRevisions = paymentTermCatalogSchema.table.withRLS(
  'payment_term_revisions',
  {
    paymentTermRevisionId: uuid('payment_term_revision_id').defaultRandom().primaryKey(),
    semanticRevisionId: uuid('semantic_revision_id').defaultRandom().notNull(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    paymentTermId: uuid('payment_term_id').notNull(),
    revisionNumber: integer('revision_number').notNull(),
    changeKind: text('change_kind').notNull(),
    displayName: text('display_name').notNull(),
    explanation: text('explanation').notNull(),
    semanticKind: text('semantic_kind').notNull(),
    netDays: bigint('net_days', { mode: 'number' }),
    dueDateAnchor: text('due_date_anchor'),
    calendarRule: text('calendar_rule').notNull(),
    calculationRuleVersion: integer('calculation_rule_version').default(1).notNull(),
    compatibilityKey: text('compatibility_key').notNull(),
    semanticFingerprint: text('semantic_fingerprint').notNull(),
    changeReason: text('change_reason').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('payment_term_catalog_revisions_scope_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.paymentTermRevisionId,
    ),
    unique('payment_term_catalog_revisions_number_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.paymentTermId,
      table.revisionNumber,
    ),
    unique('payment_term_catalog_revisions_invocation_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.actionInvocationId,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.paymentTermId],
      foreignColumns: [paymentTerms.tenantId, paymentTerms.legalEntityId, paymentTerms.paymentTermId],
      name: 'payment_term_catalog_revisions_term_fk',
    }).onDelete('restrict'),
    index('payment_term_catalog_revisions_history_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.paymentTermId,
      table.revisionNumber,
    ),
    index('payment_term_catalog_revisions_semantics_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.semanticFingerprint,
    ),
    check('payment_term_catalog_revisions_number_ck', sql`${table.revisionNumber} > 0`),
    check(
      'payment_term_catalog_revisions_change_kind_ck',
      sql`${table.changeKind} in ('CREATED', 'COSMETIC_CORRECTION')`,
    ),
    check(
      'payment_term_catalog_revisions_display_ck',
      sql`${table.displayName} = btrim(${table.displayName}) and length(${table.displayName}) between 1 and 160 and ${table.explanation} = btrim(${table.explanation}) and length(${table.explanation}) between 1 and 2000`,
    ),
    check('payment_term_catalog_revisions_semantic_kind_ck', sql`${table.semanticKind} in ('IMMEDIATE', 'NET_DAYS')`),
    check(
      'payment_term_catalog_revisions_semantics_ck',
      sql`(${table.semanticKind} = 'IMMEDIATE' and ${table.netDays} is null and ${table.dueDateAnchor} is null and ${table.calendarRule} = 'NOT_APPLICABLE') or (${table.semanticKind} = 'NET_DAYS' and ${table.netDays} is not null and ${table.netDays} between 0 and 9007199254740991 and ${table.dueDateAnchor} is not null and ((${table.calculationRuleVersion} = 1 and ${table.dueDateAnchor} = 'INVOICE_ISSUED_AT' and ${table.calendarRule} = 'CALENDAR_DAYS_UTC') or (${table.calculationRuleVersion} = 2 and ${table.dueDateAnchor} = 'INVOICE_ISSUE_DATE' and ${table.calendarRule} = 'CALENDAR_DAYS')))`,
    ),
    check('payment_term_catalog_revisions_calculation_version_ck', sql`${table.calculationRuleVersion} in (1, 2)`),
    check(
      'payment_term_catalog_revisions_compatibility_ck',
      sql`${table.compatibilityKey} ~ '^[a-z][a-z0-9._-]{0,99}$'`,
    ),
    check('payment_term_catalog_revisions_fingerprint_ck', sql`${table.semanticFingerprint} ~ '^[0-9a-f]{64}$'`),
    check(
      'payment_term_catalog_revisions_reason_ck',
      sql`${table.changeReason} = btrim(${table.changeReason}) and length(${table.changeReason}) between 1 and 1000`,
    ),
    ...tenantLegalEntityRlsPolicies('payment_term_catalog_revisions_scope', table.tenantId, table.legalEntityId),
  ],
);

export const paymentTermLifecycleEvents = paymentTermCatalogSchema.table.withRLS(
  'payment_term_lifecycle_events',
  {
    paymentTermLifecycleEventId: uuid('payment_term_lifecycle_event_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    paymentTermId: uuid('payment_term_id').notNull(),
    eventKind: text('event_kind').notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    reason: text('reason').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('payment_term_catalog_lifecycle_scope_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.paymentTermLifecycleEventId,
    ),
    unique('payment_term_catalog_lifecycle_invocation_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.actionInvocationId,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.paymentTermId],
      foreignColumns: [paymentTerms.tenantId, paymentTerms.legalEntityId, paymentTerms.paymentTermId],
      name: 'payment_term_catalog_lifecycle_term_fk',
    }).onDelete('restrict'),
    index('payment_term_catalog_lifecycle_history_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.paymentTermId,
      table.effectiveAt,
    ),
    check('payment_term_catalog_lifecycle_kind_ck', sql`${table.eventKind} in ('ACTIVATED', 'RETIRED')`),
    check(
      'payment_term_catalog_lifecycle_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantLegalEntityRlsPolicies('payment_term_catalog_lifecycle_scope', table.tenantId, table.legalEntityId),
  ],
);

export const paymentTermAliases = paymentTermCatalogSchema.table.withRLS(
  'payment_term_aliases',
  {
    paymentTermAliasId: uuid('payment_term_alias_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    aliasPaymentTermId: uuid('alias_payment_term_id').notNull(),
    canonicalPaymentTermId: uuid('canonical_payment_term_id').notNull(),
    reason: text('reason').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('payment_term_catalog_aliases_scope_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.paymentTermAliasId,
    ),
    unique('payment_term_catalog_aliases_alias_uk').on(table.tenantId, table.legalEntityId, table.aliasPaymentTermId),
    unique('payment_term_catalog_aliases_invocation_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.actionInvocationId,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.aliasPaymentTermId],
      foreignColumns: [paymentTerms.tenantId, paymentTerms.legalEntityId, paymentTerms.paymentTermId],
      name: 'payment_term_catalog_aliases_alias_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.canonicalPaymentTermId],
      foreignColumns: [paymentTerms.tenantId, paymentTerms.legalEntityId, paymentTerms.paymentTermId],
      name: 'payment_term_catalog_aliases_canonical_fk',
    }).onDelete('restrict'),
    uniqueIndex('payment_term_catalog_aliases_pair_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.aliasPaymentTermId,
      table.canonicalPaymentTermId,
    ),
    check(
      'payment_term_catalog_aliases_not_self_ck',
      sql`${table.aliasPaymentTermId} <> ${table.canonicalPaymentTermId}`,
    ),
    check(
      'payment_term_catalog_aliases_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantLegalEntityRlsPolicies('payment_term_catalog_aliases_scope', table.tenantId, table.legalEntityId),
  ],
);

export const paymentTermSourceAuthorities = paymentTermCatalogSchema.table.withRLS(
  'payment_term_source_authorities',
  {
    sourceAuthorityId: uuid('source_authority_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    externalBusinessSystemId: text('external_business_system_id').notNull(),
    namespace: text('namespace').notNull(),
    integrationRoute: text('integration_route').notNull(),
    factFamily: text('fact_family').default('PAYMENT_TERM_DEFINITION').notNull(),
    authorityRevision: integer('authority_revision').notNull(),
    ingestPrincipalId: uuid('ingest_principal_id').notNull(),
    reason: text('reason').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('payment_term_catalog_authorities_revision_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.externalBusinessSystemId,
      table.namespace,
      table.integrationRoute,
      table.authorityRevision,
    ),
    unique('payment_term_catalog_authorities_invocation_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.actionInvocationId,
    ),
    check('payment_term_catalog_authorities_revision_ck', sql`${table.authorityRevision} > 0`),
    check('payment_term_catalog_authorities_family_ck', sql`${table.factFamily} = 'PAYMENT_TERM_DEFINITION'`),
    check(
      'payment_term_catalog_authorities_qualification_ck',
      sql`length(btrim(${table.externalBusinessSystemId})) between 1 and 200 and length(btrim(${table.namespace})) between 1 and 200 and length(btrim(${table.integrationRoute})) between 1 and 200`,
    ),
    check(
      'payment_term_catalog_authorities_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantLegalEntityRlsPolicies('payment_term_catalog_authorities_scope', table.tenantId, table.legalEntityId),
  ],
);

export const paymentTermSourceStatements = paymentTermCatalogSchema.table.withRLS(
  'payment_term_source_statements',
  {
    sourceStatementLedgerId: uuid('source_statement_ledger_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    externalBusinessSystemId: text('external_business_system_id').notNull(),
    namespace: text('namespace').notNull(),
    integrationRoute: text('integration_route').notNull(),
    sourceRecordId: text('source_record_id').notNull(),
    sourceStatementId: text('source_statement_id').notNull(),
    sourceRevision: bigint('source_revision', { mode: 'number' }).notNull(),
    sourceCode: text('source_code').notNull(),
    businessObservedAt: timestamp('business_observed_at', { withTimezone: true }).notNull(),
    authorityRevision: integer('authority_revision').notNull(),
    content: jsonb('content').notNull(),
    result: jsonb('result').notNull(),
    outcome: text('outcome').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('payment_term_catalog_statements_identity_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.externalBusinessSystemId,
      table.namespace,
      table.integrationRoute,
      table.sourceRecordId,
      table.sourceStatementId,
    ),
    index('payment_term_catalog_statements_ordering_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.externalBusinessSystemId,
      table.namespace,
      table.integrationRoute,
      table.sourceRecordId,
      table.sourceRevision,
    ),
    check('payment_term_catalog_statements_revision_ck', sql`${table.sourceRevision} between 0 and 9007199254740991`),
    check('payment_term_catalog_statements_authority_ck', sql`${table.authorityRevision} > 0`),
    check(
      'payment_term_catalog_statements_outcome_ck',
      sql`${table.outcome} in ('ACCEPTED', 'REJECTED') and ${table.result}->>'_tag' = ${table.outcome}`,
    ),
    ...tenantLegalEntityRlsPolicies('payment_term_catalog_statements_scope', table.tenantId, table.legalEntityId),
  ],
);

export const paymentTermSourceRecordStates = paymentTermCatalogSchema.table.withRLS(
  'payment_term_source_record_states',
  {
    sourceRecordStateId: uuid('source_record_state_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    externalBusinessSystemId: text('external_business_system_id').notNull(),
    namespace: text('namespace').notNull(),
    integrationRoute: text('integration_route').notNull(),
    sourceRecordId: text('source_record_id').notNull(),
    highestObservedRevision: bigint('highest_observed_revision', { mode: 'number' }).notNull(),
    highestObservedStatementLedgerId: uuid('highest_observed_statement_ledger_id').notNull(),
    currentAcceptedStatementLedgerId: uuid('current_accepted_statement_ledger_id'),
    currentPaymentTermId: uuid('current_payment_term_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('payment_term_catalog_source_record_states_identity_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.externalBusinessSystemId,
      table.namespace,
      table.integrationRoute,
      table.sourceRecordId,
    ),
    foreignKey({
      columns: [table.highestObservedStatementLedgerId],
      foreignColumns: [paymentTermSourceStatements.sourceStatementLedgerId],
      name: 'payment_term_catalog_source_record_states_highest_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.currentAcceptedStatementLedgerId],
      foreignColumns: [paymentTermSourceStatements.sourceStatementLedgerId],
      name: 'payment_term_catalog_source_record_states_accepted_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.currentPaymentTermId],
      foreignColumns: [paymentTerms.tenantId, paymentTerms.legalEntityId, paymentTerms.paymentTermId],
      name: 'payment_term_catalog_source_record_states_term_fk',
    }).onDelete('restrict'),
    check(
      'payment_term_catalog_source_record_states_revision_ck',
      sql`${table.highestObservedRevision} between 0 and 9007199254740991`,
    ),
    check(
      'payment_term_catalog_source_record_states_mapping_ck',
      sql`(${table.currentAcceptedStatementLedgerId} is null) = (${table.currentPaymentTermId} is null)`,
    ),
    ...tenantLegalEntityRlsPolicies(
      'payment_term_catalog_source_record_states_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

export const paymentTermSourceAcceptanceLineage = paymentTermCatalogSchema.table.withRLS(
  'payment_term_source_acceptance_lineage',
  {
    sourceAcceptanceLineageId: uuid('source_acceptance_lineage_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    acceptedStatementLedgerId: uuid('accepted_statement_ledger_id').notNull(),
    predecessorStatementLedgerId: uuid('predecessor_statement_ledger_id'),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('payment_term_catalog_source_acceptance_lineage_accepted_uk').on(table.acceptedStatementLedgerId),
    unique('payment_term_catalog_source_acceptance_lineage_predecessor_uk').on(table.predecessorStatementLedgerId),
    foreignKey({
      columns: [table.acceptedStatementLedgerId],
      foreignColumns: [paymentTermSourceStatements.sourceStatementLedgerId],
      name: 'payment_term_catalog_source_acceptance_lineage_accepted_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.predecessorStatementLedgerId],
      foreignColumns: [paymentTermSourceStatements.sourceStatementLedgerId],
      name: 'payment_term_catalog_source_acceptance_lineage_predecessor_fk',
    }).onDelete('restrict'),
    check(
      'payment_term_catalog_source_acceptance_lineage_not_self_ck',
      sql`${table.predecessorStatementLedgerId} is null or ${table.predecessorStatementLedgerId} <> ${table.acceptedStatementLedgerId}`,
    ),
    ...tenantLegalEntityRlsPolicies(
      'payment_term_catalog_source_acceptance_lineage_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

const paymentTermCatalogDatabaseSchema = {
  paymentTermAliases,
  paymentTermLifecycleEvents,
  paymentTermRevisions,
  paymentTermSourceAcceptanceLineage,
  paymentTermSourceAuthorities,
  paymentTermSourceRecordStates,
  paymentTermSourceStatements,
  paymentTerms,
} as const;

export const PAYMENT_TERM_CATALOG_TABLES = [
  paymentTermAliases,
  paymentTermLifecycleEvents,
  paymentTermRevisions,
  paymentTermSourceAcceptanceLineage,
  paymentTermSourceAuthorities,
  paymentTermSourceRecordStates,
  paymentTermSourceStatements,
  paymentTerms,
] as const;

/** Relational Queries v2 entry point for this owner. */
export const paymentTermCatalogRelations = defineRelations(paymentTermCatalogDatabaseSchema);
