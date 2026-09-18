// @effect-diagnostics asyncFunction:off globalConsole:off nodeBuiltinImport:off -- The operator-only PostgreSQL verifier adapts the driver's Promise API through Effect.tryPromise; expires: 2027-03-31.
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Array as EffectArray, Effect, Order, Schema } from 'effect';
import { Client } from 'pg';

import { PRIVACY_SCHEMA_NAME, PRIVACY_TABLE_INVENTORY, PRIVACY_TABLES } from '../src/database/schema.ts';

const EXPECTED_TABLES = EffectArray.sort(
  PRIVACY_TABLES.map((table) => getTableConfig(table).name),
  Order.String,
);

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
  'processing_activity_lifecycle_events',
  'processing_interventions',
  'purpose_versions',
  'privacy_representations',
  'responsibility_assignments',
  'retention_exceptions',
  'retention_rules',
] as const;

const IMMUTABLE_TABLE_SET = new Set<string>(IMMUTABLE_TABLES);

const EXPECTED_IMMUTABLE_TRIGGERS = [
  'anti_resurrection_protections:privacy_anti_resurrection_immutable',
  'applicability_decisions:privacy_applicability_decisions_immutable',
  'applicability_policies:privacy_applicability_policies_immutable',
  'consent_decisions:privacy_consent_decisions_immutable',
  'disposition_decisions:privacy_disposition_decisions_immutable',
  'dsr_deadlines:privacy_dsr_deadlines_immutable',
  'dsr_delivery_evidence:privacy_dsr_delivery_evidence_immutable',
  'dsr_resolver_assignments:privacy_dsr_resolver_assignments_immutable',
  'dsr_responses:privacy_dsr_responses_immutable',
  'dsr_substantive_decisions:privacy_dsr_substantive_decisions_immutable',
  'dsr_verifications:privacy_dsr_verifications_immutable',
  'eligibility_evidence:privacy_eligibility_evidence_immutable',
  'legal_basis_assignments:privacy_legal_basis_assignments_immutable',
  'legal_holds:privacy_legal_holds_immutable',
  'notice_provisions:privacy_notice_provisions_immutable',
  'notice_versions:privacy_notice_versions_immutable',
  'owner_contributions:privacy_owner_contributions_immutable',
  'owner_execution_outcomes:privacy_owner_execution_outcomes_immutable',
  'privacy_representations:privacy_representations_immutable',
  'processing_activity_lifecycle_events:privacy_processing_activity_lifecycle_immutable',
  'processing_interventions:privacy_processing_interventions_immutable',
  'purpose_versions:privacy_purpose_versions_immutable',
  'responsibility_assignments:privacy_responsibility_assignments_immutable',
  'retention_exceptions:privacy_retention_exceptions_immutable',
  'retention_rules:privacy_retention_rules_immutable',
] as const;

const EXPECTED_FOREIGN_KEYS = [
  'privacy_activity_lifecycle_activity_fk',
  'privacy_disposition_rule_fk',
  'privacy_dsr_deadlines_case_fk',
  'privacy_dsr_delivery_evidence_access_fk',
  'privacy_dsr_owner_tasks_case_fk',
  'privacy_dsr_resolver_assignments_case_fk',
  'privacy_dsr_responses_case_fk',
  'privacy_dsr_substantive_decisions_case_fk',
  'privacy_dsr_verifications_case_fk',
  'privacy_external_obligations_measure_fk',
  'privacy_owner_outcomes_measure_fk',
  'privacy_purpose_versions_purpose_fk',
  'privacy_retention_work_rule_fk',
] as const;

const EXPECTED_POLICIES = EffectArray.sort(
  PRIVACY_TABLES.flatMap((table) => {
    const config = getTableConfig(table);
    return config.policies.map((policy) => {
      const role = policy.to === 'ontos_runtime' ? policy.to : '__invalid_role__';
      return `${config.name}:${policy.name}:${policy.for}:${role}`;
    });
  }),
  Order.String,
);

class PrivacyDatabaseVerificationError extends Schema.TaggedError<PrivacyDatabaseVerificationError>()(
  'PrivacyDatabaseVerificationError',
  {
    reason: Schema.String,
  },
) {}

interface CatalogRow {
  readonly can_delete: boolean;
  readonly can_insert: boolean;
  readonly can_select: boolean;
  readonly can_update: boolean;
  readonly owner_name: string;
  readonly rls_enabled: boolean;
  readonly rls_forced: boolean;
  readonly table_name: string;
}

interface ForeignKeyRow {
  readonly constraint_name: string;
}

interface ConstraintRow {
  readonly constraint_definition: string;
  readonly constraint_name: string;
}

interface JournalRow {
  readonly journal_name: string;
}

interface RoutineRow {
  readonly function_definition: string;
}

