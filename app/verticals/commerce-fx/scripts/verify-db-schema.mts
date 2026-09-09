// @effect-diagnostics asyncFunction:off globalConsole:off nodeBuiltinImport:off -- Operator-only verifier adapts the PostgreSQL driver; expires: 2027-03-31.
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { Client } from 'pg';
import { compareCommerceFxCatalog } from '../src/database/catalog.ts';
import { COMMERCE_FX_SCHEMA_NAME, COMMERCE_FX_TABLES } from '../src/database/schema.ts';

class CommerceFxSchemaVerificationError extends Schema.TaggedError<CommerceFxSchemaVerificationError>()(
  'CommerceFxSchemaVerificationError',
  { reason: Schema.String },
) {}

interface VerificationRow {
  readonly append_only_trigger_count: number;
  readonly force_rls_count: number;
  readonly foreign_key_count: number;
  readonly identity_trigger_count: number;
  readonly journal_count: number;
  readonly policy_count: number;
  readonly private_routine_executable: boolean;
  readonly public_routine_execute_count: number;
  readonly raw_runtime_privilege_count: number;
  readonly runtime_bypass_rls: boolean;
  readonly runtime_create: boolean;
  readonly runtime_super: boolean;
  readonly runtime_usage: boolean;
  readonly unsafe_routine_count: number;
  readonly wrong_owner_count: number;
}

interface ColumnFingerprintRow {
  readonly column_name: string;
  readonly data_type: string;
  readonly not_null: boolean;
}

interface ConstraintFingerprintRow {
  readonly fingerprint: string;
}

interface PolicyFingerprintRow {
  readonly command: string;
  readonly permissive: boolean;
  readonly policy_name: string;
  readonly qual: string | null;
  readonly role: string;
  readonly table_name: string;
  readonly with_check: string | null;
}

interface RoutineFingerprintRow {
  readonly direct_runtime_execute: boolean;
  readonly language: string;
  readonly owner: string;
  readonly public_execute: boolean;
  readonly result_contract: string;
  readonly return_type: string;
  readonly returns_set: boolean;
  readonly runtime_execute: boolean;
  readonly search_path: readonly string[] | null;
  readonly security_definer: boolean;
  readonly signature: string;
}

interface TriggerFingerprintRow {
  readonly enabled: string;
  readonly function_signature: string;
  readonly table_name: string;
  readonly trigger_name: string;
  readonly trigger_type: number;
}

const SCOPE_POLICY_EXPRESSION =
  "((tenant_id = (NULLIF(current_setting('ontos.tenant_id'::text, true), ''::text))::uuid) AND (legal_entity_id = (NULLIF(current_setting('ontos.legal_entity_id'::text, true), ''::text))::uuid))";

const EXPECTED_ARITHMETIC_COLUMN_FINGERPRINTS: readonly ColumnFingerprintRow[] = [
  { column_name: 'arithmetic_version', data_type: 'text', not_null: false },
  { column_name: 'rounding_increment', data_type: 'text', not_null: false },
  { column_name: 'rounding_rule_revision', data_type: 'text', not_null: false },
];

// This normalized pg_get_expr fingerprint locks the complete SET/WITHDRAW constraint. In
// particular, SET requires arithmetic v1, a positive exact increment whose scale fits the target
// minor units, and a bounded rule revision; WITHDRAW requires every arithmetic field to be null.
const EXPECTED_SET_WITHDRAW_CHECK_FINGERPRINT = '0a7e00bc4f8e9342371b614bcf94459d';

const POLICY_TARGETS = [
  { prefix: 'commerce_fx_manual_heads_scope', tableName: 'manual_rate_policy_heads' },
  {
    prefix: 'commerce_fx_manual_journal_scope',
    tableName: 'manual_rate_policy_mutation_journal',
  },
  { prefix: 'commerce_fx_manual_revisions_scope', tableName: 'manual_rate_policy_revisions' },
] as const;

