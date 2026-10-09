import { tenantLegalEntityRlsPolicies, tenantRlsPolicies } from '@app/core-runtime';
import { defineRelations, sql } from 'drizzle-orm';
import type { Schema } from 'effect';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/** Private persistence schema. Other owners use generated Assortment contracts. */
export const ASSORTMENT_SCHEMA_NAME = 'assortment';

export const ASSORTMENT_TABLE_INVENTORY = [
  'assortment_stable_rules',
  'assortment_rule_revisions',
  'assortment_rule_retirement_facts',
  'assortment_applicability_bindings',
  'assortment_applicability_binding_end_facts',
  'assortment_closed_boundaries',
  'assortment_closed_boundary_end_facts',
  'assortment_admission_sets',
  'assortment_admission_set_entries',
  'assortment_collection_revisions',
  'assortment_decision_set_fences',
  'assortment_decision_evidence',
  'assortment_commitment_confirmations',
] as const;

export const DECISION_SET_FENCE_SOURCE_TABLES = [
  'assortment_stable_rules',
  'assortment_rule_revisions',
  'assortment_rule_retirement_facts',
  'assortment_applicability_bindings',
  'assortment_applicability_binding_end_facts',
  'assortment_closed_boundaries',
  'assortment_closed_boundary_end_facts',
  'assortment_admission_sets',
  'assortment_admission_set_entries',
  'assortment_collection_revisions',
] as const;

export const assortmentSchema = pgSchema(ASSORTMENT_SCHEMA_NAME);

const scopeColumns = () => ({
  tenantId: uuid('tenant_id').notNull(),
  legalEntityId: uuid('legal_entity_id').notNull(),
});

const scopeIdentity = (
  name: string,
  table: Readonly<Record<'tenantId' | 'legalEntityId', AnyPgColumn>>,
  id: AnyPgColumn,
) => unique(name).on(table.tenantId, table.legalEntityId, id);

const tenantIdentity = (name: string, table: Readonly<Record<'tenantId', AnyPgColumn>>, id: AnyPgColumn) =>
  unique(name).on(table.tenantId, id);