interface PolicyRow {
  readonly command: string;
  readonly permissive: boolean;
  readonly policy_name: string;
  readonly roles: string;
  readonly table_name: string;
  readonly using_expression: string | null;
  readonly with_check_expression: string | null;
}

interface RoleRow {
  readonly runtime_bypass_rls: boolean;
  readonly runtime_create: boolean;
  readonly runtime_super: boolean;
  readonly runtime_usage: boolean;
}

interface TriggerRow {
  readonly table_name: string;
  readonly trigger_name: string;
}

const sameStrings = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.length === expected.length && actual.every((value, index) => value === expected[index]);

const failure = (reason: string, cause?: unknown) => {
  const error = new PrivacyDatabaseVerificationError({ reason });
  return cause === undefined ? error : Object.defineProperty(error, 'cause', { value: cause });
};

const scopedExpression = (expression: string | null): boolean =>
  expression?.includes("current_setting('ontos.tenant_id'") === true &&
  expression.includes("current_setting('ontos.legal_entity_id'");

const policyHasExactScope = (policy: PolicyRow): boolean => {
  if (!policy.permissive || policy.roles !== 'ontos_runtime') {
    return false;
  }
  if (policy.command === 'insert') {
    return policy.using_expression === null && scopedExpression(policy.with_check_expression);
  }
  if (policy.command === 'update') {
    return scopedExpression(policy.using_expression) && scopedExpression(policy.with_check_expression);
  }
  return scopedExpression(policy.using_expression) && policy.with_check_expression === null;
};

