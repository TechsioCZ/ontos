/* oxlint-disable perfectionist/sort-objects -- Drizzle declaration order is the physical Privacy storage contract; expires: 2027-03-31. */
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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const PRIVACY_SCHEMA_NAME = 'privacy';

export const PRIVACY_TABLE_INVENTORY = [
  'anti_resurrection_protections',
  'applicability_decisions',
  'applicability_policies',
  'consent_decisions',
  'disposition_decisions',
  'dsr_cases',
  'dsr_deadlines',
  'dsr_delivery_access',
  'dsr_delivery_evidence',
  'dsr_owner_tasks',
  'dsr_resolver_assignments',
  'dsr_responses',
  'dsr_substantive_decisions',
  'dsr_verifications',
  'eligibility_evidence',
  'external_obligations',
  'legal_basis_assignments',
  'legal_holds',
  'notice_provisions',
  'notice_versions',
  'owner_contributions',
  'owner_execution_outcomes',
  'privacy_measure_dispatches',
  'privacy_representations',
  'privacy_subjects',
  'processing_activities',
  'processing_activity_lifecycle_events',
  'processing_interventions',
  'processing_purposes',
  'purpose_versions',
  'responsibility_assignments',
  'retention_evaluation_work',
  'retention_exceptions',
  'retention_rules',
  'temporary_dsr_exports',
] as const;

export const privacySchema = pgSchema(PRIVACY_SCHEMA_NAME);

const recordedAt = () => timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull();
const scopeColumns = () => ({
  tenantId: uuid('tenant_id').notNull(),
  legalEntityId: uuid('legal_entity_id').notNull(),
});

