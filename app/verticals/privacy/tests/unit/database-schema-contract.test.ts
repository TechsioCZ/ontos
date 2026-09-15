// @effect-diagnostics nodeBuiltinImport:off -- Migration contract reads checked-in generated SQL; expires: 2027-03-31.
import { expect, it } from 'effect-rstest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Array as EffectArray, Order } from 'effect';
import { readdirSync, readFileSync } from 'node:fs';

import {
  PRIVACY_SCHEMA_NAME,
  PRIVACY_TABLE_INVENTORY,
  PRIVACY_TABLES,
  antiResurrectionProtections,
  applicabilityDecisions,
  consentDecisions,
  dsrDeliveryAccess,
  eligibilityEvidence,
  externalObligations,
  legalBasisAssignments,
  legalHolds,
  noticeProvisions,
  processingActivities,
  purposeVersions,
  responsibilityAssignments,
  retentionExceptions,
  retentionRules,
} from '../../src/database/schema.ts';

const migrationSql = (): string => {
  const root = new URL('../../drizzle/', import.meta.url);
  return EffectArray.sort(readdirSync(root), Order.String)
    .map((folder) => readFileSync(new URL(`${folder}/migration.sql`, root), 'utf-8'))
    .join('\n');
};

const IMMUTABLE_TRIGGER_NAMES = [
  'privacy_anti_resurrection_immutable',
  'privacy_applicability_decisions_immutable',
  'privacy_applicability_policies_immutable',
  'privacy_consent_decisions_immutable',
  'privacy_disposition_decisions_immutable',
  'privacy_dsr_deadlines_immutable',
  'privacy_dsr_delivery_evidence_immutable',
  'privacy_dsr_resolver_assignments_immutable',
  'privacy_dsr_responses_immutable',
  'privacy_dsr_substantive_decisions_immutable',
  'privacy_dsr_verifications_immutable',
  'privacy_eligibility_evidence_immutable',
  'privacy_legal_basis_assignments_immutable',
  'privacy_legal_holds_immutable',
  'privacy_notice_provisions_immutable',
  'privacy_notice_versions_immutable',
  'privacy_owner_contributions_immutable',
  'privacy_owner_execution_outcomes_immutable',
  'privacy_processing_activity_lifecycle_immutable',
  'privacy_processing_interventions_immutable',
  'privacy_purpose_versions_immutable',
  'privacy_representations_immutable',
  'privacy_responsibility_assignments_immutable',
  'privacy_retention_exceptions_immutable',
  'privacy_retention_rules_immutable',
] as const;

const IMMUTABLE_TABLES = [
  'anti_resurrection_protections',
  'applicability_decisions',
  'applicability_policies',
  'consent_decisions',
  'disposition_decisions',
  'dsr_deadlines',
  'dsr_delivery_evidence',
  'dsr_resolver_assignments',
  'dsr_responses',
  'dsr_substantive_decisions',
  'dsr_verifications',
  'eligibility_evidence',
  'legal_basis_assignments',
  'legal_holds',
  'notice_provisions',
  'notice_versions',
  'owner_contributions',
  'owner_execution_outcomes',
  'privacy_representations',
  'processing_activity_lifecycle_events',
  'processing_interventions',
  'purpose_versions',
  'responsibility_assignments',
  'retention_exceptions',
  'retention_rules',
] as const;

interface ForeignKeyContract {
  readonly columns: readonly string[];
  readonly foreignColumns: readonly string[];
  readonly foreignTable: string;
  readonly name: string;
}

const foreignKeyOrder = Order.mapInput(Order.String, (foreignKey: ForeignKeyContract) => foreignKey.name);

it('owns the complete Privacy persistence inventory in one schema', () => {
  const qualifiedNames = EffectArray.sort(
    PRIVACY_TABLES.map((table) => {
      const config = getTableConfig(table);
      return `${config.schema}.${config.name}`;
    }),
    Order.String,
  );

  expect(PRIVACY_SCHEMA_NAME).toBe('privacy');
  expect(PRIVACY_TABLE_INVENTORY).toHaveLength(35);
  expect(qualifiedNames).toEqual(PRIVACY_TABLE_INVENTORY.map((name) => `privacy.${name}`));
});

