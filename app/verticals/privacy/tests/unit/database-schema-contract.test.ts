// @effect-diagnostics nodeBuiltinImport:off -- Migration contract reads checked-in generated SQL; expires: 2027-03-31.
import { expect, it } from 'effect-rstest';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { Array as EffectArray, Order } from 'effect';
import { readdirSync, readFileSync } from 'node:fs';

import {
  PRIVACY_SCHEMA_NAME,
  PRIVACY_TABLE_INVENTORY,
  PRIVACY_TABLES,
  PRIVACY_GOVERNED_TABLES,
  PRIVACY_INGRESS_TABLE_INVENTORY,
  PRIVACY_TENANT_SCOPED_TABLE_INVENTORY,
  gatewayAssertionRedemptions,
  preVerificationBindings,
  antiResurrectionProtections,
  applicabilityDecisions,
  consentDecisions,
  demoSourceProcessingPolicies,
  dsrDeliveryAccess,
  eligibilityEvidence,
  externalObligations,
  legalBasisAssignments,
  legalHolds,
  noticeAcknowledgements,
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

it('retains one immutable, scoped Consent Subject binding and guards native decision inserts', () => {
  expect(PRIVACY_TABLE_INVENTORY).toContain('consent_scope_bindings');
  const sql = migrationSql();
  expect(sql).toContain('privacy_consent_scope_bindings_immutable');
  expect(sql).toContain('privacy_consent_subject_binding_guard');
});

const IMMUTABLE_TRIGGER_NAMES = [
  'privacy_anti_resurrection_immutable',
  'privacy_applicability_decisions_immutable',
  'privacy_applicability_policies_immutable',
  'privacy_consent_decisions_immutable',
  'privacy_consent_scope_bindings_immutable',
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
  'privacy_notice_acknowledgements_immutable',
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
  'consent_scope_bindings',
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
  'notice_acknowledgements',
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
  expect(new Set(PRIVACY_TABLE_INVENTORY).size).toBe(PRIVACY_TABLE_INVENTORY.length);
  expect(qualifiedNames).toEqual(PRIVACY_TABLE_INVENTORY.map((name) => `privacy.${name}`));
});

it('enables tenant and legal-entity RLS on every governed Privacy table', () => {
  /* jscpd:ignore-start -- Every owner schema must independently prove the same mandatory tenant and Legal Entity RLS contract. */
  // fallow-ignore-next-line code-duplication -- Mandatory owner-local RLS acceptance loop mirrors the repository contract by design.
  const tenantScoped = new Set<string>(PRIVACY_TENANT_SCOPED_TABLE_INVENTORY);
  for (const table of PRIVACY_GOVERNED_TABLES) {
    const config = getTableConfig(table);
    expect(config.enableRLS, `${config.name} must enable RLS`).toBe(true);
    expect(config.columns.some((column) => column.name === 'tenant_id' && column.notNull)).toBe(true);
    // a Tenant-scoped table keeps the column but leaves it optional; its RLS is proven exact in the next test
    expect(config.columns.some((column) => column.name === 'legal_entity_id' && column.notNull)).toBe(
      !tenantScoped.has(config.name),
    );
    expect(
      config.policies.map((policy) => policy.for),
      config.name,
    ).toEqual(table === demoSourceProcessingPolicies ? ['select'] : ['select', 'insert', 'update', 'delete']);
    for (const policy of config.policies) {
      expect(policy.to).toBe('ontos_runtime');
    }
  }
  /* jscpd:ignore-end */

  const readOnlyPolicy = getTableConfig(demoSourceProcessingPolicies);
  expect(
    readOnlyPolicy.columns.map((column) => ({
      name: column.name,
      notNull: column.notNull,
      type: column.getSQLType(),
    })),
  ).toEqual([
    { name: 'legal_entity_id', notNull: true, type: 'uuid' },
    { name: 'tenant_id', notNull: true, type: 'uuid' },
    { name: 'policy_id', notNull: true, type: 'text' },
    { name: 'policy_record', notNull: true, type: 'jsonb' },
    { name: 'recorded_at', notNull: true, type: 'timestamp with time zone' },
    { name: 'recorded_by', notNull: true, type: 'text' },
  ]);
  expect(readOnlyPolicy.primaryKeys.map(({ columns }) => columns.map(({ name }) => name))).toEqual([
    ['tenant_id', 'legal_entity_id', 'policy_id'],
  ]);
  const [select] = readOnlyPolicy.policies;
  expect(select?.name).toBe('privacy_demo_source_processing_policies_select');
  expect(select?.withCheck).toBeUndefined();
  if (select?.using === undefined) {
    expect.unreachable('The administrator-owned policy must restrict runtime reads to the installed scope');
  }
  expect(new PgDialect().sqlToQuery(select.using).sql.replaceAll(/\s+/gu, ' ')).toBe(
    `"privacy"."demo_source_processing_policies"."tenant_id"=nullif(current_setting('ontos.tenant_id',true),'')::uuid ` +
      `and "privacy"."demo_source_processing_policies"."legal_entity_id"=nullif(current_setting('ontos.legal_entity_id',true),'')::uuid`,
  );
});