const EXPECTED_POLICY_FINGERPRINTS: readonly PolicyFingerprintRow[] = POLICY_TARGETS.flatMap(
  ({ prefix, tableName }) => [
    {
      command: 'd',
      permissive: true,
      policy_name: `${prefix}_delete`,
      qual: SCOPE_POLICY_EXPRESSION,
      role: 'ontos_runtime',
      table_name: tableName,
      with_check: null,
    },
    {
      command: 'a',
      permissive: true,
      policy_name: `${prefix}_insert`,
      qual: null,
      role: 'ontos_runtime',
      table_name: tableName,
      with_check: SCOPE_POLICY_EXPRESSION,
    },
    {
      command: '*',
      permissive: true,
      policy_name: `${prefix}_owner_routine`,
      qual: SCOPE_POLICY_EXPRESSION,
      role: 'public',
      table_name: tableName,
      with_check: SCOPE_POLICY_EXPRESSION,
    },
    {
      command: 'r',
      permissive: true,
      policy_name: `${prefix}_select`,
      qual: SCOPE_POLICY_EXPRESSION,
      role: 'ontos_runtime',
      table_name: tableName,
      with_check: null,
    },
    {
      command: 'w',
      permissive: true,
      policy_name: `${prefix}_update`,
      qual: SCOPE_POLICY_EXPRESSION,
      role: 'ontos_runtime',
      table_name: tableName,
      with_check: SCOPE_POLICY_EXPRESSION,
    },
  ],
);

const EXPECTED_TRIGGER_FINGERPRINTS: readonly TriggerFingerprintRow[] = [
  {
    enabled: 'O',
    function_signature: 'commerce_fx.reject_manual_rate_policy_head_identity_change()',
    table_name: 'manual_rate_policy_heads',
    trigger_name: 'commerce_fx_manual_head_identity_immutable',
    trigger_type: 19,
  },
  {
    enabled: 'O',
    function_signature: 'commerce_fx.reject_manual_rate_policy_append_only_change()',
    table_name: 'manual_rate_policy_mutation_journal',
    trigger_name: 'commerce_fx_manual_journal_append_only',
    trigger_type: 27,
  },
  {
    enabled: 'O',
    function_signature: 'commerce_fx.reject_manual_rate_policy_append_only_change()',
    table_name: 'manual_rate_policy_revisions',
    trigger_name: 'commerce_fx_manual_revisions_append_only',
    trigger_type: 27,
  },
];

const RUNTIME_RESULT_CONTRACT = 'TABLE(payload jsonb)';
const SECURE_SEARCH_PATH = ['search_path=pg_catalog, pg_temp'] as const;
const RUNTIME_ROUTINE_SIGNATURES = [
  'commerce_fx.change_manual_rate_policy(uuid,uuid,jsonb)',
  'commerce_fx.read_manual_rate_policy_revision(uuid,uuid,uuid,text,text,text,text,text,text)',
  'commerce_fx.resolve_manual_rate_policy(uuid,uuid,text,text,text,text,text,text,timestamp with time zone)',
] as const;

const expectedRoutineFingerprints = (owner: string): readonly RoutineFingerprintRow[] =>
  RUNTIME_ROUTINE_SIGNATURES.map((signature) => ({
    direct_runtime_execute: true,
    language: 'plpgsql',
    owner,
    public_execute: false,
    result_contract: RUNTIME_RESULT_CONTRACT,
    return_type: 'jsonb',
    returns_set: true,
    runtime_execute: true,
    search_path: SECURE_SEARCH_PATH,
    security_definer: true,
    signature,
  }));

const sameStrings = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.length === expected.length && actual.every((value, index) => value === expected[index]);

const sameColumnFingerprints = (
  actual: readonly ColumnFingerprintRow[],
  expected: readonly ColumnFingerprintRow[],
): boolean =>
  actual.length === expected.length &&
  actual.every((value, index) => {
    const target = expected[index];
    return (
      target !== undefined &&
      value.column_name === target.column_name &&
      value.data_type === target.data_type &&
      value.not_null === target.not_null
    );
  });

const samePolicyFingerprints = (
  actual: readonly PolicyFingerprintRow[],
  expected: readonly PolicyFingerprintRow[],
): boolean =>
  actual.length === expected.length &&
  actual.every((value, index) => {
    const target = expected[index];
    return (
      target !== undefined &&
      value.command === target.command &&
      value.permissive === target.permissive &&
      value.policy_name === target.policy_name &&
      value.qual === target.qual &&
      value.role === target.role &&
      value.table_name === target.table_name &&
      value.with_check === target.with_check
    );
  });