export const privacySubjects = privacySchema.table.withRLS(
  'privacy_subjects',
  {
    privacySubjectId: uuid('privacy_subject_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    subjectKind: text('subject_kind').notNull(),
    subjectRecord: jsonb('subject_record').notNull(),
    createdAt: recordedAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('privacy_subjects_scope_id_uk').on(table.tenantId, table.legalEntityId, table.privacySubjectId),
    index('privacy_subjects_scope_kind_idx').on(table.tenantId, table.legalEntityId, table.subjectKind),
    check('privacy_subjects_kind_ck', sql`${table.subjectKind} in ('DATA_SUBJECT', 'ANONYMOUS')`),
    ...tenantLegalEntityRlsPolicies('privacy_subjects_scope', table.tenantId, table.legalEntityId),
  ],
);

export const processingPurposes = privacySchema.table.withRLS(
  'processing_purposes',
  {
    processingPurposeId: uuid('processing_purpose_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    businessCode: text('business_code').notNull(),
    governanceOwnerId: uuid('governance_owner_id').notNull(),
    lifecycle: text('lifecycle').default('ACTIVE').notNull(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: recordedAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('privacy_processing_purposes_scope_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.processingPurposeId,
    ),
    unique('privacy_processing_purposes_scope_code_uk').on(table.tenantId, table.legalEntityId, table.businessCode),
    check('privacy_processing_purposes_code_ck', sql`${table.businessCode} ~ '^[A-Z][A-Z0-9_]{0,63}$'`),
    check('privacy_processing_purposes_lifecycle_ck', sql`${table.lifecycle} in ('ACTIVE', 'RETIRED')`),
    ...tenantLegalEntityRlsPolicies('privacy_processing_purposes_scope', table.tenantId, table.legalEntityId),
  ],
);

export const purposeVersions = privacySchema.table.withRLS(
  'purpose_versions',
  {
    purposeVersionId: uuid('purpose_version_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    processingPurposeId: uuid('processing_purpose_id').notNull(),
    versionNumber: integer('version_number').notNull(),
    meaning: text('meaning').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('privacy_purpose_versions_scope_id_uk').on(table.tenantId, table.legalEntityId, table.purposeVersionId),
    unique('privacy_purpose_versions_number_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.processingPurposeId,
      table.versionNumber,
    ),
    unique('privacy_purpose_versions_invocation_uk').on(table.tenantId, table.legalEntityId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.processingPurposeId],
      foreignColumns: [
        processingPurposes.tenantId,
        processingPurposes.legalEntityId,
        processingPurposes.processingPurposeId,
      ],
      name: 'privacy_purpose_versions_purpose_fk',
    }),
    index('privacy_purpose_versions_history_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.processingPurposeId,
      table.versionNumber,
    ),
    check('privacy_purpose_versions_number_ck', sql`${table.versionNumber} > 0`),
    check(
      'privacy_purpose_versions_period_ck',
      sql`${table.effectiveTo} is null or ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
    ...tenantLegalEntityRlsPolicies('privacy_purpose_versions_scope', table.tenantId, table.legalEntityId),
  ],
);

export const processingActivities = privacySchema.table.withRLS(
  'processing_activities',
  {
    processingActivityId: text('processing_activity_id').primaryKey(),
    ...scopeColumns(),
    currentLifecycle: text('current_lifecycle').default('PROPOSED').notNull(),
    activityRecord: jsonb('activity_record').notNull(),
    createdAt: recordedAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('privacy_processing_activities_scope_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.processingActivityId,
    ),
    index('privacy_processing_activities_lifecycle_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.currentLifecycle,
    ),
    check(
      'privacy_processing_activities_lifecycle_ck',
      sql`${table.currentLifecycle} in ('PROPOSED', 'EFFECTIVE', 'SUSPENDED', 'ENDED')`,
    ),
    ...tenantLegalEntityRlsPolicies('privacy_processing_activities_scope', table.tenantId, table.legalEntityId),
  ],
);

export const processingActivityLifecycleEvents = privacySchema.table.withRLS(
  'processing_activity_lifecycle_events',
  {
    lifecycleEventId: uuid('lifecycle_event_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    processingActivityId: text('processing_activity_id').notNull(),
    fromLifecycle: text('from_lifecycle'),
    toLifecycle: text('to_lifecycle').notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    eventRecord: jsonb('event_record').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('privacy_activity_lifecycle_scope_id_uk').on(table.tenantId, table.legalEntityId, table.lifecycleEventId),
    unique('privacy_activity_lifecycle_invocation_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.actionInvocationId,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.processingActivityId],
      foreignColumns: [
        processingActivities.tenantId,
        processingActivities.legalEntityId,
        processingActivities.processingActivityId,
      ],
      name: 'privacy_activity_lifecycle_activity_fk',
    }),
    index('privacy_activity_lifecycle_history_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.processingActivityId,
      table.recordedAt,
    ),
    ...tenantLegalEntityRlsPolicies('privacy_activity_lifecycle_scope', table.tenantId, table.legalEntityId),
  ],
);

export const responsibilityAssignments = privacySchema.table.withRLS(
  'responsibility_assignments',
  {
    assignmentRef: text('assignment_ref').primaryKey(),
    ...scopeColumns(),
    scopeRef: text('scope_ref').notNull(),
    role: text('role').notNull(),
    assignmentRecord: jsonb('assignment_record').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('privacy_responsibility_assignments_scope_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.assignmentRef,
    ),
    unique('privacy_responsibility_assignments_invocation_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.actionInvocationId,
    ),
    index('privacy_responsibility_assignments_current_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.scopeRef,
      table.role,
      table.effectiveFrom,
      table.effectiveTo,
    ),
    check('privacy_responsibility_assignments_role_ck', sql`${table.role} in ('CONTROLLER', 'PROCESSOR', 'RECIPIENT')`),
    check(
      'privacy_responsibility_assignments_period_ck',
      sql`${table.effectiveTo} is null or ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
    ...tenantLegalEntityRlsPolicies('privacy_responsibility_assignments_scope', table.tenantId, table.legalEntityId),
  ],
);

export const applicabilityDecisions = privacySchema.table.withRLS(
  'applicability_decisions',
  {
    decisionId: text('decision_id').primaryKey(),
    ...scopeColumns(),
    processingScopeRef: text('processing_scope_ref').notNull(),
    operation: text('operation').notNull(),
    outcome: text('outcome').notNull(),
    decisionRecord: jsonb('decision_record').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('privacy_applicability_decisions_scope_id_uk').on(table.tenantId, table.legalEntityId, table.decisionId),
    unique('privacy_applicability_decisions_invocation_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.actionInvocationId,
    ),
    index('privacy_applicability_decisions_scope_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.processingScopeRef,
      table.operation,
      table.evaluatedAt,
    ),
    check(
      'privacy_applicability_decisions_outcome_ck',
      sql`${table.outcome} in ('APPLICABLE', 'UNRESOLVED', 'CONFLICT')`,
    ),
    check(
      'privacy_applicability_decisions_operation_ck',
      sql`char_length(btrim(${table.operation})) between 1 and 500`,
    ),
    ...tenantLegalEntityRlsPolicies('privacy_applicability_decisions_scope', table.tenantId, table.legalEntityId),
  ],
);

export const legalBasisAssignments = privacySchema.table.withRLS(
  'legal_basis_assignments',
  {
    assignmentRef: text('assignment_ref').primaryKey(),
    ...scopeColumns(),
    processingScopeRef: text('processing_scope_ref').notNull(),
    decision: text('decision').notNull(),
    assignmentRecord: jsonb('assignment_record').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('privacy_legal_basis_assignments_scope_id_uk').on(table.tenantId, table.legalEntityId, table.assignmentRef),
    unique('privacy_legal_basis_assignments_invocation_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.actionInvocationId,
    ),
    index('privacy_legal_basis_assignments_current_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.processingScopeRef,
      table.effectiveFrom,
      table.effectiveTo,
    ),
    check('privacy_legal_basis_assignments_decision_ck', sql`${table.decision} in ('APPROVED', 'REJECTED')`),
    check(
      'privacy_legal_basis_assignments_period_ck',
      sql`${table.effectiveTo} is null or ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
    ...tenantLegalEntityRlsPolicies('privacy_legal_basis_assignments_scope', table.tenantId, table.legalEntityId),
  ],
);

export const noticeVersions = privacySchema.table.withRLS(
  'notice_versions',
  {
    noticeVersionId: uuid('notice_version_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    noticeId: uuid('notice_id').notNull(),
    versionNumber: integer('version_number').notNull(),
    language: text('language').notNull(),
    contentIdentity: text('content_identity').notNull(),
    noticeRecord: jsonb('notice_record').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('privacy_notice_versions_scope_id_uk').on(table.tenantId, table.legalEntityId, table.noticeVersionId),
    unique('privacy_notice_versions_number_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.noticeId,
      table.versionNumber,
    ),
    index('privacy_notice_versions_selection_idx').on(table.tenantId, table.legalEntityId, table.language),
    ...tenantLegalEntityRlsPolicies('privacy_notice_versions_scope', table.tenantId, table.legalEntityId),
  ],
);

export const noticeProvisions = privacySchema.table.withRLS(
  'notice_provisions',
  {
    provisionId: text('provision_id').primaryKey(),
    ...scopeColumns(),
    noticeVersionRef: text('notice_version_ref').notNull(),
    privacySubjectRef: text('privacy_subject_ref'),
    anonymousContextRef: text('anonymous_context_ref'),
    outcome: text('outcome').notNull(),
    provisionRecord: jsonb('provision_record').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('privacy_notice_provisions_scope_id_uk').on(table.tenantId, table.legalEntityId, table.provisionId),
    unique('privacy_notice_provisions_invocation_uk').on(table.tenantId, table.legalEntityId, table.actionInvocationId),
    index('privacy_notice_provisions_subject_idx').on(table.tenantId, table.legalEntityId, table.privacySubjectRef),
    check(
      'privacy_notice_provisions_subject_ck',
      sql`(${table.privacySubjectRef} is null) <> (${table.anonymousContextRef} is null)`,
    ),
    ...tenantLegalEntityRlsPolicies('privacy_notice_provisions_scope', table.tenantId, table.legalEntityId),
  ],
);

export const consentDecisions = privacySchema.table.withRLS(
  'consent_decisions',
  {
    decisionId: text('decision_id').primaryKey(),
    ...scopeColumns(),
    scopeRef: text('scope_ref').notNull(),
    decision: text('decision').notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    decisionRecord: jsonb('decision_record').notNull(),
    idempotencyKey: text('idempotency_key'),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('privacy_consent_decisions_scope_id_uk').on(table.tenantId, table.legalEntityId, table.decisionId),
    unique('privacy_consent_decisions_invocation_uk').on(table.tenantId, table.legalEntityId, table.actionInvocationId),
    unique('privacy_consent_decisions_idempotency_uk').on(table.tenantId, table.legalEntityId, table.idempotencyKey),
    index('privacy_consent_decisions_current_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.scopeRef,
      table.effectiveAt,
      table.recordedAt,
    ),
    check('privacy_consent_decisions_kind_ck', sql`${table.decision} in ('GRANTED', 'REFUSED', 'WITHDRAWN')`),
    ...tenantLegalEntityRlsPolicies('privacy_consent_decisions_scope', table.tenantId, table.legalEntityId),
  ],
);

export const eligibilityEvidence = privacySchema.table.withRLS(
  'eligibility_evidence',
  {
    evidenceId: text('evidence_id').primaryKey(),
    ...scopeColumns(),
    processingScopeRef: text('processing_scope_ref').notNull(),
    outcome: text('outcome').notNull(),
    evidenceRecord: jsonb('evidence_record').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('privacy_eligibility_evidence_scope_id_uk').on(table.tenantId, table.legalEntityId, table.evidenceId),
    unique('privacy_eligibility_evidence_invocation_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.actionInvocationId,
    ),
    index('privacy_eligibility_evidence_decision_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.processingScopeRef,
      table.evaluatedAt,
    ),
    check(
      'privacy_eligibility_evidence_outcome_ck',
      sql`${table.outcome} in ('ALLOWED', 'NOT_ALLOWED', 'INDETERMINATE')`,
    ),
    ...tenantLegalEntityRlsPolicies('privacy_eligibility_evidence_scope', table.tenantId, table.legalEntityId),
  ],
);

export const retentionRules = privacySchema.table.withRLS(
  'retention_rules',
  {
    retentionRuleId: uuid('retention_rule_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    ruleRef: text('rule_ref').notNull(),
    ruleVersion: integer('rule_version').notNull(),
    contentScopeRef: text('content_scope_ref').notNull(),
    ruleRecord: jsonb('rule_record').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('privacy_retention_rules_scope_id_uk').on(table.tenantId, table.legalEntityId, table.retentionRuleId),
    unique('privacy_retention_rules_version_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.ruleRef,
      table.ruleVersion,
    ),
    unique('privacy_retention_rules_invocation_uk').on(table.tenantId, table.legalEntityId, table.actionInvocationId),
    index('privacy_retention_rules_scope_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.contentScopeRef,
      table.effectiveFrom,
      table.effectiveTo,
    ),
    check('privacy_retention_rules_version_ck', sql`${table.ruleVersion} > 0`),
    check(
      'privacy_retention_rules_period_ck',
      sql`${table.effectiveTo} is null or ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
    ...tenantLegalEntityRlsPolicies('privacy_retention_rules_scope', table.tenantId, table.legalEntityId),
  ],
);

export const retentionEvaluationWork = privacySchema.table.withRLS(
  'retention_evaluation_work',
  {
    workRef: text('work_ref').primaryKey(),
    ...scopeColumns(),
    idempotencyRef: text('idempotency_ref').notNull(),
    ruleRef: text('rule_ref').notNull(),
    ruleVersion: integer('rule_version').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    status: text('status').default('PENDING').notNull(),
    workRecord: jsonb('work_record').notNull(),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }),
    createdAt: recordedAt(),
  },
  (table) => [
    unique('privacy_retention_work_scope_id_uk').on(table.tenantId, table.legalEntityId, table.workRef),
    unique('privacy_retention_work_idempotency_uk').on(table.tenantId, table.legalEntityId, table.idempotencyRef),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.ruleRef, table.ruleVersion],
      foreignColumns: [
        retentionRules.tenantId,
        retentionRules.legalEntityId,
        retentionRules.ruleRef,
        retentionRules.ruleVersion,
      ],
      name: 'privacy_retention_work_rule_fk',
    }),
    index('privacy_retention_work_due_idx').on(table.tenantId, table.legalEntityId, table.status, table.dueAt),
    check('privacy_retention_work_rule_version_ck', sql`${table.ruleVersion} > 0`),
    check(
      'privacy_retention_work_status_ck',
      sql`${table.status} in ('PENDING', 'READY', 'BLOCKED', 'INDETERMINATE', 'COMPLETED')`,
    ),
    ...tenantLegalEntityRlsPolicies('privacy_retention_work_scope', table.tenantId, table.legalEntityId),
  ],
);