const verify = Effect.gen(function* verifyPrivacyDatabase() {
  if (!sameStrings(EXPECTED_TABLES, PRIVACY_TABLE_INVENTORY)) {
    yield* failure(
      `Typed Privacy inventory mismatch; refs=[${EXPECTED_TABLES.join(',')}], inventory=[${PRIVACY_TABLE_INVENTORY.join(',')}]`,
    );
  }

  const connections = yield* loadDatabaseConnectionPair();
  const client = new Client({
    connectionString: connections.admin.connectionString,
  });

  yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      catch: (cause) => failure('Unable to connect to PostgreSQL as the migration owner', cause),
      // oxlint-disable-next-line typescript/promise-function-async -- Effect.tryPromise owns the PostgreSQL Promise boundary.
      try: () => client.connect().then(() => client),
    }),
    (connected) =>
      // fallow-ignore-next-line complexity -- The verifier intentionally audits the complete Privacy schema, RLS, routine, trigger, and ownership contract in one connection lifecycle.
      Effect.gen(function* inspectPrivacyDatabase() {
        const catalog = yield* Effect.tryPromise({
          catch: (cause) => failure('Unable to inspect the Privacy table catalog', cause),
          // oxlint-disable-next-line typescript/promise-function-async -- Effect.tryPromise owns the PostgreSQL Promise boundary.
          try: () =>
            connected.query<CatalogRow>(
              `select relation.relname as table_name,
                      pg_catalog.pg_get_userbyid(relation.relowner) as owner_name,
                      relation.relrowsecurity as rls_enabled,
                      relation.relforcerowsecurity as rls_forced,
                      has_table_privilege('ontos_runtime', relation.oid, 'SELECT') as can_select,
                      has_table_privilege('ontos_runtime', relation.oid, 'INSERT') as can_insert,
                      has_table_privilege('ontos_runtime', relation.oid, 'UPDATE') as can_update,
                      has_table_privilege('ontos_runtime', relation.oid, 'DELETE') as can_delete
                 from pg_catalog.pg_class as relation
                 join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
                where namespace.nspname = $1 and relation.relkind in ('r', 'p')
                order by relation.relname`,
              [PRIVACY_SCHEMA_NAME],
            ),
        });
        const actualTables = catalog.rows.map(({ table_name }) => table_name);
        if (!sameStrings(actualTables, EXPECTED_TABLES)) {
          yield* failure(
            `Privacy table catalog mismatch; expected=[${EXPECTED_TABLES.join(',')}], actual=[${actualTables.join(',')}]`,
          );
        }
        const unsafeTables = catalog.rows.filter((table) => {
          const mutable = !IMMUTABLE_TABLE_SET.has(table.table_name);
          return (
            table.owner_name !== connections.admin.user ||
            !table.rls_enabled ||
            !table.rls_forced ||
            !table.can_select ||
            !table.can_insert ||
            table.can_update !== mutable ||
            table.can_delete !== mutable
          );
        });
        if (unsafeTables.length > 0) {
          yield* failure(
            `Privacy table ownership, RLS, or runtime privilege mismatch; tables=[${unsafeTables
              .map(({ table_name }) => table_name)
              .join(',')}]`,
          );
        }

        const policies = yield* Effect.tryPromise({
          catch: (cause) => failure('Unable to inspect Privacy RLS policies', cause),
          // oxlint-disable-next-line typescript/promise-function-async -- Effect.tryPromise owns the PostgreSQL Promise boundary.
          try: () =>
            connected.query<PolicyRow>(
              `select relation.relname as table_name,
                      policy.polname as policy_name,
                      case policy.polcmd
                        when 'r' then 'select'
                        when 'a' then 'insert'
                        when 'w' then 'update'
                        when 'd' then 'delete'
                        else policy.polcmd::text
                      end as command,
                      policy.polpermissive as permissive,
                      array_to_string(array(select role.rolname
                              from unnest(policy.polroles) as policy_role(role_oid)
                              join pg_catalog.pg_roles as role on role.oid = policy_role.role_oid
                             order by role.rolname), ',') as roles,
                      pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) as using_expression,
                      pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) as with_check_expression
                 from pg_catalog.pg_policy as policy
                 join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
                 join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
                where namespace.nspname = $1
                order by relation.relname, policy.polname`,
              [PRIVACY_SCHEMA_NAME],
            ),
        });
        const actualPolicies = EffectArray.sort(
          policies.rows.map(
            ({ command, policy_name, roles, table_name }) => `${table_name}:${policy_name}:${command}:${roles}`,
          ),
          Order.String,
        );
        if (
          !sameStrings(actualPolicies, EXPECTED_POLICIES) ||
          policies.rows.some((policy) => !policyHasExactScope(policy))
        ) {
          yield* failure(
            `Privacy RLS policy mismatch; expected=${EXPECTED_POLICIES.length}, actual=${actualPolicies.length}`,
          );
        }

        const triggers = yield* Effect.tryPromise({
          catch: (cause) => failure('Unable to inspect Privacy immutable triggers', cause),
          // oxlint-disable-next-line typescript/promise-function-async -- Effect.tryPromise owns the PostgreSQL Promise boundary.
          try: () =>
            connected.query<TriggerRow>(
              `select relation.relname as table_name, trigger_record.tgname as trigger_name
                 from pg_catalog.pg_trigger as trigger_record
                 join pg_catalog.pg_class as relation on relation.oid = trigger_record.tgrelid
                 join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
                where namespace.nspname = $1 and not trigger_record.tgisinternal
                order by relation.relname, trigger_record.tgname`,
              [PRIVACY_SCHEMA_NAME],
            ),
        });
        const actualTriggers = triggers.rows.map(({ table_name, trigger_name }) => `${table_name}:${trigger_name}`);
        if (!sameStrings(actualTriggers, EXPECTED_IMMUTABLE_TRIGGERS)) {
          yield* failure(
            `Privacy immutable trigger mismatch; expected=[${EXPECTED_IMMUTABLE_TRIGGERS.join(',')}], actual=[${actualTriggers.join(',')}]`,
          );
        }

        const foreignKeys = yield* Effect.tryPromise({
          catch: (cause) => failure('Unable to inspect Privacy foreign keys', cause),
          // oxlint-disable-next-line typescript/promise-function-async -- Effect.tryPromise owns the PostgreSQL Promise boundary.
          try: () =>
            connected.query<ForeignKeyRow>(
              `select constraint_record.conname as constraint_name
                 from pg_catalog.pg_constraint as constraint_record
                 join pg_catalog.pg_class as relation on relation.oid = constraint_record.conrelid
                 join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
                where namespace.nspname = $1 and constraint_record.contype = 'f'
                order by constraint_record.conname`,
              [PRIVACY_SCHEMA_NAME],
            ),
        });
        const actualForeignKeys = foreignKeys.rows.map(({ constraint_name }) => constraint_name);
        if (!sameStrings(actualForeignKeys, EXPECTED_FOREIGN_KEYS)) {
          yield* failure(
            `Privacy foreign-key mismatch; expected=${EXPECTED_FOREIGN_KEYS.length} [${EXPECTED_FOREIGN_KEYS.join(',')}], ` +
              `actual=${actualForeignKeys.length} [${actualForeignKeys.join(',')}]`,
          );
        }

        const dispositionConstraints = yield* Effect.tryPromise({
          catch: (cause) => failure('Unable to inspect the Privacy disposition outcome constraint', cause),
          // oxlint-disable-next-line typescript/promise-function-async -- Effect.tryPromise owns the PostgreSQL Promise boundary.
          try: () =>
            connected.query<ConstraintRow>(
              `select constraint_record.conname as constraint_name,
                      pg_catalog.pg_get_constraintdef(constraint_record.oid) as constraint_definition
                 from pg_catalog.pg_constraint as constraint_record
                 join pg_catalog.pg_class as relation on relation.oid = constraint_record.conrelid
                 join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
                where namespace.nspname = $1
                  and relation.relname = 'disposition_decisions'
                  and constraint_record.conname = 'privacy_disposition_decisions_outcome_ck'`,
              [PRIVACY_SCHEMA_NAME],
            ),
        });
        const dispositionConstraint = dispositionConstraints.rows.at(0);
        if (
          dispositionConstraint === undefined ||
          !['RETAIN', 'RESTRICT', 'ANONYMIZE', 'DELETE'].every((outcome) =>
            dispositionConstraint.constraint_definition.includes(outcome),
          ) ||
          dispositionConstraint.constraint_definition.includes('INDETERMINATE')
        ) {
          yield* failure('Privacy disposition decisions must persist determinate outcomes only');
        }

        const retentionRoutines = yield* Effect.tryPromise({
          catch: (cause) => failure('Unable to inspect the Privacy retention evaluation routine', cause),
          // oxlint-disable-next-line typescript/promise-function-async -- Effect.tryPromise owns the PostgreSQL Promise boundary.
          try: () =>
            connected.query<RoutineRow>(
              `select pg_catalog.pg_get_functiondef(function_record.oid) as function_definition
                 from pg_catalog.pg_proc as function_record
                 join pg_catalog.pg_namespace as namespace on namespace.oid = function_record.pronamespace
                where namespace.nspname = $1
                  and function_record.proname = 'process_retention_evaluation_work'
                  and function_record.pronargs = 5`,
              [PRIVACY_SCHEMA_NAME],
            ),
        });
        const retentionRoutine = retentionRoutines.rows.at(0)?.function_definition;
        const requiredEvaluationFields = [
          'evaluationRef',
          'outcome',
          'policyRef',
          'policyVersion',
          'controllerRef',
          'evidenceRefs',
          'provenanceRef',
          'blockerRefs',
        ];
        if (
          retentionRoutine === undefined ||
          requiredEvaluationFields.some((field) => !retentionRoutine.includes(`'${field}'`)) ||
          !retentionRoutine.includes('AUTHORITATIVE_EVALUATION_INCOMPLETE')
        ) {
          yield* failure('Privacy retention evaluation routine does not persist authoritative worker evidence');
        }

        const journals = yield* Effect.tryPromise({
          catch: (cause) => failure('Unable to inspect the Privacy migration journal', cause),
          // oxlint-disable-next-line typescript/promise-function-async -- Effect.tryPromise owns the PostgreSQL Promise boundary.
          try: () =>
            connected.query<JournalRow>(
              `select journal.relname as journal_name
                 from pg_catalog.pg_class as journal
                 join pg_catalog.pg_namespace as namespace on namespace.oid = journal.relnamespace
                where namespace.nspname = 'drizzle' and journal.relname = '__drizzle_migrations_privacy'
                  and journal.relkind in ('r', 'p')`,
            ),
        });
        if (
          !sameStrings(
            journals.rows.map(({ journal_name }) => journal_name),
            ['__drizzle_migrations_privacy'],
          )
        ) {
          yield* failure('Privacy must own exactly one __drizzle_migrations_privacy journal');
        }

        const roles = yield* Effect.tryPromise({
          catch: (cause) => failure('Unable to inspect Privacy database roles', cause),
          // oxlint-disable-next-line typescript/promise-function-async -- Effect.tryPromise owns the PostgreSQL Promise boundary.
          try: () =>
            connected.query<RoleRow>(
              `select has_schema_privilege('ontos_runtime', $1, 'USAGE') as runtime_usage,
                      has_schema_privilege('ontos_runtime', $1, 'CREATE') as runtime_create,
                      runtime.rolsuper as runtime_super,
                      runtime.rolbypassrls as runtime_bypass_rls
                 from pg_catalog.pg_roles as runtime
                where runtime.rolname = 'ontos_runtime'`,
              [PRIVACY_SCHEMA_NAME],
            ),
        });
        const [role] = roles.rows;
        if (
          role === undefined ||
          !role.runtime_usage ||
          role.runtime_create ||
          role.runtime_super ||
          role.runtime_bypass_rls
        ) {
          yield* failure('Privacy runtime role or schema privileges are unsafe');
        }
        yield* Effect.void;
      }),
    () =>
      Effect.tryPromise({
        catch: (cause) => failure('Unable to close the PostgreSQL verifier connection', cause),
        // oxlint-disable-next-line typescript/promise-function-async -- Effect.tryPromise owns the PostgreSQL Promise boundary.
        try: () => client.end(),
      }),
  );
});

await Effect.runPromise(verify);
process.stdout.write(
  `Verified ${EXPECTED_TABLES.length} governed tables, ${EXPECTED_FOREIGN_KEYS.length} foreign keys, and ${EXPECTED_IMMUTABLE_TRIGGERS.length} immutable ledgers in ${PRIVACY_SCHEMA_NAME}\n`,
);