const sameTriggerFingerprints = (
  actual: readonly TriggerFingerprintRow[],
  expected: readonly TriggerFingerprintRow[],
): boolean =>
  actual.length === expected.length &&
  actual.every((value, index) => {
    const target = expected[index];
    return (
      target !== undefined &&
      value.enabled === target.enabled &&
      value.function_signature === target.function_signature &&
      value.table_name === target.table_name &&
      value.trigger_name === target.trigger_name &&
      value.trigger_type === target.trigger_type
    );
  });

const sameRoutineFingerprints = (
  actual: readonly RoutineFingerprintRow[],
  expected: readonly RoutineFingerprintRow[],
): boolean =>
  actual.length === expected.length &&
  actual.every((value, index) => {
    const target = expected[index];
    return (
      target !== undefined &&
      value.direct_runtime_execute === target.direct_runtime_execute &&
      value.language === target.language &&
      value.owner === target.owner &&
      value.public_execute === target.public_execute &&
      value.result_contract === target.result_contract &&
      value.return_type === target.return_type &&
      value.returns_set === target.returns_set &&
      value.runtime_execute === target.runtime_execute &&
      value.search_path !== null &&
      target.search_path !== null &&
      sameStrings(value.search_path, target.search_path) &&
      value.security_definer === target.security_definer &&
      value.signature === target.signature
    );
  });

const failure = (reason: string, cause?: unknown) => {
  const error = new CommerceFxSchemaVerificationError({ reason });
  return cause === undefined ? error : Object.defineProperty(error, 'cause', { value: cause });
};

const requireVerification = (condition: boolean, reason: string) =>
  condition ? Effect.void : Effect.fail(failure(reason));

const isVerificationRowValid = (row: VerificationRow | undefined): boolean =>
  row !== undefined &&
  row.force_rls_count === COMMERCE_FX_TABLES.length &&
  row.policy_count === COMMERCE_FX_TABLES.length * 5 &&
  row.foreign_key_count === 1 &&
  row.append_only_trigger_count === 2 &&
  row.identity_trigger_count === 1 &&
  row.journal_count === 1 &&
  row.wrong_owner_count === 0 &&
  row.raw_runtime_privilege_count === 0 &&
  row.unsafe_routine_count === 0 &&
  row.public_routine_execute_count === 0 &&
  !row.private_routine_executable &&
  row.runtime_usage &&
  !row.runtime_create &&
  !row.runtime_super &&
  !row.runtime_bypass_rls;