export const retentionExceptions = privacySchema.table.withRLS(
  'retention_exceptions',
  {
    exceptionEventId: uuid('exception_event_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    exceptionRef: text('exception_ref').notNull(),
    exceptionRecord: jsonb('exception_record').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }).notNull(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('privacy_retention_exceptions_scope_id_uk').on(table.tenantId, table.legalEntityId, table.exceptionEventId),
    unique('privacy_retention_exceptions_invocation_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.actionInvocationId,
    ),
    index('privacy_retention_exceptions_history_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.exceptionRef,
      table.recordedAt,
    ),
    check('privacy_retention_exceptions_period_ck', sql`${table.effectiveTo} > ${table.effectiveFrom}`),
    ...tenantLegalEntityRlsPolicies('privacy_retention_exceptions_scope', table.tenantId, table.legalEntityId),
  ],
);

export const legalHolds = privacySchema.table.withRLS(
  'legal_holds',
  {
    holdEventId: uuid('hold_event_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    holdRef: text('hold_ref').notNull(),
    holdRecord: jsonb('hold_record').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }).notNull(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('privacy_legal_holds_scope_id_uk').on(table.tenantId, table.legalEntityId, table.holdEventId),
    unique('privacy_legal_holds_invocation_uk').on(table.tenantId, table.legalEntityId, table.actionInvocationId),
    index('privacy_legal_holds_history_idx').on(table.tenantId, table.legalEntityId, table.holdRef, table.recordedAt),
    check('privacy_legal_holds_period_ck', sql`${table.effectiveTo} > ${table.effectiveFrom}`),
    ...tenantLegalEntityRlsPolicies('privacy_legal_holds_scope', table.tenantId, table.legalEntityId),
  ],
);