const attribution = () => ({
  actionInvocationId: uuid('action_invocation_id').notNull(),
  actorPrincipalId: uuid('actor_principal_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  provenanceRef: text('provenance_ref').notNull(),
  reason: text('reason').notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
});

const scopedPolicies = (prefix: string, table: Readonly<Record<'tenantId' | 'legalEntityId', AnyPgColumn>>) =>
  tenantLegalEntityRlsPolicies(prefix, table.tenantId, table.legalEntityId);

const tenantPolicies = (prefix: string, table: Readonly<Record<'tenantId', AnyPgColumn>>) =>
  tenantRlsPolicies(prefix, table.tenantId);

const trimmed = (name: string, column: AnyPgColumn) =>
  check(name, sql`${column} = btrim(${column}) and length(${column}) between 1 and 1000`);

const positive = (name: string, column: AnyPgColumn) => check(name, sql`${column} > 0`);

/** Immutable governance shell. Retirement is represented by an append-only fact. */
export const stableRules = assortmentSchema.table.withRLS(
  'assortment_stable_rules',
  {
    stableRuleId: uuid('stable_rule_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    stableCode: text('stable_code').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    ...attribution(),
  },
  (table) => [
    tenantIdentity('assortment_stable_rules_scope_id_uk', table, table.stableRuleId),
    unique('assortment_stable_rules_code_uk').on(table.tenantId, table.stableCode),
    unique('assortment_stable_rules_idempotency_uk').on(table.tenantId, table.idempotencyKey),
    check('assortment_stable_rules_code_ck', sql`${table.stableCode} ~ '^[a-z][a-z0-9._-]{0,127}$'`),
    trimmed('assortment_stable_rules_provenance_ck', table.provenanceRef),
    ...tenantPolicies('assortment_stable_rules_scope', table),
  ],
);

/** Immutable ordinary policy meaning; it owns no scope or effective lifecycle. */
export const ruleRevisions = assortmentSchema.table.withRLS(
  'assortment_rule_revisions',
  {
    ruleRevisionId: uuid('rule_revision_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    stableRuleId: uuid('stable_rule_id').notNull(),
    revisionNumber: integer('revision_number').notNull(),
    purpose: text('purpose').notNull(),
    effect: text('effect').notNull(),
    selectorKind: text('selector_kind').notNull(),
    selectorTargetOwnerModuleId: text('selector_target_owner_module_id'),
    selectorTargetResourceId: text('selector_target_resource_id'),
    selectorTargetResourceType: text('selector_target_resource_type'),
    semanticFingerprint: text('semantic_fingerprint').notNull(),
    ...attribution(),
  },
  (table) => [
    tenantIdentity('assortment_rule_revisions_scope_id_uk', table, table.ruleRevisionId),
    unique('assortment_rule_revisions_stable_number_uk').on(table.tenantId, table.stableRuleId, table.revisionNumber),
    unique('assortment_rule_revisions_idempotency_uk').on(table.tenantId, table.idempotencyKey),
    foreignKey({
      columns: [table.tenantId, table.stableRuleId],
      foreignColumns: [stableRules.tenantId, stableRules.stableRuleId],
      name: 'assortment_rule_revisions_stable_rule_fk',
    }).onDelete('restrict'),
    index('assortment_rule_revisions_current_idx').on(table.tenantId, table.stableRuleId),
    positive('assortment_rule_revisions_number_ck', table.revisionNumber),
    check('assortment_rule_revisions_purpose_ck', sql`${table.purpose} in ('VISIBILITY', 'PURCHASE')`),
    check('assortment_rule_revisions_effect_ck', sql`${table.effect} in ('ALLOW', 'DENY')`),
    check(
      'assortment_rule_revisions_selector_ck',
      sql`${table.selectorKind} in ('ALL', 'CATEGORY', 'PRODUCT', 'VARIANT', 'PACKAGE_OPTION') and ((${table.selectorKind} = 'ALL' and ${table.selectorTargetOwnerModuleId} is null and ${table.selectorTargetResourceId} is null and ${table.selectorTargetResourceType} is null) or (${table.selectorKind} <> 'ALL' and ${table.selectorTargetResourceId} is not null and ${table.selectorTargetResourceType} is not null and (${table.selectorTargetOwnerModuleId} is null or ${table.selectorTargetOwnerModuleId} ~ '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$')))`,
    ),
    check(
      'assortment_rule_revisions_purpose_selector_ck',
      sql`${table.purpose} = 'PURCHASE' or ${table.selectorKind} in ('ALL', 'CATEGORY', 'PRODUCT')`,
    ),
    check('assortment_rule_revisions_fingerprint_ck', sql`${table.semanticFingerprint} ~ '^[0-9a-f]{64}$'`),
    trimmed('assortment_rule_revisions_provenance_ck', table.provenanceRef),
    ...tenantPolicies('assortment_rule_revisions_scope', table),
  ],
);

export const ruleRetirementFacts = assortmentSchema.table.withRLS(
  'assortment_rule_retirement_facts',
  {
    ruleRetirementFactId: uuid('rule_retirement_fact_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    stableRuleId: uuid('stable_rule_id').notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    ...attribution(),
  },
  (table) => [
    tenantIdentity('assortment_rule_retirement_facts_scope_id_uk', table, table.ruleRetirementFactId),
    unique('assortment_rule_retirement_facts_rule_uk').on(table.tenantId, table.stableRuleId),
    unique('assortment_rule_retirement_facts_idempotency_uk').on(table.tenantId, table.idempotencyKey),
    foreignKey({
      columns: [table.tenantId, table.stableRuleId],
      foreignColumns: [stableRules.tenantId, stableRules.stableRuleId],
      name: 'assortment_rule_retirement_facts_rule_fk',
    }).onDelete('restrict'),
    trimmed('assortment_rule_retirement_facts_provenance_ck', table.provenanceRef),
    ...tenantPolicies('assortment_rule_retirement_facts_scope', table),
  ],
);

/** Immutable ordinary applicability fact. Its period ends only through an End fact. */
export const applicabilityBindings = assortmentSchema.table.withRLS(
  'assortment_applicability_bindings',
  {
    applicabilityBindingId: uuid('applicability_binding_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    ruleRevisionId: uuid('rule_revision_id').notNull(),
    bindingKind: text('binding_kind').notNull(),
    customerGroupResourceId: text('customer_group_resource_id'),
    subjectKind: text('subject_kind'),
    subjectResourceId: text('subject_resource_id'),
    channelResourceId: text('channel_resource_id').notNull(),
    marketResourceId: text('market_resource_id'),
    storefrontResourceId: text('storefront_resource_id'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    ...attribution(),
  },
  (table) => [
    scopeIdentity('assortment_bindings_scope_id_uk', table, table.applicabilityBindingId),
    unique('assortment_bindings_idempotency_uk').on(table.tenantId, table.legalEntityId, table.idempotencyKey),
    foreignKey({
      columns: [table.tenantId, table.ruleRevisionId],
      foreignColumns: [ruleRevisions.tenantId, ruleRevisions.ruleRevisionId],
      name: 'assortment_bindings_rule_revision_fk',
    }).onDelete('restrict'),
    index('assortment_bindings_current_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.bindingKind,
      table.channelResourceId,
      table.marketResourceId,
      table.storefrontResourceId,
      table.effectiveFrom,
    ),
    check('assortment_bindings_kind_ck', sql`${table.bindingKind} in ('SHARED', 'COMMERCE_CUSTOMER_GROUP', 'SUBJECT')`),
    check(
      'assortment_bindings_audience_ck',
      sql`(${table.bindingKind} = 'SHARED' and ${table.customerGroupResourceId} is null and ${table.subjectKind} is null and ${table.subjectResourceId} is null) or (${table.bindingKind} = 'COMMERCE_CUSTOMER_GROUP' and ${table.customerGroupResourceId} is not null and ${table.subjectKind} is null and ${table.subjectResourceId} is null) or (${table.bindingKind} = 'SUBJECT' and ${table.customerGroupResourceId} is null and ${table.subjectKind} in ('RETAIL_CUSTOMER_PROFILE', 'COUNTERPARTY') and ${table.subjectResourceId} is not null)`,
    ),
    trimmed('assortment_bindings_channel_ck', table.channelResourceId),
    ...scopedPolicies('assortment_bindings_scope', table),
  ],
);

export const applicabilityBindingEndFacts = assortmentSchema.table.withRLS(
  'assortment_applicability_binding_end_facts',
  {
    applicabilityBindingEndFactId: uuid('applicability_binding_end_fact_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    applicabilityBindingId: uuid('applicability_binding_id').notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    ...attribution(),
  },
  (table) => [
    scopeIdentity('assortment_binding_end_facts_scope_id_uk', table, table.applicabilityBindingEndFactId),
    unique('assortment_binding_end_facts_binding_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.applicabilityBindingId,
    ),
    unique('assortment_binding_end_facts_idempotency_uk').on(table.tenantId, table.legalEntityId, table.idempotencyKey),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.applicabilityBindingId],
      foreignColumns: [
        applicabilityBindings.tenantId,
        applicabilityBindings.legalEntityId,
        applicabilityBindings.applicabilityBindingId,
      ],
      name: 'assortment_binding_end_facts_binding_fk',
    }).onDelete('restrict'),
    ...scopedPolicies('assortment_binding_end_facts_scope', table),
  ],
);

export const closedBoundaries = assortmentSchema.table.withRLS(
  'assortment_closed_boundaries',
  {
    closedBoundaryId: uuid('closed_boundary_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    subjectKind: text('subject_kind').notNull(),
    subjectResourceId: text('subject_resource_id').notNull(),
    purpose: text('purpose').notNull(),
    channelResourceId: text('channel_resource_id').notNull(),
    marketResourceId: text('market_resource_id'),
    storefrontResourceId: text('storefront_resource_id'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    semanticFingerprint: text('semantic_fingerprint').notNull(),
    ...attribution(),
  },
  (table) => [
    scopeIdentity('assortment_closed_boundaries_scope_id_uk', table, table.closedBoundaryId),
    unique('assortment_closed_boundaries_idempotency_uk').on(table.tenantId, table.legalEntityId, table.idempotencyKey),
    index('assortment_closed_boundaries_current_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.subjectKind,
      table.subjectResourceId,
      table.purpose,
      table.channelResourceId,
      table.marketResourceId,
      table.storefrontResourceId,
      table.effectiveFrom,
    ),
    check(
      'assortment_closed_boundaries_subject_ck',
      sql`${table.subjectKind} in ('RETAIL_CUSTOMER_PROFILE', 'COUNTERPARTY') and ${table.subjectResourceId} = btrim(${table.subjectResourceId}) and length(${table.subjectResourceId}) > 0`,
    ),
    check('assortment_closed_boundaries_purpose_ck', sql`${table.purpose} in ('VISIBILITY', 'PURCHASE')`),
    trimmed('assortment_closed_boundaries_channel_ck', table.channelResourceId),
    ...scopedPolicies('assortment_closed_boundaries_scope', table),
  ],
);

export const closedBoundaryEndFacts = assortmentSchema.table.withRLS(
  'assortment_closed_boundary_end_facts',
  {
    closedBoundaryEndFactId: uuid('closed_boundary_end_fact_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    closedBoundaryId: uuid('closed_boundary_id').notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    basisFingerprint: text('basis_fingerprint').notNull(),
    ...attribution(),
  },
  (table) => [
    scopeIdentity('assortment_boundary_end_facts_scope_id_uk', table, table.closedBoundaryEndFactId),
    unique('assortment_boundary_end_facts_boundary_uk').on(table.tenantId, table.legalEntityId, table.closedBoundaryId),
    unique('assortment_boundary_end_facts_idempotency_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.idempotencyKey,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.closedBoundaryId],
      foreignColumns: [closedBoundaries.tenantId, closedBoundaries.legalEntityId, closedBoundaries.closedBoundaryId],
      name: 'assortment_boundary_end_facts_boundary_fk',
    }).onDelete('restrict'),
    ...scopedPolicies('assortment_boundary_end_facts_scope', table),
  ],
);

export const collectionRevisions = assortmentSchema.table.withRLS(
  'assortment_collection_revisions',
  {
    collectionRevisionId: uuid('collection_revision_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    collectionKind: text('collection_kind').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    purpose: text('purpose').notNull(),
    revision: integer('revision').notNull(),
    memberCount: integer('member_count').notNull(),
    completeness: text('completeness').notNull(),
    contentHash: text('content_hash').notNull(),
    ...attribution(),
  },
  (table) => [
    scopeIdentity('assortment_collection_revisions_scope_id_uk', table, table.collectionRevisionId),
    unique('assortment_collection_revisions_aggregate_revision_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.collectionKind,
      table.aggregateId,
      table.revision,
    ),
    unique('assortment_collection_revisions_idempotency_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.idempotencyKey,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.aggregateId],
      foreignColumns: [closedBoundaries.tenantId, closedBoundaries.legalEntityId, closedBoundaries.closedBoundaryId],
      name: 'assortment_collection_revisions_boundary_fk',
    }).onDelete('restrict'),
    check('assortment_collection_revisions_kind_ck', sql`${table.collectionKind} = 'CLOSED_BOUNDARY_ADMISSION_SET'`),
    check('assortment_collection_revisions_purpose_ck', sql`${table.purpose} in ('VISIBILITY', 'PURCHASE')`),
    positive('assortment_collection_revisions_revision_ck', table.revision),
    check('assortment_collection_revisions_member_count_ck', sql`${table.memberCount} >= 0`),
    check('assortment_collection_revisions_completeness_ck', sql`${table.completeness} = 'COMPLETE'`),
    check('assortment_collection_revisions_hash_ck', sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
    ...scopedPolicies('assortment_collection_revisions_scope', table),
  ],
);

/** Immutable complete Admission Set aggregate header. EMPTY is distinct from an ALL entry. */
export const admissionSets = assortmentSchema.table.withRLS(
  'assortment_admission_sets',
  {
    admissionSetId: uuid('admission_set_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    closedBoundaryId: uuid('closed_boundary_id').notNull(),
    purpose: text('purpose').notNull(),
    setKind: text('set_kind').notNull(),
    collectionRevisionId: uuid('collection_revision_id').notNull(),
    ...attribution(),
  },
  (table) => [
    scopeIdentity('assortment_admission_sets_scope_id_uk', table, table.admissionSetId),
    unique('assortment_admission_sets_boundary_uk').on(table.tenantId, table.legalEntityId, table.closedBoundaryId),
    unique('assortment_admission_sets_collection_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.collectionRevisionId,
    ),
    unique('assortment_admission_sets_idempotency_uk').on(table.tenantId, table.legalEntityId, table.idempotencyKey),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.closedBoundaryId],
      foreignColumns: [closedBoundaries.tenantId, closedBoundaries.legalEntityId, closedBoundaries.closedBoundaryId],
      name: 'assortment_admission_sets_boundary_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.collectionRevisionId],
      foreignColumns: [
        collectionRevisions.tenantId,
        collectionRevisions.legalEntityId,
        collectionRevisions.collectionRevisionId,
      ],
      name: 'assortment_admission_sets_collection_fk',
    }).onDelete('restrict'),
    check('assortment_admission_sets_purpose_ck', sql`${table.purpose} in ('VISIBILITY', 'PURCHASE')`),
    check('assortment_admission_sets_kind_ck', sql`${table.setKind} in ('EMPTY', 'ENTRIES')`),
    ...scopedPolicies('assortment_admission_sets_scope', table),
  ],
);

export const admissionSetEntries = assortmentSchema.table.withRLS(
  'assortment_admission_set_entries',
  {
    admissionSetEntryId: uuid('admission_set_entry_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    admissionSetId: uuid('admission_set_id').notNull(),
    coverageKind: text('coverage_kind').notNull(),
    targetOwnerModuleId: text('target_owner_module_id'),
    targetResourceId: text('target_resource_id'),
    targetResourceType: text('target_resource_type'),
    ordinal: integer('ordinal').notNull(),
    ...attribution(),
  },
  (table) => [
    scopeIdentity('assortment_admission_entries_scope_id_uk', table, table.admissionSetEntryId),
    unique('assortment_admission_entries_position_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.admissionSetId,
      table.ordinal,
    ),
    unique('assortment_admission_entries_semantics_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.admissionSetId,
      table.coverageKind,
      table.targetResourceId,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.admissionSetId],
      foreignColumns: [admissionSets.tenantId, admissionSets.legalEntityId, admissionSets.admissionSetId],
      name: 'assortment_admission_entries_set_fk',
    }).onDelete('restrict'),
    check(
      'assortment_admission_entries_kind_ck',
      sql`${table.coverageKind} in ('ALL', 'CATEGORY', 'PRODUCT', 'VARIANT', 'PACKAGE_OPTION')`,
    ),
    check('assortment_admission_entries_ordinal_ck', sql`${table.ordinal} >= 0`),
    check(
      'assortment_admission_entries_target_ck',
      sql`(${table.coverageKind} = 'ALL' and ${table.targetOwnerModuleId} is null and ${table.targetResourceId} is null and ${table.targetResourceType} is null) or (${table.coverageKind} <> 'ALL' and ${table.targetResourceId} is not null and ${table.targetResourceType} is not null and (${table.targetOwnerModuleId} is null or ${table.targetOwnerModuleId} ~ '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$'))`,
    ),
    ...scopedPolicies('assortment_admission_entries_scope', table),
  ],
);

/** Tenant-wide mutation fence used to invalidate complete Assortment query proofs. */
export const decisionSetFences = assortmentSchema.table.withRLS(
  'assortment_decision_set_fences',
  {
    generation: uuid('generation').defaultRandom().notNull(),
    tenantId: uuid('tenant_id').primaryKey(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => {
    const predicate = sql`${table.tenantId} = nullif(current_setting('ontos.tenant_id', true), '')::uuid`;
    return [
      ...tenantPolicies('assortment_decision_set_fences_scope', table),
      // SECURITY DEFINER fence routines remain tenant-scoped under FORCE RLS; runtime has no raw table grants.
      pgPolicy('assortment_decision_set_fences_owner_routine', {
        for: 'all',
        to: 'public',
        using: predicate,
        withCheck: predicate,
      }),
    ];
  },
);

/** Immutable owner-local Decision Evidence; explanation reads bind by request fingerprint. */
export const decisionEvidence = assortmentSchema.table.withRLS(
  'assortment_decision_evidence',
  {
    decisionEvidenceId: uuid('decision_evidence_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    requestFingerprint: text('request_fingerprint').notNull(),
    outcome: text('outcome').notNull(),
    requestJson: jsonb('request_json').$type<Schema.Json>().notNull(),
    decisionJson: jsonb('decision_json').$type<Schema.Json>().notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    scopeIdentity('assortment_decision_evidence_scope_id_uk', table, table.decisionEvidenceId),
    index('assortment_decision_evidence_lookup_idx').on(table.tenantId, table.legalEntityId, table.requestFingerprint),
    check('assortment_decision_evidence_fingerprint_ck', sql`${table.requestFingerprint} ~ '^[0-9a-f]{64}$'`),
    check('assortment_decision_evidence_outcome_ck', sql`${table.outcome} in ('ELIGIBLE', 'INELIGIBLE')`),
    ...scopedPolicies('assortment_decision_evidence_scope', table),
  ],
);

/** Immutable Attempt-bound Assortment proof; expiry is terminal and rows are never updated. */
export const commitmentConfirmations = assortmentSchema.table.withRLS(
  'assortment_commitment_confirmations',
  {
    commitmentConfirmationId: uuid('commitment_confirmation_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    attemptModuleId: text('attempt_module_id').notNull(),
    attemptResourceId: text('attempt_resource_id').notNull(),
    attemptResourceType: text('attempt_resource_type').notNull(),
    prospectiveMeaningJson: jsonb('prospective_meaning_json').$type<Schema.Json>().notNull(),
    constituentFingerprint: text('constituent_fingerprint').notNull(),
    constituentJson: jsonb('constituent_json').$type<Schema.Json>().notNull(),
    candidateJson: jsonb('candidate_json').$type<Schema.Json>().notNull(),
    decisionEvidenceJson: jsonb('decision_evidence_json').$type<Schema.Json>().notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actorPrincipalId: uuid('actor_principal_id').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    scopeIdentity('assortment_commitment_confirmations_scope_id_uk', table, table.commitmentConfirmationId),
    unique('assortment_commitment_confirmations_invocation_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.actionInvocationId,
    ),
    index('assortment_commitment_confirmations_active_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.attemptModuleId,
      table.attemptResourceId,
      table.attemptResourceType,
      table.constituentFingerprint,
      table.expiresAt,
    ),
    check(
      'assortment_commitment_confirmations_attempt_module_ck',
      sql`${table.attemptModuleId} = btrim(${table.attemptModuleId}) and length(${table.attemptModuleId}) between 1 and 200`,
    ),
    check(
      'assortment_commitment_confirmations_attempt_id_ck',
      sql`${table.attemptResourceId} = btrim(${table.attemptResourceId}) and length(${table.attemptResourceId}) between 1 and 200`,
    ),
    check(
      'assortment_commitment_confirmations_attempt_type_ck',
      sql`${table.attemptResourceType} = btrim(${table.attemptResourceType}) and length(${table.attemptResourceType}) between 1 and 200`,
    ),
    check(
      'assortment_commitment_confirmations_fingerprint_ck',
      sql`${table.constituentFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'assortment_commitment_confirmations_validity_ck',
      sql`${table.expiresAt} > ${table.issuedAt} and ${table.expiresAt} <= ${table.issuedAt} + interval '30 seconds'`,
    ),
    ...scopedPolicies('assortment_commitment_confirmations_scope', table),
  ],
);

const databaseSchema = {
  admissionSetEntries,
  admissionSets,
  applicabilityBindingEndFacts,
  applicabilityBindings,
  closedBoundaries,
  closedBoundaryEndFacts,
  collectionRevisions,
  commitmentConfirmations,
  decisionSetFences,
  decisionEvidence,
  ruleRetirementFacts,
  ruleRevisions,
  stableRules,
} as const;

export const ASSORTMENT_TABLES = [
  stableRules,
  ruleRevisions,
  ruleRetirementFacts,
  applicabilityBindings,
  applicabilityBindingEndFacts,
  closedBoundaries,
  closedBoundaryEndFacts,
  admissionSets,
  admissionSetEntries,
  collectionRevisions,
  decisionSetFences,
  decisionEvidence,
  commitmentConfirmations,
] as const;

export const assortmentRelations = defineRelations(databaseSchema);