const verify = Effect.gen(function* verifyCommerceFxSchema() {
  const connections = yield* loadDatabaseConnectionPair();
  const client = new Client({ connectionString: connections.admin.connectionString });
  yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      catch: (cause) => failure('Unable to connect to PostgreSQL as the migration owner', cause),
      // oxlint-disable-next-line typescript/promise-function-async -- Effect owns the foreign Promise boundary.
      try: () => client.connect().then(() => client),
    }),
    (connected) =>
      Effect.gen(function* inspectCommerceFx() {
        const catalog = yield* Effect.tryPromise({
          catch: (cause) => failure('Unable to read the Commerce FX table catalog', cause),
          // oxlint-disable-next-line typescript/promise-function-async -- Effect owns the foreign Promise boundary.
          try: () =>
            connected.query<{ readonly table_name: string }>(
              `select relation.relname as table_name
                 from pg_catalog.pg_class as relation
                 join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
                where namespace.nspname = $1 and relation.relkind in ('r', 'p')
                order by relation.relname`,
              [COMMERCE_FX_SCHEMA_NAME],
            ),
        });
        const difference = compareCommerceFxCatalog(
          catalog.rows.map(({ table_name }) => `${COMMERCE_FX_SCHEMA_NAME}.${table_name}`),
        );
        yield* requireVerification(
          difference.missing.length === 0 && difference.unexpected.length === 0,
          `Commerce FX catalog mismatch; missing=[${difference.missing.join(',')}], unexpected=[${difference.unexpected.join(',')}]`,
        );

        const arithmeticColumns = yield* Effect.tryPromise({
          catch: (cause) => failure('Unable to verify Commerce FX arithmetic columns', cause),
          // oxlint-disable-next-line typescript/promise-function-async -- Effect owns the foreign Promise boundary.
          try: () =>
            connected.query<ColumnFingerprintRow>(
              `select
                 attribute.attname as column_name,
                 attribute.atttypid::regtype::text as data_type,
                 attribute.attnotnull as not_null
                from pg_catalog.pg_attribute attribute
                join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
                join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
               where namespace.nspname = $1
                 and relation.relname = 'manual_rate_policy_revisions'
                 and attribute.attnum > 0
                 and not attribute.attisdropped
                 and attribute.attname in (
                   'arithmetic_version',
                   'rounding_increment',
                   'rounding_rule_revision'
                 )
               order by attribute.attname`,
              [COMMERCE_FX_SCHEMA_NAME],
            ),
        });
        yield* requireVerification(
          sameColumnFingerprints(arithmeticColumns.rows, EXPECTED_ARITHMETIC_COLUMN_FINGERPRINTS),
          'Commerce FX arithmetic column fingerprint does not match the exact contract',
        );

        const arithmeticConstraint = yield* Effect.tryPromise({
          catch: (cause) =>
            failure('Unable to verify the Commerce FX SET/WITHDRAW constraint', cause),
          // oxlint-disable-next-line typescript/promise-function-async -- Effect owns the foreign Promise boundary.
          try: () =>
            connected.query<ConstraintFingerprintRow>(
              `select pg_catalog.md5(pg_catalog.regexp_replace(
                 pg_catalog.pg_get_expr(constraint_record.conbin, constraint_record.conrelid),
                 '[[:space:]]+',
                 '',
                 'g'
               )) as fingerprint
                 from pg_catalog.pg_constraint constraint_record
                 join pg_catalog.pg_class relation on relation.oid = constraint_record.conrelid
                 join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
                where namespace.nspname = $1
                  and relation.relname = 'manual_rate_policy_revisions'
                  and constraint_record.conname = 'commerce_fx_manual_revisions_set_shape_ck'
                  and constraint_record.contype = 'c'`,
              [COMMERCE_FX_SCHEMA_NAME],
            ),
        });
        yield* requireVerification(
          arithmeticConstraint.rows.length === 1 &&
            arithmeticConstraint.rows[0]?.fingerprint === EXPECTED_SET_WITHDRAW_CHECK_FINGERPRINT,
          'Commerce FX SET/WITHDRAW constraint fingerprint does not match the exact contract',
        );

        const policyFingerprints = yield* Effect.tryPromise({
          catch: (cause) => failure('Unable to verify Commerce FX RLS policies', cause),
          // oxlint-disable-next-line typescript/promise-function-async -- Effect owns the foreign Promise boundary.
          try: () =>
            connected.query<PolicyFingerprintRow>(
              `select
                 policy.polcmd::text as command,
                 policy.polpermissive as permissive,
                 policy.polname as policy_name,
                 pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) as qual,
                 case
                   when policy.polroles = array[0::oid] then 'public'
                   when policy.polroles = array[(select role.oid from pg_catalog.pg_roles role where role.rolname = 'ontos_runtime')]
                     then 'ontos_runtime'
                   else 'unexpected'
                 end as role,
                 relation.relname as table_name,
                 pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) as with_check
                from pg_catalog.pg_policy policy
                join pg_catalog.pg_class relation on relation.oid = policy.polrelid
                join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
               where namespace.nspname = $1
               order by relation.relname, policy.polname`,
              [COMMERCE_FX_SCHEMA_NAME],
            ),
        });
        yield* requireVerification(
          samePolicyFingerprints(policyFingerprints.rows, EXPECTED_POLICY_FINGERPRINTS),
          'Commerce FX RLS policy fingerprint does not match the exact contract',
        );

        const triggerFingerprints = yield* Effect.tryPromise({
          catch: (cause) => failure('Unable to verify Commerce FX guard triggers', cause),
          // oxlint-disable-next-line typescript/promise-function-async -- Effect owns the foreign Promise boundary.
          try: () =>
            connected.query<TriggerFingerprintRow>(
              `select
                 trigger_record.tgenabled::text as enabled,
                 trigger_record.tgfoid::regprocedure::text as function_signature,
                 relation.relname as table_name,
                 trigger_record.tgname as trigger_name,
                 trigger_record.tgtype::integer as trigger_type
                from pg_catalog.pg_trigger trigger_record
                join pg_catalog.pg_class relation on relation.oid = trigger_record.tgrelid
                join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
               where namespace.nspname = $1 and not trigger_record.tgisinternal
               order by relation.relname, trigger_record.tgname`,
              [COMMERCE_FX_SCHEMA_NAME],
            ),
        });
        yield* requireVerification(
          sameTriggerFingerprints(triggerFingerprints.rows, EXPECTED_TRIGGER_FINGERPRINTS),
          'Commerce FX trigger fingerprint does not match the exact contract',
        );

        const routineFingerprints = yield* Effect.tryPromise({
          catch: (cause) => failure('Unable to verify Commerce FX runtime routines', cause),
          // oxlint-disable-next-line typescript/promise-function-async -- Effect owns the foreign Promise boundary.
          try: () =>
            connected.query<RoutineFingerprintRow>(
              `select
                 exists (
                   select 1
                     from pg_catalog.aclexplode(coalesce(
                       routine.proacl,
                       pg_catalog.acldefault('f'::"char", routine.proowner)
                     )) privilege
                    where privilege.grantee = runtime.oid
                      and privilege.privilege_type = 'EXECUTE'
                      and not privilege.is_grantable
                 ) as direct_runtime_execute,
                 language.lanname as language,
                 pg_catalog.pg_get_userbyid(routine.proowner) as owner,
                 pg_catalog.has_function_privilege('public', routine.oid, 'EXECUTE') as public_execute,
                 pg_catalog.pg_get_function_result(routine.oid) as result_contract,
                 routine.prorettype::regtype::text as return_type,
                 routine.proretset as returns_set,
                 pg_catalog.has_function_privilege('ontos_runtime', routine.oid, 'EXECUTE') as runtime_execute,
                 routine.proconfig as search_path,
                 routine.prosecdef as security_definer,
                 routine.oid::regprocedure::text as signature
                from pg_catalog.pg_proc routine
                join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
                join pg_catalog.pg_language language on language.oid = routine.prolang
                cross join pg_catalog.pg_roles runtime
               where namespace.nspname = $1
                 and runtime.rolname = 'ontos_runtime'
                 and pg_catalog.has_function_privilege('ontos_runtime', routine.oid, 'EXECUTE')
               order by routine.oid::regprocedure::text`,
              [COMMERCE_FX_SCHEMA_NAME],
            ),
        });
        yield* requireVerification(
          sameRoutineFingerprints(
            routineFingerprints.rows,
            expectedRoutineFingerprints(connections.admin.user),
          ),
          'Commerce FX runtime routine fingerprint does not match the exact contract',
        );

        const result = yield* Effect.tryPromise({
          catch: (cause) => failure('Unable to verify Commerce FX database security', cause),
          // oxlint-disable-next-line typescript/promise-function-async -- Effect owns the foreign Promise boundary.
          try: () =>
            connected.query<VerificationRow>(
              `select
                 (select count(*)::integer from pg_catalog.pg_class relation
                   join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
                  where namespace.nspname = $1 and relation.relkind in ('r', 'p')
                    and relation.relrowsecurity and relation.relforcerowsecurity) as force_rls_count,
                 (select count(*)::integer from pg_catalog.pg_policy policy
                   join pg_catalog.pg_class relation on relation.oid = policy.polrelid
                   join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
                  where namespace.nspname = $1) as policy_count,
                 (select count(*)::integer from pg_catalog.pg_constraint constraint_record
                   join pg_catalog.pg_class relation on relation.oid = constraint_record.conrelid
                   join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
                  where namespace.nspname = $1 and constraint_record.contype = 'f') as foreign_key_count,
                 (select count(*)::integer from pg_catalog.pg_trigger trigger_record
                   join pg_catalog.pg_class relation on relation.oid = trigger_record.tgrelid
                   join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
                  where namespace.nspname = $1 and not trigger_record.tgisinternal
                    and trigger_record.tgname in ('commerce_fx_manual_revisions_append_only', 'commerce_fx_manual_journal_append_only')) as append_only_trigger_count,
                 (select count(*)::integer from pg_catalog.pg_trigger trigger_record
                   join pg_catalog.pg_class relation on relation.oid = trigger_record.tgrelid
                   join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
                  where namespace.nspname = $1 and not trigger_record.tgisinternal
                    and trigger_record.tgname = 'commerce_fx_manual_head_identity_immutable') as identity_trigger_count,
                 (select count(*)::integer from pg_catalog.pg_class journal
                   join pg_catalog.pg_namespace namespace on namespace.oid = journal.relnamespace
                  where namespace.nspname = 'drizzle'
                    and journal.relname = '__drizzle_migrations_commerce_fx') as journal_count,
                 (select count(*)::integer from pg_catalog.pg_class relation
                   join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
                  where namespace.nspname = $1 and relation.relkind in ('r', 'p')
                    and pg_catalog.pg_get_userbyid(relation.relowner) <> $2) as wrong_owner_count,
                 (select count(*)::integer from pg_catalog.pg_class relation
                   join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
                  where namespace.nspname = $1 and relation.relkind in ('r', 'p')
                    and (has_table_privilege('ontos_runtime', relation.oid, 'SELECT')
                      or has_table_privilege('ontos_runtime', relation.oid, 'INSERT')
                      or has_table_privilege('ontos_runtime', relation.oid, 'UPDATE')
                      or has_table_privilege('ontos_runtime', relation.oid, 'DELETE'))) as raw_runtime_privilege_count,
                 (select count(*)::integer from pg_catalog.pg_proc routine
                    join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
                   where namespace.nspname = $1
                     and has_function_privilege('ontos_runtime', routine.oid, 'EXECUTE')
                     and (not routine.prosecdef
                       or not coalesce(routine.proconfig, array[]::text[]) @> array['search_path=pg_catalog, pg_temp'])) as unsafe_routine_count,
                 (select count(*)::integer
                    from pg_catalog.pg_proc routine
                    join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
                    cross join lateral pg_catalog.aclexplode(coalesce(
                      routine.proacl,
                      pg_catalog.acldefault('f'::"char", routine.proowner)
                    )) privilege
                   where namespace.nspname = $1
                     and privilege.grantee = 0
                     and privilege.privilege_type = 'EXECUTE') as public_routine_execute_count,
                 has_function_privilege('ontos_runtime', 'commerce_fx.assert_operation_scope(uuid,uuid)', 'EXECUTE')
                   or has_function_privilege('ontos_runtime', 'commerce_fx.manual_rate_policy_revision_json(uuid,uuid,uuid)', 'EXECUTE')
                   or has_function_privilege('ontos_runtime', 'commerce_fx.reject_manual_rate_policy_append_only_change()', 'EXECUTE')
                   or has_function_privilege('ontos_runtime', 'commerce_fx.reject_manual_rate_policy_head_identity_change()', 'EXECUTE') as private_routine_executable,
                 has_schema_privilege('ontos_runtime', $1, 'USAGE') as runtime_usage,
                 has_schema_privilege('ontos_runtime', $1, 'CREATE') as runtime_create,
                 runtime.rolsuper as runtime_super,
                 runtime.rolbypassrls as runtime_bypass_rls
                from pg_catalog.pg_roles runtime where runtime.rolname = 'ontos_runtime'`,
              [COMMERCE_FX_SCHEMA_NAME, connections.admin.user],
            ),
        });
        const [row] = result.rows;
        yield* requireVerification(
          isVerificationRowValid(row),
          'Commerce FX database violates its exact owner, RLS, routine, or least-privilege contract',
        );
      }),
    () =>
      Effect.tryPromise({
        catch: (cause) => failure('Unable to close the PostgreSQL verifier connection', cause),
        // oxlint-disable-next-line typescript/promise-function-async -- Effect owns the foreign Promise boundary.
        try: () => client.end(),
      }),
  );
});

await Effect.runPromise(verify);
process.stdout.write(
  `Verified ${COMMERCE_FX_TABLES.length} governed tables in ${COMMERCE_FX_SCHEMA_NAME}\n`,
);