export const dispositionDecisions = privacySchema.table.withRLS(
  'disposition_decisions',
  {
    decisionRef: text('decision_ref').primaryKey(),
    ...scopeColumns(),
    ruleRef: text('rule_ref').notNull(),
    ruleVersion: integer('rule_version').notNull(),
    outcome: text('outcome').notNull(),
    decisionRecord: jsonb('decision_record').notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('privacy_disposition_decisions_scope_id_uk').on(table.tenantId, table.legalEntityId, table.decisionRef),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.ruleRef, table.ruleVersion],
      foreignColumns: [
        retentionRules.tenantId,
        retentionRules.legalEntityId,
        retentionRules.ruleRef,
        retentionRules.ruleVersion,
      ],
      name: 'privacy_disposition_rule_fk',
    }),
    index('privacy_disposition_decisions_outcome_idx').on(table.tenantId, table.legalEntityId, table.outcome),
    check('privacy_disposition_decisions_rule_version_ck', sql`${table.ruleVersion} > 0`),
    check(
      'privacy_disposition_decisions_outcome_ck',
      sql`${table.outcome} in ('RETAIN', 'RESTRICT', 'ANONYMIZE', 'DELETE', 'INDETERMINATE')`,
    ),
    ...tenantLegalEntityRlsPolicies('privacy_disposition_decisions_scope', table.tenantId, table.legalEntityId),
  ],
);

export const dsrCases = privacySchema.table.withRLS(
  'dsr_cases',
  {
    caseRef: text('case_ref').primaryKey(),
    ...scopeColumns(),
    caseStatus: text('case_status').notNull(),
    caseRecord: jsonb('case_record').notNull(),
    originalReceivedAt: timestamp('original_received_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('privacy_dsr_cases_scope_id_uk').on(table.tenantId, table.legalEntityId, table.caseRef),
    index('privacy_dsr_cases_status_idx').on(table.tenantId, table.legalEntityId, table.caseStatus),
    ...tenantLegalEntityRlsPolicies('privacy_dsr_cases_scope', table.tenantId, table.legalEntityId),
  ],
);

export const dsrOwnerTasks = privacySchema.table.withRLS(
  'dsr_owner_tasks',
  {
    taskId: text('task_id').primaryKey(),
    ...scopeColumns(),
    caseRef: text('case_ref').notNull(),
    owningCapability: text('owning_capability').notNull(),
    status: text('status').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    taskRecord: jsonb('task_record').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('privacy_dsr_owner_tasks_scope_id_uk').on(table.tenantId, table.legalEntityId, table.taskId),
    unique('privacy_dsr_owner_tasks_idempotency_uk').on(table.tenantId, table.legalEntityId, table.idempotencyKey),
    unique('privacy_dsr_owner_tasks_invocation_uk').on(table.tenantId, table.legalEntityId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.caseRef],
      foreignColumns: [dsrCases.tenantId, dsrCases.legalEntityId, dsrCases.caseRef],
      name: 'privacy_dsr_owner_tasks_case_fk',
    }),
    index('privacy_dsr_owner_tasks_case_idx').on(table.tenantId, table.legalEntityId, table.caseRef, table.status),
    ...tenantLegalEntityRlsPolicies('privacy_dsr_owner_tasks_scope', table.tenantId, table.legalEntityId),
  ],
);