it('enables tenant and legal-entity RLS on every Privacy table', () => {
  /* jscpd:ignore-start -- Every owner schema must independently prove the same mandatory tenant and Legal Entity RLS contract. */
  // fallow-ignore-next-line code-duplication -- Mandatory owner-local RLS acceptance loop mirrors the repository contract by design.
  for (const table of PRIVACY_TABLES) {
    const config = getTableConfig(table);
    expect(config.enableRLS, `${config.name} must enable RLS`).toBe(true);
    expect(config.columns.some((column) => column.name === 'tenant_id' && column.notNull)).toBe(true);
    expect(config.columns.some((column) => column.name === 'legal_entity_id' && column.notNull)).toBe(true);
    expect(config.policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete']);
    for (const policy of config.policies) {
      expect(policy.to).toBe('ontos_runtime');
    }
  }
  /* jscpd:ignore-end */
});

it('matches the typed Action repository row contracts', () => {
  const requiredColumns = [
    [
      responsibilityAssignments,
      ['assignment_ref', 'scope_ref', 'role', 'assignment_record', 'effective_from', 'effective_to'],
    ],
    [
      applicabilityDecisions,
      ['decision_id', 'processing_scope_ref', 'operation', 'outcome', 'decision_record', 'evaluated_at'],
    ],
    [
      legalBasisAssignments,
      ['assignment_ref', 'processing_scope_ref', 'decision', 'assignment_record', 'effective_from', 'effective_to'],
    ],
    [eligibilityEvidence, ['evidence_id', 'processing_scope_ref', 'outcome', 'evidence_record', 'evaluated_at']],
    [
      retentionRules,
      ['rule_ref', 'rule_version', 'content_scope_ref', 'rule_record', 'effective_from', 'effective_to'],
    ],
    [retentionExceptions, ['exception_ref', 'exception_record', 'effective_from', 'effective_to', 'released_at']],
    [legalHolds, ['hold_ref', 'hold_record', 'effective_from', 'effective_to', 'released_at']],
    [
      dsrDeliveryAccess,
      ['access_id', 'delivery_output_ref', 'idempotency_key', 'access_record', 'expires_at', 'revoked_at'],
    ],
    [externalObligations, ['obligation_id', 'measure_id', 'revision', 'status', 'obligation_record', 'updated_at']],
  ] as const;

  for (const [table, businessColumns] of requiredColumns) {
    const config = getTableConfig(table);
    const actual = new Set(config.columns.map(({ name }) => name));
    for (const column of ['tenant_id', 'legal_entity_id', 'action_invocation_id', ...businessColumns]) {
      expect(actual.has(column), `${config.name}.${column}`).toBe(true);
    }
  }
});

it('declares exact owner-local uniqueness and idempotency keys', () => {
  const expectedKeys = new Map([
    [
      'applicability_decisions',
      ['privacy_applicability_decisions_invocation_uk', 'privacy_applicability_decisions_scope_id_uk'],
    ],
    [
      'dsr_delivery_access',
      [
        'privacy_dsr_delivery_access_current_uk',
        'privacy_dsr_delivery_access_idempotency_uk',
        'privacy_dsr_delivery_access_invocation_uk',
        'privacy_dsr_delivery_access_scope_id_uk',
      ],
    ],
    [
      'eligibility_evidence',
      ['privacy_eligibility_evidence_invocation_uk', 'privacy_eligibility_evidence_scope_id_uk'],
    ],
    [
      'external_obligations',
      ['privacy_external_obligations_invocation_uk', 'privacy_external_obligations_scope_id_uk'],
    ],
    [
      'legal_basis_assignments',
      ['privacy_legal_basis_assignments_invocation_uk', 'privacy_legal_basis_assignments_scope_id_uk'],
    ],
    ['legal_holds', ['privacy_legal_holds_invocation_uk', 'privacy_legal_holds_scope_id_uk']],
    [
      'responsibility_assignments',
      ['privacy_responsibility_assignments_invocation_uk', 'privacy_responsibility_assignments_scope_id_uk'],
    ],
    [
      'retention_exceptions',
      ['privacy_retention_exceptions_invocation_uk', 'privacy_retention_exceptions_scope_id_uk'],
    ],
    [
      'retention_rules',
      [
        'privacy_retention_rules_invocation_uk',
        'privacy_retention_rules_scope_id_uk',
        'privacy_retention_rules_version_uk',
      ],
    ],
  ]);

  for (const table of [
    applicabilityDecisions,
    dsrDeliveryAccess,
    eligibilityEvidence,
    externalObligations,
    legalBasisAssignments,
    legalHolds,
    responsibilityAssignments,
    retentionExceptions,
    retentionRules,
  ]) {
    const config = getTableConfig(table);
    const actual = [
      ...config.uniqueConstraints.map(({ name }) => name ?? ''),
      ...config.indexes.filter(({ config: value }) => value.unique).map(({ config: value }) => value.name ?? ''),
    ];
    expect(EffectArray.sort(actual, Order.String), config.name).toEqual(expectedKeys.get(config.name));
  }

  const currentAccess = getTableConfig(dsrDeliveryAccess).indexes.find(
    ({ config }) => config.name === 'privacy_dsr_delivery_access_current_uk',
  );
  expect(currentAccess?.config.unique).toBe(true);
  expect(currentAccess?.config.where).toBeDefined();
});

it('preserves only meaningful owner-local foreign keys', () => {
  const actual = EffectArray.sort(
    PRIVACY_TABLES.flatMap((table) =>
      getTableConfig(table).foreignKeys.map((foreignKey) => {
        const reference = foreignKey.reference();
        return {
          columns: reference.columns.map(({ name }) => name),
          foreignColumns: reference.foreignColumns.map(({ name }) => name),
          foreignTable: getTableConfig(reference.foreignTable).name,
          name: foreignKey.getName(),
        };
      }),
    ),
    foreignKeyOrder,
  );

  expect(actual).toEqual([
    {
      columns: ['tenant_id', 'legal_entity_id', 'processing_activity_id'],
      foreignColumns: ['tenant_id', 'legal_entity_id', 'processing_activity_id'],
      foreignTable: 'processing_activities',
      name: 'privacy_activity_lifecycle_activity_fk',
    },
    {
      columns: ['tenant_id', 'legal_entity_id', 'rule_ref', 'rule_version'],
      foreignColumns: ['tenant_id', 'legal_entity_id', 'rule_ref', 'rule_version'],
      foreignTable: 'retention_rules',
      name: 'privacy_disposition_rule_fk',
    },
    {
      columns: ['tenant_id', 'legal_entity_id', 'case_ref'],
      foreignColumns: ['tenant_id', 'legal_entity_id', 'case_ref'],
      foreignTable: 'dsr_cases',
      name: 'privacy_dsr_deadlines_case_fk',
    },
    {
      columns: ['tenant_id', 'legal_entity_id', 'access_id'],
      foreignColumns: ['tenant_id', 'legal_entity_id', 'access_id'],
      foreignTable: 'dsr_delivery_access',
      name: 'privacy_dsr_delivery_evidence_access_fk',
    },
    {
      columns: ['tenant_id', 'legal_entity_id', 'case_ref'],
      foreignColumns: ['tenant_id', 'legal_entity_id', 'case_ref'],
      foreignTable: 'dsr_cases',
      name: 'privacy_dsr_owner_tasks_case_fk',
    },
    {
      columns: ['tenant_id', 'legal_entity_id', 'case_ref'],
      foreignColumns: ['tenant_id', 'legal_entity_id', 'case_ref'],
      foreignTable: 'dsr_cases',
      name: 'privacy_dsr_resolver_assignments_case_fk',
    },
    {
      columns: ['tenant_id', 'legal_entity_id', 'case_ref'],
      foreignColumns: ['tenant_id', 'legal_entity_id', 'case_ref'],
      foreignTable: 'dsr_cases',
      name: 'privacy_dsr_responses_case_fk',
    },
    {
      columns: ['tenant_id', 'legal_entity_id', 'case_ref'],
      foreignColumns: ['tenant_id', 'legal_entity_id', 'case_ref'],
      foreignTable: 'dsr_cases',
      name: 'privacy_dsr_substantive_decisions_case_fk',
    },
    {
      columns: ['tenant_id', 'legal_entity_id', 'case_ref'],
      foreignColumns: ['tenant_id', 'legal_entity_id', 'case_ref'],
      foreignTable: 'dsr_cases',
      name: 'privacy_dsr_verifications_case_fk',
    },
    {
      columns: ['tenant_id', 'legal_entity_id', 'measure_id'],
      foreignColumns: ['tenant_id', 'legal_entity_id', 'measure_id'],
      foreignTable: 'privacy_measure_dispatches',
      name: 'privacy_external_obligations_measure_fk',
    },
    {
      columns: ['tenant_id', 'legal_entity_id', 'measure_id'],
      foreignColumns: ['tenant_id', 'legal_entity_id', 'measure_id'],
      foreignTable: 'privacy_measure_dispatches',
      name: 'privacy_owner_outcomes_measure_fk',
    },
    {
      columns: ['tenant_id', 'legal_entity_id', 'processing_purpose_id'],
      foreignColumns: ['tenant_id', 'legal_entity_id', 'processing_purpose_id'],
      foreignTable: 'processing_purposes',
      name: 'privacy_purpose_versions_purpose_fk',
    },
    {
      columns: ['tenant_id', 'legal_entity_id', 'rule_ref', 'rule_version'],
      foreignColumns: ['tenant_id', 'legal_entity_id', 'rule_ref', 'rule_version'],
      foreignTable: 'retention_rules',
      name: 'privacy_retention_work_rule_fk',
    },
  ]);
});

it('uses safe checks for versions, periods, decisions, outcomes, and current workflow state', () => {
  const expectedChecks = new Map([
    [
      'applicability_decisions',
      ['privacy_applicability_decisions_operation_ck', 'privacy_applicability_decisions_outcome_ck'],
    ],
    ['dsr_delivery_access', ['privacy_dsr_delivery_access_expiry_ck']],
    ['eligibility_evidence', ['privacy_eligibility_evidence_outcome_ck']],
    ['external_obligations', ['privacy_external_obligations_revision_ck', 'privacy_external_obligations_status_ck']],
    [
      'legal_basis_assignments',
      ['privacy_legal_basis_assignments_decision_ck', 'privacy_legal_basis_assignments_period_ck'],
    ],
    ['legal_holds', ['privacy_legal_holds_period_ck']],
    [
      'responsibility_assignments',
      ['privacy_responsibility_assignments_period_ck', 'privacy_responsibility_assignments_role_ck'],
    ],
    ['retention_exceptions', ['privacy_retention_exceptions_period_ck']],
    ['retention_rules', ['privacy_retention_rules_period_ck', 'privacy_retention_rules_version_ck']],
  ]);

  for (const table of [
    applicabilityDecisions,
    dsrDeliveryAccess,
    eligibilityEvidence,
    externalObligations,
    legalBasisAssignments,
    legalHolds,
    responsibilityAssignments,
    retentionExceptions,
    retentionRules,
  ]) {
    const config = getTableConfig(table);
    expect(
      EffectArray.sort(
        config.checks.map(({ name }) => name),
        Order.String,
      ),
      config.name,
    ).toEqual(expectedChecks.get(config.name));
  }

  const antiResurrection = getTableConfig(antiResurrectionProtections);
  expect(antiResurrection.columns.map(({ name }) => name)).not.toContain('active');
  expect(antiResurrection.checks.map(({ name }) => name)).toEqual(['privacy_anti_resurrection_measure_ck']);
});

it('retains existing identities and Action idempotency constraints', () => {
  expect(
    getTableConfig(processingActivities).columns.find(({ name }) => name === 'processing_activity_id')?.dataType,
  ).toBe('string');
  expect(getTableConfig(purposeVersions).uniqueConstraints.map(({ name }) => name)).toContain(
    'privacy_purpose_versions_invocation_uk',
  );
  expect(getTableConfig(noticeProvisions).uniqueConstraints.map(({ name }) => name)).toContain(
    'privacy_notice_provisions_invocation_uk',
  );
  expect(getTableConfig(consentDecisions).uniqueConstraints.map(({ name }) => name)).toContain(
    'privacy_consent_decisions_idempotency_uk',
  );
});

it('checks in non-destructive generated migrations with forced RLS and exact immutable guards', () => {
  const sql = migrationSql();
  for (const table of PRIVACY_TABLE_INVENTORY) {
    expect(sql).toContain(`ALTER TABLE "privacy"."${table}" FORCE ROW LEVEL SECURITY`);
    expect(sql).not.toContain(`DROP TABLE "privacy"."${table}"`);
  }
  const actualTriggers = EffectArray.sort(
    [...sql.matchAll(/CREATE TRIGGER "(?<name>privacy_[^"]+_immutable)"/gu)].map(({ groups }) => groups?.name ?? ''),
    Order.String,
  );
  expect(actualTriggers).toEqual(IMMUTABLE_TRIGGER_NAMES);
  for (const table of IMMUTABLE_TABLES) {
    expect(sql).toMatch(new RegExp(`REVOKE UPDATE, DELETE ON TABLE[\\s\\S]*?"privacy"\\."${table}"`, 'u'));
  }
  expect(sql).toContain('ALTER COLUMN "processing_activity_id" SET DATA TYPE text');
});