it('scopes a Tenant-scoped table to the exact, possibly absent, Legal Entity of the operation', () => {
  const governed = new Set(PRIVACY_GOVERNED_TABLES.map((table) => getTableConfig(table).name));
  for (const name of PRIVACY_TENANT_SCOPED_TABLE_INVENTORY) {
    expect(governed.has(name), `${name} must be a governed table`).toBe(true);
  }
  const config = getTableConfig(preVerificationBindings);
  expect(config.columns.some((column) => column.name === 'legal_entity_id' && !column.notNull)).toBe(true);
  for (const policy of config.policies) {
    const predicate = [policy.using, policy.withCheck].filter((expression) => expression !== undefined);
    expect(predicate.length).toBeGreaterThan(0);
  }
});

it('keeps pre-tenant redemption evidence separate from governed personal records', () => {
  const config = getTableConfig(gatewayAssertionRedemptions);
  expect(PRIVACY_INGRESS_TABLE_INVENTORY).toEqual(['gateway_assertion_redemptions']);
  expect(config.enableRLS).toBe(false);
  expect(
    EffectArray.sort(
      config.columns.map(({ name }) => name),
      Order.String,
    ),
  ).toEqual(['audience', 'expires_at', 'issuer', 'jti', 'redeemed_at']);
  expect(config.uniqueConstraints.map(({ columns }) => columns.map(({ name }) => name))).toEqual([
    ['issuer', 'audience', 'jti'],
  ]);
  expect(config.checks.map(({ name }) => name)).toContain('privacy_gateway_redemptions_audience_ck');
  expect(migrationSql()).toContain('GRANT SELECT, INSERT, DELETE ON TABLE "privacy"."gateway_assertion_redemptions"');
  expect(migrationSql()).not.toContain('DROP TABLE "privacy"."gateway_assertion_redemptions"');
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

it('keeps durable disposition decisions determinate and retention worker evidence authoritative', () => {
  const migrations = migrationSql();
  const followupMigration = readFileSync(
    new URL('../../drizzle/20260915071434_unusual_colleen_wing/migration.sql', import.meta.url),
    'utf-8',
  );
  const retentionAuditMigration = readFileSync(
    new URL('../../drizzle/20260915083027_confused_blazing_skull/migration.sql', import.meta.url),
    'utf-8',
  );
  expect(migrations).toContain(`CHECK ("outcome" in ('RETAIN', 'RESTRICT', 'ANONYMIZE', 'DELETE'))`);
  expect(followupMigration).toContain("'evaluationRef', v_work.work_ref");
  expect(followupMigration).toContain("'policyRef', v_policy_ref");
  expect(followupMigration).toContain("'policyVersion', v_policy_version");
  expect(followupMigration).toContain("'controllerRef', v_controller_ref");
  expect(followupMigration).toContain("'evidenceRefs', to_jsonb(v_evidence_refs)");
  expect(followupMigration).toContain("'provenanceRef', v_provenance_ref");
  expect(followupMigration).toContain("'blockerRefs', to_jsonb(v_blocker_refs)");
  expect(followupMigration).toContain('AUTHORITATIVE_EVALUATION_INCOMPLETE');
  expect(followupMigration).not.toContain(
    `privacy_disposition_decisions_outcome_ck" CHECK ("outcome" in ('RETAIN', 'RESTRICT', 'ANONYMIZE', 'DELETE', 'INDETERMINATE'))`,
  );
  expect(retentionAuditMigration).toContain('v_authoritative_due_at := v_business_start_at + make_interval');
  expect(retentionAuditMigration).toContain("v_reason := 'AUTHORITATIVE_DUE_AT_MISMATCH'");
  expect(retentionAuditMigration).toContain(
    "decision.outcome IS DISTINCT FROM v_current_rule.rule_record->>'dispositionOutcome'",
  );
  expect(retentionAuditMigration).toContain(`("hold_record"->>'releasedAt')::timestamptz = "released_at"`);
  expect(retentionAuditMigration).toContain(`("exception_record"->>'releasedAt')::timestamptz = "released_at"`);
  expect(retentionAuditMigration).not.toContain('required_consent_dimensions');
});

it('keeps anti-resurrection measure support aligned with the domain contract', () => {
  const migration = readFileSync(
    new URL('../../drizzle/20260915123636_mature_triton/migration.sql', import.meta.url),
    'utf-8',
  );

  expect(migration).toContain('DROP CONSTRAINT "privacy_anti_resurrection_measure_ck"');
  expect(migration).toContain(`CHECK ("measure" in ('RESTRICT', 'DELETE', 'ANONYMIZE'))`);
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
      columns: ['tenant_id', 'legal_entity_id', 'privacy_subject_id'],
      foreignColumns: ['tenant_id', 'legal_entity_id', 'privacy_subject_id'],
      foreignTable: 'privacy_subjects',
      name: 'privacy_consent_scope_bindings_subject_fk',
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
      columns: ['tenant_id', 'legal_entity_id', 'notice_version_id'],
      foreignColumns: ['tenant_id', 'legal_entity_id', 'notice_version_id'],
      foreignTable: 'notice_versions',
      name: 'privacy_notice_ack_notice_fk',
    },
    {
      columns: ['tenant_id', 'legal_entity_id', 'privacy_subject_id'],
      foreignColumns: ['tenant_id', 'legal_entity_id', 'privacy_subject_id'],
      foreignTable: 'privacy_subjects',
      name: 'privacy_notice_ack_subject_fk',
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
    ['legal_holds', ['privacy_legal_holds_governance_ck', 'privacy_legal_holds_period_ck']],
    [
      'responsibility_assignments',
      ['privacy_responsibility_assignments_period_ck', 'privacy_responsibility_assignments_role_ck'],
    ],
    ['retention_exceptions', ['privacy_retention_exceptions_governance_ck', 'privacy_retention_exceptions_period_ck']],
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

const privacyTablePattern = (table: string) => `(?:"privacy"|privacy)\\.(?:"${table}"|${table})(?=\\s|[,;])`;
const sqlIdentifier = String.raw`(?:"(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)`;
const sqlTableTarget = `${sqlIdentifier}(?:\\s*\\.\\s*${sqlIdentifier})?`;
const unquoteIdentifier = (identifier: string) =>
  identifier.startsWith('"') ? identifier.slice(1, -1).replaceAll('""', '"') : identifier.toLowerCase();
const quotedSqlEnd = (
  sql: string,
  start: number,
): { end: number; kind: 'closed' } | { kind: 'unterminated' } | undefined => {
  const quote = sql[start];
  if (quote === "'" || quote === '"') {
    const backslashEscapes =
      quote === "'" && /[eE]/u.test(sql[start - 1] ?? '') && !/[\p{L}\p{N}_$]/u.test(sql[start - 2] ?? '');
    let index = start + 1;
    while (index < sql.length) {
      if (backslashEscapes && sql[index] === '\\') {
        index += 2;
      } else if (sql[index] !== quote) {
        index += 1;
      } else if (sql[index + 1] === quote) {
        index += 2;
      } else {
        return { end: index + 1, kind: 'closed' };
      }
    }
    return { kind: 'unterminated' };
  }
  return undefined;
};
interface ScannedSql {
  quotedRanges: { end: number; start: number }[];
  text: string;
}
const stripSqlComments = (sql: string): ScannedSql | null => {
  let text = '';
  const quotedRanges: { end: number; start: number }[] = [];
  let index = 0;
  while (index < sql.length) {
    if (sql.startsWith('--', index)) {
      const end = sql.slice(index + 2).search(/[\r\n]/u);
      index = end === -1 ? sql.length : index + 2 + end;
      text += ' ';
    } else if (sql.startsWith('/*', index)) {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql.startsWith('/*', index)) {
          depth += 1;
          index += 2;
        } else if (sql.startsWith('*/', index)) {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      if (depth > 0) {
        return null;
      }
      text += ' ';
    } else {
      const dollarQuote =
        sql[index] === '$' && !/[\p{L}\p{N}_$]/u.test(sql[index - 1] ?? '')
          ? /^\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/u.exec(sql.slice(index))?.[0]
          : undefined;
      if (dollarQuote !== undefined) {
        const bodyStart = index + dollarQuote.length;
        const bodyEnd = sql.indexOf(dollarQuote, bodyStart);
        if (bodyEnd === -1) {
          return null;
        }
        const body = stripSqlComments(sql.slice(bodyStart, bodyEnd));
        if (body === null) {
          return null;
        }
        const offset = text.length + 1;
        for (const { end, start } of body.quotedRanges) {
          quotedRanges.push({ end: end + offset, start: start + offset });
        }
        text += ` ${body.text} `;
        index = bodyEnd + dollarQuote.length;
        continue;
      }
      const start = index;
      const quotedEnd = quotedSqlEnd(sql, index);
      if (quotedEnd === undefined) {
        index += 1;
      } else if (quotedEnd.kind === 'unterminated') {
        return null;
      } else {
        index = quotedEnd.end;
        quotedRanges.push({ end: text.length + index - start, start: text.length });
      }
      text += sql.slice(start, index);
    }
  }
  return { quotedRanges, text };
};
const privacyTableDrops = (sql: string, table: string): readonly string[] => {
  const { quotedRanges, text } = stripSqlComments(sql) ?? { quotedRanges: [], text: sql };
  const dropStatement = new RegExp(
    `\\bDROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?<targets>${sqlTableTarget}(?:\\s*,\\s*${sqlTableTarget})*)\\s*(?:CASCADE|RESTRICT)?\\s*(?:;|$)`,
    'giu',
  );
  const targetPattern = new RegExp(`(?:(?<schema>${sqlIdentifier})\\s*\\.\\s*)?(?<table>${sqlIdentifier})`, 'giu');
  return [...text.matchAll(dropStatement)]
    .filter(({ index }) => !quotedRanges.some(({ end, start }) => index >= start && index < end))
    .filter(({ groups }) =>
      [...(groups?.targets ?? '').matchAll(targetPattern)].some(({ groups: target }) => {
        const schemaName = target?.schema;
        const tableName = target?.table;
        return (
          (schemaName === undefined || unquoteIdentifier(schemaName) === 'privacy') &&
          tableName !== undefined &&
          unquoteIdentifier(tableName) === table
        );
      }),
    )
    .map(([statement]) => statement);
};

// This guard deliberately fails closed: raw-text matches remain destructive even inside comments or literals.
const headPrivacyTableDrop = (sql: string, table: string) => sql.includes(`DROP TABLE "privacy"."${table}"`);
const isDestructiveMigration = (sql: string, table: string) =>
  headPrivacyTableDrop(sql, table) ||
  new RegExp(`\\bDROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${privacyTablePattern(table)}`, 'iu').test(sql) ||
  privacyTableDrops(sql, table).length > 0;

const targetListDrops = [
  'DROP TABLE "privacy"."protected","privacy"."other";',
  'DROP TABLE IF EXISTS privacy.protected, privacy.other;',
  'DROP TABLE privacy.other, privacy.protected;',
  'DROP TABLE privacy.other, privacy.protected, privacy.last CASCADE;',
  'DROP TABLE IF EXISTS privacy.other, privacy.middle, privacy.protected RESTRICT;',
  'DROP TABLE "privacy"."other","privacy"."protected";',
  'DROP TABLE IF EXISTS "privacy"."other", "privacy"."protected", "privacy"."last" RESTRICT;',
  'DROP TABLE "privacy"."other", "privacy"."middle", "privacy"."protected" CASCADE;',
  'DROP TABLE other, protected, last;',
  'DROP TABLE IF EXISTS "other", "middle", "protected";',
  'DROP TABLE other_schema.other, "privacy" . protected, last;',
  'DROP TABLE "privacy"."other,with,commas", "privacy"."protected";',
  'DROP TABLE "privacy"."other;with;semicolons", "privacy"."protected";',
  'DROP TABLE PRIVACY.OTHER, PRIVACY.PROTECTED;',
];
const commentedDrops = [
  'DROP TABLE privacy.other, /* retiring both */ privacy.protected;',
  'DROP TABLE privacy.other,\n-- retiring both\nprivacy.protected;',
  'DROP TABLE privacy.other,\r-- retiring both\rprivacy.protected;',
  'DROP TABLE privacy.other, /* retiring /* both */ tables */ privacy.protected;',
  'DROP/* retiring tables */TABLE privacy.other, privacy.protected;',
  'DROP TABLE "privacy"."other--table", "privacy"."protected";',
  'DROP TABLE "privacy"."other/*table*/", "privacy"."protected";',
  'DROP TABLE "privacy"."other""/*table*/", "privacy"."protected";',
];
const embeddedDrops = [
  "SELECT 'DROP TABLE privacy.protected;';",
  "SELECT 'it''s /* not a comment */; DROP TABLE privacy.protected;';",
  String.raw`SELECT E'it\'s retired; DROP TABLE privacy.protected;';`,
  String.raw`SELECT e'it''s retired; DROP TABLE privacy.protected;';`,
  String.raw`SELECT U&'d\0061t\+000061; DROP TABLE privacy.protected;';`,
  'SELECT $$/* not a comment */; DROP TABLE privacy.protected;$$;',
  'SELECT $body$-- not a comment\nDROP TABLE privacy.protected;$body$;',
  "SELECT $body$it's retired; DROP TABLE privacy.protected;$body$;",
  'SELECT "DROP TABLE privacy.protected;";',
  '-- DROP TABLE privacy.protected;',
  '/* DROP TABLE privacy.protected; */',
  '/* outer /* nested */ DROP TABLE privacy.protected; */',
  `SELECT 'DROP TABLE "privacy"."protected";';`,
  '-- DROP TABLE "privacy"."protected";',
  '/* DROP TABLE "privacy"."protected"; */',
];
const stringPrefixes = [
  String.raw`SELECT E'it\'s retired';`,
  String.raw`SELECT e'a\\';`,
  String.raw`SELECT U&'d\0061t\+000061';`,
  "SELECT $body$it's retired$body$;",
];
const unterminatedPrefixes = [
  "SELECT 'unterminated",
  String.raw`SELECT E'it\'s unterminated`,
  String.raw`SELECT e'a\\`,
  String.raw`SELECT U&'d\0061t\+000061`,
  'SELECT "unterminated',
  'SELECT $$unterminated',
  'SELECT $body$unterminated',
  '/* unterminated',
  '/* outer /* inner */ unterminated',
];
const directDrop = 'DROP TABLE privacy.protected;';
const mixedDrops = `DROP TABLE privacy.unprotected;\n${targetListDrops[2]}\nDROP TABLE other_schema.protected;`;
const prefixedDrops = [...embeddedDrops, ...stringPrefixes, ...unterminatedPrefixes].map(
  (prefix) => `${prefix}\n${directDrop}`,
);
const unterminatedCommentDrops = unterminatedPrefixes.map((prefix) => `/* ${directDrop} */\n${prefix}`);
const executableBodyDrops = [
  { sql: 'DO $$ BEGIN DROP TABLE "privacy"."legal_holds"; END $$;', table: 'legal_holds' },
  {
    sql: 'CREATE FUNCTION retire() RETURNS void AS $body$ BEGIN DROP TABLE privacy.other, "privacy"."legal_holds"; END $body$ LANGUAGE plpgsql;',
    table: 'legal_holds',
  },
  {
    sql: 'DO $outer$ BEGIN DO $inner$ BEGIN DROP TABLE privacy.other, /* retiring */ "privacy"."legal_holds"; END $inner$; END $outer$;',
    table: 'legal_holds',
  },
];
const destructiveMigrationSamples = [
  ...[
    ...targetListDrops,
    ...commentedDrops,
    ...embeddedDrops,
    ...prefixedDrops,
    ...unterminatedCommentDrops,
    mixedDrops,
    directDrop,
  ].map((sql) => ({ sql, table: 'protected' })),
  ...executableBodyDrops,
];

it('rejects destructive migrations with comma-delimited protected targets', () => {
  for (const statement of targetListDrops) {
    expect(privacyTableDrops(statement, 'protected'), statement).toEqual([statement]);
  }
  for (const statement of [
    'DROP TABLE "privacy"."protected_suffix";',
    'DROP TABLE privacy.other, other_schema.protected;',
    'DROP TABLE "privacy"."Protected";',
    'DROP TABLE "Privacy"."protected";',
    'DROP TABLE "privacy"."other, privacy.protected";',
  ]) {
    expect(privacyTableDrops(statement, 'protected'), statement).toEqual([]);
  }
  expect(privacyTableDrops(mixedDrops, 'protected')).toEqual([targetListDrops[2]]);
});

it('rejects destructive migrations with comments between protected targets', () => {
  for (const statement of commentedDrops) {
    expect(privacyTableDrops(statement, 'protected'), statement).toHaveLength(1);
  }
});

it('fails closed for destructive SQL inside comments, literals, and quoted identifiers', () => {
  for (const statement of embeddedDrops) {
    expect(isDestructiveMigration(statement, 'protected'), statement).toBe(true);
    expect(isDestructiveMigration(`${statement}\n${directDrop}`, 'protected'), statement).toBe(true);
  }
  const escapedString = String.raw`SELECT e'a\\';`;
  expect(isDestructiveMigration(escapedString, 'protected')).toBe(false);
  expect(privacyTableDrops(`${escapedString}\n${directDrop}`, 'protected')).toEqual([directDrop]);
});

it('rejects protected drops after PostgreSQL escaped and Unicode strings', () => {
  for (const statement of stringPrefixes) {
    expect(privacyTableDrops(`${statement}\n${directDrop}`, 'protected'), statement).toEqual([directDrop]);
  }
});

it('checks the original migration text when SQL quoting or block comments are unterminated', () => {
  for (const prefix of unterminatedPrefixes) {
    expect(privacyTableDrops(`${prefix}\n${directDrop}`, 'protected'), prefix).toEqual([directDrop]);
    expect(privacyTableDrops(`/* ${directDrop} */\n${prefix}`, 'protected'), prefix).toEqual([directDrop]);
  }
});

it('scans executable dollar-quoted bodies recursively for protected drops', () => {
  for (const { sql, table } of executableBodyDrops) {
    expect(privacyTableDrops(sql, table), sql).toHaveLength(1);
    expect(isDestructiveMigration(sql, table), sql).toBe(true);
  }
});

it.each(destructiveMigrationSamples)('never weakens the HEAD matcher for $sql', ({ sql, table }) => {
  expect(!headPrivacyTableDrop(sql, table) || isDestructiveMigration(sql, table)).toBe(true);
  expect(isDestructiveMigration(sql, table)).toBe(true);
});

it('checks in non-destructive generated migrations with forced RLS and exact immutable guards', () => {
  const sql = migrationSql();
  for (const table of PRIVACY_TABLE_INVENTORY.filter(
    (name) => !new Set<string>(PRIVACY_INGRESS_TABLE_INVENTORY).has(name),
  )) {
    const qualifiedTable = privacyTablePattern(table);
    expect(sql).toMatch(
      new RegExp(`ALTER\\s+TABLE\\s+${qualifiedTable}\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY\\b`, 'iu'),
    );
    expect(sql).not.toContain(`DROP TABLE "privacy"."${table}"`);
    expect(isDestructiveMigration(sql, table)).toBe(false);
  }
  const policyPrivileges = [...sql.matchAll(/^[ \t]*(?:GRANT|REVOKE)\b[^;]+;/gimu)]
    .map(([statement]) => statement.replaceAll('"', '').replaceAll(/\s+/gu, ' ').trim())
    .filter((statement) => /\bON (?:TABLE )?privacy\.demo_source_processing_policies\b/iu.test(statement));
  expect(policyPrivileges).toEqual([
    'REVOKE ALL ON privacy.demo_source_processing_policies FROM PUBLIC, ontos_runtime;',
    'GRANT SELECT ON privacy.demo_source_processing_policies TO ontos_runtime;',
  ]);
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

it('keeps pre-authentication assertion replay identities global and separate from business RLS', () => {
  const config = getTableConfig(gatewayAssertionRedemptions);
  expect(config.schema).toBe(PRIVACY_SCHEMA_NAME);
  expect(config.name).toBe('gateway_assertion_redemptions');
  expect(config.enableRLS).toBe(false);
  expect(config.policies).toEqual([]);
  expect(config.primaryKeys).toEqual([]);
  expect(config.columns.map(({ name, notNull }) => ({ name, notNull }))).toEqual([
    { name: 'audience', notNull: true },
    { name: 'expires_at', notNull: true },
    { name: 'issuer', notNull: true },
    { name: 'jti', notNull: true },
    { name: 'redeemed_at', notNull: true },
  ]);
  expect(config.columns.find(({ name }) => name === 'jti')?.getSQLType()).toBe('uuid');
  expect(
    config.uniqueConstraints.map(({ columns, name }) => ({ columns: columns.map((column) => column.name), name })),
  ).toEqual([{ columns: ['issuer', 'audience', 'jti'], name: 'privacy_gateway_redemptions_identity_uk' }]);
  expect(config.indexes.map(({ config: index }) => index.name)).toEqual(['privacy_gateway_redemptions_expiry_idx']);
  const sql = migrationSql();
  expect(sql).toContain('privacy_gateway_redemptions_identity_uk');
  expect(sql).toContain('privacy_gateway_redemptions_expiry_idx');
  // The owner migration's final word on the replay ledger: no PUBLIC access, runtime select/insert/delete only.
  expect(sql).toMatch(
    /REVOKE ALL ON TABLE "privacy"\."gateway_assertion_redemptions" FROM PUBLIC, ontos_runtime;[\s\S]*GRANT SELECT, INSERT, DELETE ON TABLE "privacy"\."gateway_assertion_redemptions" TO ontos_runtime/u,
  );
});

it('retains one immutable acknowledgement per scoped presentation and invocation with opaque owner profile IDs', () => {
  const config = getTableConfig(noticeAcknowledgements);
  expect(
    EffectArray.sort(
      config.uniqueConstraints.map(({ name }) => name ?? ''),
      Order.String,
    ),
  ).toEqual([
    'privacy_notice_ack_invocation_uk',
    'privacy_notice_ack_presentation_uk',
    'privacy_notice_ack_scope_id_uk',
  ]);
  expect(config.columns.find(({ name }) => name === 'retail_profile_id')?.getSQLType()).toBe('text');
  expect(
    EffectArray.sort(
      config.checks.map(({ name }) => name),
      Order.String,
    ),
  ).toEqual([
    'privacy_notice_ack_period_ck',
    'privacy_notice_ack_record_binding_ck',
    'privacy_notice_ack_session_digest_ck',
  ]);
});