export const dsrDeliveryAccess = privacySchema.table.withRLS(
  'dsr_delivery_access',
  {
    accessId: text('access_id').primaryKey(),
    ...scopeColumns(),
    deliveryOutputRef: text('delivery_output_ref').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    accessRecord: jsonb('access_record').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    createdAt: recordedAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('privacy_dsr_delivery_access_scope_id_uk').on(table.tenantId, table.legalEntityId, table.accessId),
    unique('privacy_dsr_delivery_access_idempotency_uk').on(table.tenantId, table.legalEntityId, table.idempotencyKey),
    unique('privacy_dsr_delivery_access_invocation_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.actionInvocationId,
    ),
    uniqueIndex('privacy_dsr_delivery_access_current_uk')
      .on(table.tenantId, table.legalEntityId, table.deliveryOutputRef)
      .where(sql`${table.revokedAt} is null`),
    index('privacy_dsr_delivery_access_expiry_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.expiresAt,
      table.revokedAt,
    ),
    check('privacy_dsr_delivery_access_expiry_ck', sql`${table.expiresAt} > ${table.createdAt}`),
    ...tenantLegalEntityRlsPolicies('privacy_dsr_delivery_access_scope', table.tenantId, table.legalEntityId),
  ],
);

export const dsrDeliveryEvidence = privacySchema.table.withRLS(
  'dsr_delivery_evidence',
  {
    evidenceId: text('evidence_id').primaryKey(),
    ...scopeColumns(),
    accessId: text('access_id').notNull(),
    deliveryOutputRef: text('delivery_output_ref').notNull(),
    outcome: text('outcome').notNull(),
    evidenceRecord: jsonb('evidence_record').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('privacy_dsr_delivery_evidence_scope_id_uk').on(table.tenantId, table.legalEntityId, table.evidenceId),
    unique('privacy_dsr_delivery_evidence_invocation_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.actionInvocationId,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.accessId],
      foreignColumns: [dsrDeliveryAccess.tenantId, dsrDeliveryAccess.legalEntityId, dsrDeliveryAccess.accessId],
      name: 'privacy_dsr_delivery_evidence_access_fk',
    }),
    index('privacy_dsr_delivery_evidence_output_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.deliveryOutputRef,
      table.occurredAt,
    ),
    check(
      'privacy_dsr_delivery_evidence_outcome_ck',
      sql`${table.outcome} in ('SUCCESSFUL_DELIVERY', 'KNOWN_FAILURE', 'UNAUTHORIZED_ACCESS', 'INDETERMINATE_HANDOFF')`,
    ),
    ...tenantLegalEntityRlsPolicies('privacy_dsr_delivery_evidence_scope', table.tenantId, table.legalEntityId),
  ],
);

export const temporaryDsrExports = privacySchema.table.withRLS(
  'temporary_dsr_exports',
  {
    exportRef: text('export_ref').primaryKey(),
    ...scopeColumns(),
    deliveryOutputRef: text('delivery_output_ref').notNull(),
    deliveryOutputRevision: integer('delivery_output_revision').notNull(),
    retainUntil: timestamp('retain_until', { withTimezone: true }).notNull(),
    disposedAt: timestamp('disposed_at', { withTimezone: true }),
    exportRecord: jsonb('export_record').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('privacy_temporary_dsr_exports_scope_id_uk').on(table.tenantId, table.legalEntityId, table.exportRef),
    unique('privacy_temporary_dsr_exports_invocation_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.actionInvocationId,
    ),
    index('privacy_temporary_dsr_exports_retention_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.retainUntil,
      table.disposedAt,
    ),
    check('privacy_temporary_dsr_exports_revision_ck', sql`${table.deliveryOutputRevision} > 0`),
    check('privacy_temporary_dsr_exports_retention_ck', sql`${table.retainUntil} > ${table.createdAt}`),
    ...tenantLegalEntityRlsPolicies('privacy_temporary_dsr_exports_scope', table.tenantId, table.legalEntityId),
  ],
);

export const privacyMeasureDispatches = privacySchema.table.withRLS(
  'privacy_measure_dispatches',
  {
    measureId: text('measure_id').primaryKey(),
    ...scopeColumns(),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').notNull(),
    handoffRecord: jsonb('handoff_record').notNull(),
    createdAt: recordedAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('privacy_measure_dispatches_scope_id_uk').on(table.tenantId, table.legalEntityId, table.measureId),
    unique('privacy_measure_dispatches_idempotency_uk').on(table.tenantId, table.legalEntityId, table.idempotencyKey),
    ...tenantLegalEntityRlsPolicies('privacy_measure_dispatches_scope', table.tenantId, table.legalEntityId),
  ],
);

