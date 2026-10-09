import { tenantLegalEntityRlsPolicies } from '@app/core-runtime';
import { defineRelations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import type { TaxEvaluationEvidenceSchema } from '../../shared/domain/tax-evaluation-contracts.ts';
import type { TaxOutcomeSuccessSchema } from '../../shared/domain/tax-kernel/tax-outcome.ts';

/** Private TAX persistence schema. Other owners use generated TAX contracts. */
export const TAX_SCHEMA_NAME = 'tax';

export const TAX_TABLE_INVENTORY = [
  'tax_rules',
  'tax_rule_revisions',
  'tax_rule_revision_end_facts',
  'tax_rule_corrections',
  'tax_seller_vat_regime_declarations',
  'tax_order_tax_finalizations',
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

const ownerReference = (name: string, column: AnyPgColumn) =>
  check(name, sql`${column} = btrim(${column}) and length(${column}) between 1 and 300`);

/**
 * Merchant-declared, append-only Seller VAT Regime Declaration revisions (#907 Unit 10, LEGAL §1). The seller is
 * never verified: `provenance` only distinguishes a merchant-declared revision from one imported by the step-9
 * migration cutover. `recorded_at` is the trusted Action operation time, never the DB default, so the backdating
 * check and the row agree (F4); the DB check repeats the rule as a race backstop.
 */
export const taxSellerVatRegimeDeclarations = taxSchema.table.withRLS(
  'tax_seller_vat_regime_declarations',
  {
    taxSellerVatRegimeDeclarationId: uuid('tax_seller_vat_regime_declaration_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actorPrincipalId: uuid('actor_principal_id').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    intentFingerprint: text('intent_fingerprint').notNull(),
    provenance: text('provenance').notNull(),
    reason: text('reason'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    regime: text('regime').notNull(),
    replacesScheduled: boolean('replaces_scheduled').notNull(),
    revision: integer('revision').notNull(),
  },
  (table) => [
    scopeIdentity('tax_seller_vat_regime_declarations_scope_id_uk', table, table.taxSellerVatRegimeDeclarationId),
    unique('tax_seller_vat_regime_declarations_revision_uk').on(table.tenantId, table.legalEntityId, table.revision),
    unique('tax_seller_vat_regime_declarations_idempotency_uk').on(table.tenantId, table.idempotencyKey),
    check('tax_seller_vat_regime_declarations_revision_ck', sql`${table.revision} >= 1`),
    check('tax_seller_vat_regime_declarations_regime_ck', sql`${table.regime} in ('VAT_PAYER', 'NON_PAYER')`),
    check(
      'tax_seller_vat_regime_declarations_provenance_ck',
      sql`${table.provenance} in ('MERCHANT_DECLARED', 'MIGRATED')`,
    ),
    check(
      'tax_seller_vat_regime_declarations_reason_ck',
      sql`${table.reason} is null or (${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000)`,
    ),
    check(
      'tax_seller_vat_regime_declarations_backdating_reason_ck',
      sql`${table.reason} is not null or ${table.effectiveFrom} >= ${table.recordedAt}`,
    ),
    fingerprint('tax_seller_vat_regime_declarations_fingerprint_ck', table.intentFingerprint),
    ...scopedPolicies('tax_seller_vat_regime_declarations_scope', table),
  ],
);

/** Governing Tax Rule Revision of one final Decision unit, kept for correction evidence (#930 F13). */
export interface GoverningTaxRuleRevision {
  readonly revision: number;
  readonly taxRuleId: string;
}

/**
 * One durable, immutable final Launch Order Tax per submission (#944 F10-F13, #941 F9): the Decision with its Result
 * fixed at Order Commitment Time T, the evidence of the evaluation that produced it and the frozen intent it
 * answers. Only successful finals are stored; a proven non-finalization may run again (#944 F12). Append-only: a
 * later rule change or correction never refreshes it (#930 F10-F11, J3).
 */
export const taxOrderTaxFinalizations = taxSchema.table.withRLS(
  'tax_order_tax_finalizations',
  {
    taxOrderTaxFinalizationId: uuid('tax_order_tax_finalization_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    decisionId: text('decision_id').notNull(),
    decompositionNeed: text('decomposition_need').notNull(),
    evidence: jsonb('evidence').$type<typeof TaxEvaluationEvidenceSchema.Encoded>().notNull(),
    governingRuleRevisions: jsonb('governing_rule_revisions').$type<readonly GoverningTaxRuleRevision[]>().notNull(),
    intentFingerprint: text('intent_fingerprint').notNull(),
    orderCommitmentTime: timestamp('order_commitment_time', { withTimezone: true }).notNull(),
    outcome: jsonb('outcome').$type<typeof TaxOutcomeSuccessSchema.Encoded>().notNull(),
    submissionRef: text('submission_ref').notNull(),
    taxEvaluationTime: timestamp('tax_evaluation_time', { withTimezone: true }).notNull(),
    ...attribution(),
  },
  (table) => [
    scopeIdentity('tax_order_tax_finalizations_scope_id_uk', table, table.taxOrderTaxFinalizationId),
    unique('tax_order_tax_finalizations_submission_uk').on(table.tenantId, table.legalEntityId, table.submissionRef),
    unique('tax_order_tax_finalizations_idempotency_uk').on(table.tenantId, table.idempotencyKey),
    ownerReference('tax_order_tax_finalizations_submission_ck', table.submissionRef),
    ownerReference('tax_order_tax_finalizations_decision_ck', table.decisionId),
    fingerprint('tax_order_tax_finalizations_intent_ck', table.intentFingerprint),
    check(
      'tax_order_tax_finalizations_decomposition_ck',
      sql`${table.decompositionNeed} in ('NOT_NEEDED', 'PER_TAXABLE_SUPPLY_UNIT')`,
    ),
    check('tax_order_tax_finalizations_outcome_ck', sql`jsonb_typeof(${table.outcome}) = 'object'`),
    check('tax_order_tax_finalizations_evidence_ck', sql`jsonb_typeof(${table.evidence}) = 'object'`),
    check('tax_order_tax_finalizations_governing_ck', sql`jsonb_typeof(${table.governingRuleRevisions}) = 'array'`),
    check('tax_order_tax_finalizations_times_ck', sql`${table.orderCommitmentTime} <= ${table.taxEvaluationTime}`),
    trimmed('tax_order_tax_finalizations_provenance_ck', table.provenanceRef),
    ...scopedPolicies('tax_order_tax_finalizations_scope', table),
  ],
);

const databaseSchema = {
  taxOrderTaxFinalizations,
  taxRuleCorrections,
  taxRuleRevisionEndFacts,
  taxRuleRevisions,
  taxRules,
  taxSellerVatRegimeDeclarations,
} as const;

export const TAX_TABLES = [
  taxRules,
  taxRuleRevisions,
  taxRuleRevisionEndFacts,
  taxRuleCorrections,
  taxSellerVatRegimeDeclarations,
  taxOrderTaxFinalizations,
] as const;

export const taxRelations = defineRelations(databaseSchema);
