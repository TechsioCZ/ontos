import { tenantLegalEntityRlsPolicies } from '@app/core-runtime';
import { defineRelations, sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, jsonb, pgSchema, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import type { TaxSourceConflictDetail } from '../../shared/domain/tax-source-read-contracts.ts';

/** Private TAX persistence schema. Other owners use generated TAX contracts. */
export const TAX_SCHEMA_NAME = 'tax';

export const TAX_TABLE_INVENTORY = [
  'tax_rules',
  'tax_rule_revisions',
  'tax_rule_revision_end_facts',
  'tax_rule_corrections',
  'tax_fact_authority_contracts',
  'tax_fact_authority_contract_revisions',
  'tax_source_assertions',
  'tax_source_conflicts',
] as const;

export const taxSchema = pgSchema(TAX_SCHEMA_NAME);

type ScopedTable = Readonly<Record<'legalEntityId' | 'tenantId', AnyPgColumn>>;

/**
 * Tax Rules and Tax Fact Authority Contracts are governed per Selling Legal Entity (#950 F24-F28, #949 F22-F23):
 * every row carries the trusted Tenant and Selling Legal Entity scope.
 */
const scopeColumns = () => ({
  legalEntityId: uuid('legal_entity_id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
});

const scopeIdentity = (name: string, table: ScopedTable, id: AnyPgColumn) =>
  unique(name).on(table.tenantId, table.legalEntityId, id);

/** Core Action attribution; `idempotency_key` is the Core Action invocation identity. */
const attribution = () => ({
  actionInvocationId: uuid('action_invocation_id').notNull(),
  actorPrincipalId: uuid('actor_principal_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  provenanceRef: text('provenance_ref').notNull(),
  reason: text('reason').notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
});

const scopedPolicies = (prefix: string, table: ScopedTable) =>
  tenantLegalEntityRlsPolicies(prefix, table.tenantId, table.legalEntityId);

const trimmed = (name: string, column: AnyPgColumn) =>
  check(name, sql`${column} = btrim(${column}) and length(${column}) between 1 and 1000`);

const fingerprint = (name: string, column: AnyPgColumn) => check(name, sql`${column} ~ '^[0-9a-f]{64}$'`);

const stableCode = (name: string, column: AnyPgColumn) => check(name, sql`${column} ~ '^[a-z][a-z0-9._-]{0,127}$'`);

/** Stable Tax Rule identity; immutable and append-only (#929 F1, #949 F8). */
export const taxRules = taxSchema.table.withRLS(
  'tax_rules',
  {
    taxRuleId: uuid('tax_rule_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    meaningKind: text('meaning_kind').notNull(),
    stableCode: text('stable_code').notNull(),
    ...attribution(),
  },
  (table) => [
    scopeIdentity('tax_rules_scope_id_uk', table, table.taxRuleId),
    unique('tax_rules_code_uk').on(table.tenantId, table.legalEntityId, table.stableCode),
    unique('tax_rules_idempotency_uk').on(table.tenantId, table.idempotencyKey),
    stableCode('tax_rules_code_ck', table.stableCode),
    check('tax_rules_meaning_kind_ck', sql`${table.meaningKind} = 'VAT_RATE'`),
    trimmed('tax_rules_provenance_ck', table.provenanceRef),
    ...scopedPolicies('tax_rules_scope', table),
  ],
);

/**
 * Immutable Tax Rule Revision with its half-open Effective Period `[effective_from, effective_to)` (#929 F4-F10).
 * Ending is a separate fact; correction is a separate provenance row. There is no update or delete path.
 */
export const taxRuleRevisions = taxSchema.table.withRLS(
  'tax_rule_revisions',
  {
    taxRuleRevisionId: uuid('tax_rule_revision_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    compositionKind: text('composition_kind').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    jurisdiction: text('jurisdiction').notNull(),
    ratePercent: text('rate_percent').notNull(),
    revisionNumber: integer('revision_number').notNull(),
    semanticFingerprint: text('semantic_fingerprint').notNull(),
    supersedesRevisionId: uuid('supersedes_revision_id'),
    taxClassificationCode: text('tax_classification_code').notNull(),
    taxRuleId: uuid('tax_rule_id').notNull(),
    treatmentCategory: text('treatment_category').notNull(),
    ...attribution(),
  },
  (table) => [
    scopeIdentity('tax_rule_revisions_scope_id_uk', table, table.taxRuleRevisionId),
    unique('tax_rule_revisions_rule_number_uk').on(table.tenantId, table.taxRuleId, table.revisionNumber),
    unique('tax_rule_revisions_idempotency_uk').on(table.tenantId, table.idempotencyKey),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.taxRuleId],
      foreignColumns: [taxRules.tenantId, taxRules.legalEntityId, taxRules.taxRuleId],
      name: 'tax_rule_revisions_rule_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.supersedesRevisionId],
      foreignColumns: [table.tenantId, table.legalEntityId, table.taxRuleRevisionId],
      name: 'tax_rule_revisions_supersedes_fk',
    }).onDelete('restrict'),
    index('tax_rule_revisions_predicate_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.taxClassificationCode,
      table.jurisdiction,
    ),
    check('tax_rule_revisions_number_ck', sql`${table.revisionNumber} >= 1`),
    check('tax_rule_revisions_jurisdiction_ck', sql`${table.jurisdiction} = 'CZ_DOMESTIC'`),
    check('tax_rule_revisions_treatment_ck', sql`${table.treatmentCategory} = 'TAXABLE'`),
    check('tax_rule_revisions_composition_ck', sql`${table.compositionKind} = 'EXCLUSIVE'`),
    check(
      'tax_rule_revisions_rate_ck',
      sql`${table.ratePercent} ~ '^(0\\.[0-9]*[1-9][0-9]*|[1-9][0-9]*(\\.[0-9]+)?)$'`,
    ),
    check(
      'tax_rule_revisions_period_ck',
      sql`${table.effectiveTo} is null or ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
    check(
      'tax_rule_revisions_supersedes_ck',
      sql`${table.supersedesRevisionId} is null or ${table.supersedesRevisionId} <> ${table.taxRuleRevisionId}`,
    ),
    trimmed('tax_rule_revisions_classification_ck', table.taxClassificationCode),
    fingerprint('tax_rule_revisions_fingerprint_ck', table.semanticFingerprint),
    trimmed('tax_rule_revisions_provenance_ck', table.provenanceRef),
    ...scopedPolicies('tax_rule_revisions_scope', table),
  ],
);

/** Ending a revision is a new fact; the revision itself stays immutable (#929, #949 F14). */
export const taxRuleRevisionEndFacts = taxSchema.table.withRLS(
  'tax_rule_revision_end_facts',
  {
    taxRuleRevisionEndFactId: uuid('tax_rule_revision_end_fact_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    endedEffectiveTo: timestamp('ended_effective_to', { withTimezone: true }).notNull(),
    taxRuleRevisionId: uuid('tax_rule_revision_id').notNull(),
    ...attribution(),
  },
  (table) => [
    scopeIdentity('tax_rule_revision_end_facts_scope_id_uk', table, table.taxRuleRevisionEndFactId),
    unique('tax_rule_revision_end_facts_revision_uk').on(table.tenantId, table.taxRuleRevisionId),
    unique('tax_rule_revision_end_facts_idempotency_uk').on(table.tenantId, table.idempotencyKey),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.taxRuleRevisionId],
      foreignColumns: [taxRuleRevisions.tenantId, taxRuleRevisions.legalEntityId, taxRuleRevisions.taxRuleRevisionId],
      name: 'tax_rule_revision_end_facts_revision_fk',
    }).onDelete('restrict'),
    trimmed('tax_rule_revision_end_facts_provenance_ck', table.provenanceRef),
    ...scopedPolicies('tax_rule_revision_end_facts_scope', table),
  ],
);

/** Confirmed correction provenance; the wrong revision stays addressable (#930 F8, #949 F45-F47). */
export const taxRuleCorrections = taxSchema.table.withRLS(
  'tax_rule_corrections',
  {
    taxRuleCorrectionId: uuid('tax_rule_correction_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull(),
    correctingRevisionId: uuid('correcting_revision_id').notNull(),
    wrongRevisionId: uuid('wrong_revision_id').notNull(),
    ...attribution(),
  },
  (table) => [
    scopeIdentity('tax_rule_corrections_scope_id_uk', table, table.taxRuleCorrectionId),
    unique('tax_rule_corrections_pair_uk').on(table.tenantId, table.wrongRevisionId, table.correctingRevisionId),
    unique('tax_rule_corrections_idempotency_uk').on(table.tenantId, table.idempotencyKey),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.wrongRevisionId],
      foreignColumns: [taxRuleRevisions.tenantId, taxRuleRevisions.legalEntityId, taxRuleRevisions.taxRuleRevisionId],
      name: 'tax_rule_corrections_wrong_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.correctingRevisionId],
      foreignColumns: [taxRuleRevisions.tenantId, taxRuleRevisions.legalEntityId, taxRuleRevisions.taxRuleRevisionId],
      name: 'tax_rule_corrections_correcting_fk',
    }).onDelete('restrict'),
    check('tax_rule_corrections_distinct_ck', sql`${table.wrongRevisionId} <> ${table.correctingRevisionId}`),
    trimmed('tax_rule_corrections_provenance_ck', table.provenanceRef),
    ...scopedPolicies('tax_rule_corrections_scope', table),
  ],
);

/** Stable Tax Fact Authority Contract identity for one exact fact family and seller scope (#949 F22-F23). */
export const taxFactAuthorityContracts = taxSchema.table.withRLS(
  'tax_fact_authority_contracts',
  {
    taxFactAuthorityContractId: uuid('tax_fact_authority_contract_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    factFamily: text('fact_family').notNull(),
    stableCode: text('stable_code').notNull(),
    ...attribution(),
  },
  (table) => [
    scopeIdentity('tax_fact_authority_contracts_scope_id_uk', table, table.taxFactAuthorityContractId),
    unique('tax_fact_authority_contracts_code_uk').on(table.tenantId, table.legalEntityId, table.stableCode),
    unique('tax_fact_authority_contracts_idempotency_uk').on(table.tenantId, table.idempotencyKey),
    index('tax_fact_authority_contracts_family_idx').on(table.tenantId, table.legalEntityId, table.factFamily),
    check('tax_fact_authority_contracts_family_ck', sql`${table.factFamily} = 'SELLING_LEGAL_ENTITY_VAT_REGISTRATION'`),
    stableCode('tax_fact_authority_contracts_code_ck', table.stableCode),
    trimmed('tax_fact_authority_contracts_provenance_ck', table.provenanceRef),
    ...scopedPolicies('tax_fact_authority_contracts_scope', table),
  ],
);

/**
 * Immutable authority revision: one System of Record plus distinct evidence-only source roles over an explicit
 * authority period (#949 F24-F32). Competing authorities are detected from the complete set, never newest-wins.
 */
export const taxFactAuthorityContractRevisions = taxSchema.table.withRLS(
  'tax_fact_authority_contract_revisions',
  {
    taxFactAuthorityContractRevisionId: uuid('tax_fact_authority_contract_revision_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    authorityFrom: timestamp('authority_from', { withTimezone: true }).notNull(),
    authorityTo: timestamp('authority_to', { withTimezone: true }),
    evidenceSourceRefs: jsonb('evidence_source_refs').$type<readonly string[]>().notNull(),
    revisionNumber: integer('revision_number').notNull(),
    semanticFingerprint: text('semantic_fingerprint').notNull(),
    systemOfRecordRef: text('system_of_record_ref').notNull(),
    taxFactAuthorityContractId: uuid('tax_fact_authority_contract_id').notNull(),
    ...attribution(),
  },
  (table) => [
    scopeIdentity('tax_fact_authority_revisions_scope_id_uk', table, table.taxFactAuthorityContractRevisionId),
    unique('tax_fact_authority_revisions_number_uk').on(
      table.tenantId,
      table.taxFactAuthorityContractId,
      table.revisionNumber,
    ),
    unique('tax_fact_authority_revisions_idempotency_uk').on(table.tenantId, table.idempotencyKey),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.taxFactAuthorityContractId],
      foreignColumns: [
        taxFactAuthorityContracts.tenantId,
        taxFactAuthorityContracts.legalEntityId,
        taxFactAuthorityContracts.taxFactAuthorityContractId,
      ],
      name: 'tax_fact_authority_revisions_contract_fk',
    }).onDelete('restrict'),
    check('tax_fact_authority_revisions_number_ck', sql`${table.revisionNumber} >= 1`),
    check(
      'tax_fact_authority_revisions_period_ck',
      sql`${table.authorityTo} is null or ${table.authorityTo} > ${table.authorityFrom}`,
    ),
    check('tax_fact_authority_revisions_evidence_ck', sql`jsonb_typeof(${table.evidenceSourceRefs}) = 'array'`),
    trimmed('tax_fact_authority_revisions_system_of_record_ck', table.systemOfRecordRef),
    fingerprint('tax_fact_authority_revisions_fingerprint_ck', table.semanticFingerprint),
    trimmed('tax_fact_authority_revisions_provenance_ck', table.provenanceRef),
    ...scopedPolicies('tax_fact_authority_revisions_scope', table),
  ],
);

const ownerReference = (name: string, column: AnyPgColumn) =>
  check(name, sql`${column} = btrim(${column}) and length(${column}) between 1 and 300`);

/**
 * One immutable source assertion about the Selling Legal Entity VAT Registration of this seller scope. Provider
 * identity, Source Record Reference and assertion key stay distinct (#958 F1-F8); the canonical fact subject is
 * `{fact_family, legal_entity_id, jurisdiction}`. Source times are nullable and never derived; `recorded_at` is
 * the OntOS receipt time (#958 F12-F16, F26). No adapter identity is stored, so a route change keeps provenance
 * (#958 F21-F22). `eligibility` is the only stored acceptance input; the #957 acceptance outcome depends on the
 * authority contracts and is always evaluated, never stored (#959 F25).
 */
export const taxSourceAssertions = taxSchema.table.withRLS(
  'tax_source_assertions',
  {
    taxSourceAssertionId: uuid('tax_source_assertion_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    authorityContractRevisionId: uuid('authority_contract_revision_id'),
    authorityRole: text('authority_role').notNull(),
    deliveryRef: text('delivery_ref'),
    eligibility: text('eligibility').notNull(),
    factFamily: text('fact_family').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    jurisdiction: text('jurisdiction').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }),
    registrationMeaning: text('registration_meaning').notNull(),
    semanticFingerprint: text('semantic_fingerprint').notNull(),
    sourceAssertionKey: text('source_assertion_key').notNull(),
    sourceRecordRef: text('source_record_ref').notNull(),
    sourceRef: text('source_ref').notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validTo: timestamp('valid_to', { withTimezone: true }),
    ...attribution(),
  },
  (table) => [
    scopeIdentity('tax_source_assertions_scope_id_uk', table, table.taxSourceAssertionId),
    unique('tax_source_assertions_key_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.sourceRef,
      table.sourceAssertionKey,
    ),
    unique('tax_source_assertions_idempotency_uk').on(table.tenantId, table.idempotencyKey),
    index('tax_source_assertions_family_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.factFamily,
      table.sourceRef,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.authorityContractRevisionId],
      foreignColumns: [
        taxFactAuthorityContractRevisions.tenantId,
        taxFactAuthorityContractRevisions.legalEntityId,
        taxFactAuthorityContractRevisions.taxFactAuthorityContractRevisionId,
      ],
      name: 'tax_source_assertions_authority_fk',
    }).onDelete('restrict'),
    check('tax_source_assertions_family_ck', sql`${table.factFamily} = 'SELLING_LEGAL_ENTITY_VAT_REGISTRATION'`),
    check('tax_source_assertions_jurisdiction_ck', sql`${table.jurisdiction} = 'CZ_DOMESTIC'`),
    check(
      'tax_source_assertions_meaning_ck',
      sql`${table.registrationMeaning} in ('REGISTERED', 'ENDED', 'NON_REGISTERED')`,
    ),
    check('tax_source_assertions_eligibility_ck', sql`${table.eligibility} in ('ELIGIBLE', 'VALIDITY_UNKNOWN')`),
    check('tax_source_assertions_role_ck', sql`${table.authorityRole} in ('SYSTEM_OF_RECORD', 'EVIDENCE', 'NONE')`),
    check(
      'tax_source_assertions_validity_ck',
      sql`${table.validFrom} is null or ${table.validTo} is null or ${table.validTo} > ${table.validFrom}`,
    ),
    ownerReference('tax_source_assertions_source_ck', table.sourceRef),
    ownerReference('tax_source_assertions_record_ck', table.sourceRecordRef),
    ownerReference('tax_source_assertions_key_ck', table.sourceAssertionKey),
    check(
      'tax_source_assertions_delivery_ck',
      sql`${table.deliveryRef} is null or (${table.deliveryRef} = btrim(${table.deliveryRef}) and length(${table.deliveryRef}) between 1 and 300)`,
    ),
    fingerprint('tax_source_assertions_fingerprint_ck', table.semanticFingerprint),
    trimmed('tax_source_assertions_provenance_ck', table.provenanceRef),
    ...scopedPolicies('tax_source_assertions_scope', table),
  ],
);

/**
 * Append-only source conflict detections. Resolution is a later governed step, so every row stays `OPEN`. One
 * invocation may detect several pairwise conflicts; each is unique per invocation, kind and counterpart.
 */
export const taxSourceConflicts = taxSchema.table.withRLS(
  'tax_source_conflicts',
  {
    taxSourceConflictId: uuid('tax_source_conflict_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    conflictKind: text('conflict_kind').notNull(),
    detail: jsonb('detail').$type<TaxSourceConflictDetail>().notNull(),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull(),
    factFamily: text('fact_family').notNull(),
    relatedAssertionId: uuid('related_assertion_id'),
    status: text('status').notNull(),
    subjectAssertionId: uuid('subject_assertion_id'),
    ...attribution(),
  },
  (table) => [
    scopeIdentity('tax_source_conflicts_scope_id_uk', table, table.taxSourceConflictId),
    unique('tax_source_conflicts_idempotency_uk')
      .on(table.tenantId, table.idempotencyKey, table.conflictKind, table.relatedAssertionId)
      .nullsNotDistinct(),
    index('tax_source_conflicts_family_idx').on(table.tenantId, table.legalEntityId, table.factFamily),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.subjectAssertionId],
      foreignColumns: [
        taxSourceAssertions.tenantId,
        taxSourceAssertions.legalEntityId,
        taxSourceAssertions.taxSourceAssertionId,
      ],
      name: 'tax_source_conflicts_subject_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.relatedAssertionId],
      foreignColumns: [
        taxSourceAssertions.tenantId,
        taxSourceAssertions.legalEntityId,
        taxSourceAssertions.taxSourceAssertionId,
      ],
      name: 'tax_source_conflicts_related_fk',
    }).onDelete('restrict'),
    check('tax_source_conflicts_family_ck', sql`${table.factFamily} = 'SELLING_LEGAL_ENTITY_VAT_REGISTRATION'`),
    check(
      'tax_source_conflicts_kind_ck',
      sql`${table.conflictKind} in ('ASSERTION_INTEGRITY', 'EVIDENCE_DISAGREEMENT', 'INCOMPATIBLE_AUTHORITATIVE_ASSERTIONS', 'AUTHORITY_CONFIGURATION')`,
    ),
    check('tax_source_conflicts_status_ck', sql`${table.status} = 'OPEN'`),
    check('tax_source_conflicts_detail_ck', sql`jsonb_typeof(${table.detail}) = 'object'`),
    check(
      'tax_source_conflicts_distinct_ck',
      sql`${table.relatedAssertionId} is null or ${table.subjectAssertionId} is distinct from ${table.relatedAssertionId}`,
    ),
    trimmed('tax_source_conflicts_provenance_ck', table.provenanceRef),
    ...scopedPolicies('tax_source_conflicts_scope', table),
  ],
);

const databaseSchema = {
  taxFactAuthorityContractRevisions,
  taxFactAuthorityContracts,
  taxRuleCorrections,
  taxRuleRevisionEndFacts,
  taxRuleRevisions,
  taxRules,
  taxSourceAssertions,
  taxSourceConflicts,
} as const;

export const TAX_TABLES = [
  taxRules,
  taxRuleRevisions,
  taxRuleRevisionEndFacts,
  taxRuleCorrections,
  taxFactAuthorityContracts,
  taxFactAuthorityContractRevisions,
  taxSourceAssertions,
  taxSourceConflicts,
] as const;

export const taxRelations = defineRelations(databaseSchema);