export const ownerExecutionOutcomes = privacySchema.table.withRLS(
  'owner_execution_outcomes',
  {
    outcomeId: text('outcome_id').primaryKey(),
    ...scopeColumns(),
    measureId: text('measure_id').notNull(),
    attempt: integer('attempt').notNull(),
    status: text('status').notNull(),
    outcomeRecord: jsonb('outcome_record').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('privacy_owner_outcomes_scope_id_uk').on(table.tenantId, table.legalEntityId, table.outcomeId),
    unique('privacy_owner_outcomes_attempt_uk').on(table.tenantId, table.legalEntityId, table.measureId, table.attempt),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.measureId],
      foreignColumns: [
        privacyMeasureDispatches.tenantId,
        privacyMeasureDispatches.legalEntityId,
        privacyMeasureDispatches.measureId,
      ],
      name: 'privacy_owner_outcomes_measure_fk',
    }),
    ...tenantLegalEntityRlsPolicies('privacy_owner_outcomes_scope', table.tenantId, table.legalEntityId),
  ],
);

export const externalObligations = privacySchema.table.withRLS(
  'external_obligations',
  {
    obligationId: text('obligation_id').primaryKey(),
    ...scopeColumns(),
    measureId: text('measure_id').notNull(),
    revision: integer('revision').notNull(),
    status: text('status').notNull(),
    obligationRecord: jsonb('obligation_record').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    createdAt: recordedAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('privacy_external_obligations_scope_id_uk').on(table.tenantId, table.legalEntityId, table.obligationId),
    unique('privacy_external_obligations_invocation_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.actionInvocationId,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.measureId],
      foreignColumns: [
        privacyMeasureDispatches.tenantId,
        privacyMeasureDispatches.legalEntityId,
        privacyMeasureDispatches.measureId,
      ],
      name: 'privacy_external_obligations_measure_fk',
    }),
    index('privacy_external_obligations_status_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.measureId,
      table.status,
    ),
    check('privacy_external_obligations_revision_ck', sql`${table.revision} > 0`),
    check(
      'privacy_external_obligations_status_ck',
      sql`${table.status} in ('PENDING', 'ACHIEVED', 'PARTIAL', 'BUSINESS_REJECTED', 'NOT_APPLICABLE', 'FAILED', 'BLOCKED', 'INDETERMINATE')`,
    ),
    ...tenantLegalEntityRlsPolicies('privacy_external_obligations_scope', table.tenantId, table.legalEntityId),
  ],
);

export const antiResurrectionProtections = privacySchema.table.withRLS(
  'anti_resurrection_protections',
  {
    protectionId: text('protection_id').primaryKey(),
    ...scopeColumns(),
    subjectRef: text('subject_ref').notNull(),
    measure: text('measure').notNull(),
    protectionRecord: jsonb('protection_record').notNull(),
    protectedAt: timestamp('protected_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('privacy_anti_resurrection_scope_id_uk').on(table.tenantId, table.legalEntityId, table.protectionId),
    index('privacy_anti_resurrection_subject_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.subjectRef,
      table.measure,
      table.protectedAt,
    ),
    check('privacy_anti_resurrection_measure_ck', sql`${table.measure} in ('DELETE', 'ANONYMIZE')`),
    ...tenantLegalEntityRlsPolicies('privacy_anti_resurrection_scope', table.tenantId, table.legalEntityId),
  ],
);

export const privacyRepresentations = privacySchema.table.withRLS(
  'privacy_representations',
  {
    representationId: text('representation_id').primaryKey(),
    ...scopeColumns(),
    subjectRef: text('subject_ref').notNull(),
    representativePrincipalId: uuid('representative_principal_id').notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    validTo: timestamp('valid_to', { withTimezone: true }),
    representationRecord: jsonb('representation_record').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('privacy_representations_scope_id_uk').on(table.tenantId, table.legalEntityId, table.representationId),
    unique('privacy_representations_invocation_uk').on(table.tenantId, table.legalEntityId, table.actionInvocationId),
    index('privacy_representations_subject_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.subjectRef,
      table.validFrom,
      table.validTo,
    ),
    check('privacy_representations_period_ck', sql`${table.validTo} is null or ${table.validTo} > ${table.validFrom}`),
    ...tenantLegalEntityRlsPolicies('privacy_representations_scope', table.tenantId, table.legalEntityId),
  ],
);

export const applicabilityPolicies = privacySchema.table.withRLS(
  'applicability_policies',
  {
    applicabilityPolicyId: uuid('applicability_policy_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    policyKey: text('policy_key').notNull(),
    policyVersion: text('policy_version').notNull(),
    scopeKey: text('scope_key').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    policyRecord: jsonb('policy_record').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('privacy_applicability_policies_version_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.policyKey,
      table.policyVersion,
    ),
    unique('privacy_applicability_policies_invocation_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.actionInvocationId,
    ),
    index('privacy_applicability_policies_scope_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.scopeKey,
      table.effectiveFrom,
      table.effectiveTo,
    ),
    check(
      'privacy_applicability_policies_period_ck',
      sql`${table.effectiveTo} is null or ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
    ...tenantLegalEntityRlsPolicies('privacy_applicability_policies_scope', table.tenantId, table.legalEntityId),
  ],
);

export const processingInterventions = privacySchema.table.withRLS(
  'processing_interventions',
  {
    interventionRef: text('intervention_ref').primaryKey(),
    ...scopeColumns(),
    interventionKind: text('intervention_kind').notNull(),
    processingScopeRef: text('processing_scope_ref').notNull(),
    status: text('status').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    interventionRecord: jsonb('intervention_record').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('privacy_processing_interventions_scope_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.interventionRef,
    ),
    unique('privacy_processing_interventions_invocation_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.actionInvocationId,
    ),
    index('privacy_processing_interventions_current_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.processingScopeRef,
      table.interventionKind,
      table.observedAt,
    ),
    check('privacy_processing_interventions_kind_ck', sql`${table.interventionKind} in ('OBJECTION', 'RESTRICTION')`),
    check('privacy_processing_interventions_status_ck', sql`${table.status} in ('ACTIVE', 'RESOLVED', 'ABSENT')`),
    ...tenantLegalEntityRlsPolicies('privacy_processing_interventions_scope', table.tenantId, table.legalEntityId),
  ],
);

export const ownerContributions = privacySchema.table.withRLS(
  'owner_contributions',
  {
    contributionId: text('contribution_id').primaryKey(),
    ...scopeColumns(),
    controllerObligationRef: text('controller_obligation_ref').notNull(),
    ownerModuleId: text('owner_module_id').notNull(),
    subjectRef: text('subject_ref').notNull(),
    right: text('right').notNull(),
    revision: integer('revision').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    contributionRecord: jsonb('contribution_record').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('privacy_owner_contributions_scope_id_uk').on(table.tenantId, table.legalEntityId, table.contributionId),
    unique('privacy_owner_contributions_invocation_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.actionInvocationId,
    ),
    unique('privacy_owner_contributions_revision_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.controllerObligationRef,
      table.ownerModuleId,
      table.subjectRef,
      table.right,
      table.revision,
    ),
    index('privacy_owner_contributions_obligation_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.controllerObligationRef,
      table.observedAt,
    ),
    check('privacy_owner_contributions_revision_ck', sql`${table.revision} > 0`),
    ...tenantLegalEntityRlsPolicies('privacy_owner_contributions_scope', table.tenantId, table.legalEntityId),
  ],
);

export const dsrVerifications = privacySchema.table.withRLS(
  'dsr_verifications',
  {
    verificationRef: text('verification_ref').primaryKey(),
    ...scopeColumns(),
    caseRef: text('case_ref').notNull(),
    subjectRef: text('subject_ref').notNull(),
    verificationScope: text('verification_scope').notNull(),
    outcome: text('outcome').notNull(),
    verificationRecord: jsonb('verification_record').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('privacy_dsr_verifications_scope_id_uk').on(table.tenantId, table.legalEntityId, table.verificationRef),
    unique('privacy_dsr_verifications_invocation_uk').on(table.tenantId, table.legalEntityId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.caseRef],
      foreignColumns: [dsrCases.tenantId, dsrCases.legalEntityId, dsrCases.caseRef],
      name: 'privacy_dsr_verifications_case_fk',
    }),
    index('privacy_dsr_verifications_case_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.caseRef,
      table.subjectRef,
    ),
    check(
      'privacy_dsr_verifications_scope_ck',
      sql`${table.verificationScope} in ('INTAKE', 'SENSITIVE_LOOKUP', 'EXPORT', 'MUTATION')`,
    ),
    check(
      'privacy_dsr_verifications_outcome_ck',
      sql`${table.outcome} in ('PENDING', 'VERIFIED', 'FAILED', 'EXPIRED')`,
    ),
    ...tenantLegalEntityRlsPolicies('privacy_dsr_verifications_scope', table.tenantId, table.legalEntityId),
  ],
);

export const dsrResolverAssignments = privacySchema.table.withRLS(
  'dsr_resolver_assignments',
  {
    assignmentRef: text('assignment_ref').primaryKey(),
    ...scopeColumns(),
    caseRef: text('case_ref').notNull(),
    controllerRef: text('controller_ref').notNull(),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull(),
    assignmentRecord: jsonb('assignment_record').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('privacy_dsr_resolver_assignments_scope_id_uk').on(table.tenantId, table.legalEntityId, table.assignmentRef),
    unique('privacy_dsr_resolver_assignments_invocation_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.actionInvocationId,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.caseRef],
      foreignColumns: [dsrCases.tenantId, dsrCases.legalEntityId, dsrCases.caseRef],
      name: 'privacy_dsr_resolver_assignments_case_fk',
    }),
    index('privacy_dsr_resolver_assignments_current_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.caseRef,
      table.controllerRef,
      table.assignedAt,
    ),
    ...tenantLegalEntityRlsPolicies('privacy_dsr_resolver_assignments_scope', table.tenantId, table.legalEntityId),
  ],
);

export const dsrDeadlines = privacySchema.table.withRLS(
  'dsr_deadlines',
  {
    deadlineId: uuid('deadline_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    caseRef: text('case_ref').notNull(),
    controllerRef: text('controller_ref').notNull(),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    deadlineRecord: jsonb('deadline_record').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('privacy_dsr_deadlines_invocation_uk').on(table.tenantId, table.legalEntityId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.caseRef],
      foreignColumns: [dsrCases.tenantId, dsrCases.legalEntityId, dsrCases.caseRef],
      name: 'privacy_dsr_deadlines_case_fk',
    }),
    index('privacy_dsr_deadlines_case_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.caseRef,
      table.controllerRef,
      table.deadlineAt,
    ),
    ...tenantLegalEntityRlsPolicies('privacy_dsr_deadlines_scope', table.tenantId, table.legalEntityId),
  ],
);

export const dsrSubstantiveDecisions = privacySchema.table.withRLS(
  'dsr_substantive_decisions',
  {
    decisionRef: text('decision_ref').primaryKey(),
    ...scopeColumns(),
    caseRef: text('case_ref').notNull(),
    controllerRef: text('controller_ref').notNull(),
    right: text('right').notNull(),
    outcome: text('outcome').notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
    decisionRecord: jsonb('decision_record').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('privacy_dsr_substantive_decisions_scope_id_uk').on(table.tenantId, table.legalEntityId, table.decisionRef),
    unique('privacy_dsr_substantive_decisions_invocation_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.actionInvocationId,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.caseRef],
      foreignColumns: [dsrCases.tenantId, dsrCases.legalEntityId, dsrCases.caseRef],
      name: 'privacy_dsr_substantive_decisions_case_fk',
    }),
    index('privacy_dsr_substantive_decisions_case_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.caseRef,
      table.controllerRef,
      table.right,
      table.decidedAt,
    ),
    check(
      'privacy_dsr_substantive_decisions_outcome_ck',
      sql`${table.outcome} in ('GRANTED', 'PARTIALLY_GRANTED', 'DENIED', 'UNRESOLVED')`,
    ),
    ...tenantLegalEntityRlsPolicies('privacy_dsr_substantive_decisions_scope', table.tenantId, table.legalEntityId),
  ],
);

export const dsrResponses = privacySchema.table.withRLS(
  'dsr_responses',
  {
    responseRef: text('response_ref').primaryKey(),
    ...scopeColumns(),
    caseRef: text('case_ref').notNull(),
    final: boolean('final').notNull(),
    responseRecord: jsonb('response_record').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('privacy_dsr_responses_scope_id_uk').on(table.tenantId, table.legalEntityId, table.responseRef),
    unique('privacy_dsr_responses_invocation_uk').on(table.tenantId, table.legalEntityId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.caseRef],
      foreignColumns: [dsrCases.tenantId, dsrCases.legalEntityId, dsrCases.caseRef],
      name: 'privacy_dsr_responses_case_fk',
    }),
    index('privacy_dsr_responses_case_idx').on(table.tenantId, table.legalEntityId, table.caseRef, table.createdAt),
    ...tenantLegalEntityRlsPolicies('privacy_dsr_responses_scope', table.tenantId, table.legalEntityId),
  ],
);

export const PRIVACY_TABLES = [
  antiResurrectionProtections,
  applicabilityDecisions,
  applicabilityPolicies,
  consentDecisions,
  dispositionDecisions,
  dsrCases,
  dsrDeadlines,
  dsrDeliveryAccess,
  dsrDeliveryEvidence,
  dsrOwnerTasks,
  dsrResolverAssignments,
  dsrResponses,
  dsrSubstantiveDecisions,
  dsrVerifications,
  eligibilityEvidence,
  externalObligations,
  legalBasisAssignments,
  legalHolds,
  noticeProvisions,
  noticeVersions,
  ownerExecutionOutcomes,
  ownerContributions,
  privacyMeasureDispatches,
  privacyRepresentations,
  privacySubjects,
  processingActivities,
  processingActivityLifecycleEvents,
  processingPurposes,
  processingInterventions,
  purposeVersions,
  responsibilityAssignments,
  retentionEvaluationWork,
  retentionExceptions,
  retentionRules,
  temporaryDsrExports,
] as const;

const privacyDatabaseSchema = {
  antiResurrectionProtections,
  applicabilityDecisions,
  applicabilityPolicies,
  consentDecisions,
  dispositionDecisions,
  dsrCases,
  dsrDeadlines,
  dsrDeliveryAccess,
  dsrDeliveryEvidence,
  dsrOwnerTasks,
  dsrResolverAssignments,
  dsrResponses,
  dsrSubstantiveDecisions,
  dsrVerifications,
  eligibilityEvidence,
  externalObligations,
  legalBasisAssignments,
  legalHolds,
  noticeProvisions,
  noticeVersions,
  ownerExecutionOutcomes,
  ownerContributions,
  privacyMeasureDispatches,
  privacyRepresentations,
  privacySubjects,
  processingActivities,
  processingActivityLifecycleEvents,
  processingPurposes,
  processingInterventions,
  purposeVersions,
  responsibilityAssignments,
  retentionEvaluationWork,
  retentionExceptions,
  retentionRules,
  temporaryDsrExports,
} as const;

/** Relational Queries v2 entry point for the Privacy owner-local database. */
export const privacyRelations = defineRelations(privacyDatabaseSchema);
