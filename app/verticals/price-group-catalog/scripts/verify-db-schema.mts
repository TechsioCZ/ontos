// oxlint-disable sonarjs/no-duplicate-string -- Exact PostgreSQL routine signatures deliberately repeat across independent inventories; expires: 2027-03-31.
// @effect-diagnostics globalConsole:off strictEffectProvide:off -- Operator verifier is an executable boundary; expires: 2027-03-31.
import { DatabaseConfig, loadDatabaseConnectionPair } from '@app/core-runtime';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { PgClient } from '@effect/sql-pg';
import { Array as EffectArray, Effect, Layer, Order, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';

import { comparePriceGroupCatalog } from '../src/database/catalog.ts';
import { PriceGroupCatalogDatabase, PriceGroupCatalogDatabaseLive } from '../src/database/client.ts';
import { PRICE_GROUP_CATALOG_SCHEMA_NAME, PRICE_GROUP_CATALOG_TABLES } from '../src/database/schema.ts';

class PriceGroupCatalogVerificationError extends Schema.TaggedError<PriceGroupCatalogVerificationError>()(
  'PriceGroupCatalogVerificationError',
  {
    cause: Schema.optionalKey(Schema.Unknown),
    reason: Schema.String,
  },
) {}

const verificationFailure = (reason: string, cause?: unknown): PriceGroupCatalogVerificationError =>
  new PriceGroupCatalogVerificationError(cause === undefined ? { reason } : { cause, reason });

const query = <Row extends object>(
  client: PgClient.PgClient,
  text: string,
  values: readonly string[],
  reason: string,
): Effect.Effect<readonly Row[], PriceGroupCatalogVerificationError> =>
  client.unsafe<Row>(text, values).pipe(Effect.mapError((cause) => verificationFailure(reason, cause)));

const expectedColumns = EffectArray.sort(
  PRICE_GROUP_CATALOG_TABLES.flatMap((table) => {
    const config = getTableConfig(table);
    return config.columns.map((column) => `${config.name}.${column.name}`);
  }),
  Order.String,
);

const expectedForeignKeys = [
  'price_group_catalog_compatibility_definition_fk',
  'price_group_catalog_compatibility_ledger_fk',
  'price_group_catalog_containment_intents_definition_fk',
  'price_group_catalog_containment_intents_ledger_fk',
  'price_group_catalog_definitions_ledger_fk',
  'price_group_catalog_groups_creation_ledger_fk',
  'price_group_catalog_groups_current_schedule_ledger_fk',
  'price_group_catalog_intervals_definition_fk',
  'price_group_catalog_intervals_schedule_ledger_fk',
  'price_group_catalog_retirements_definition_fk',
  'price_group_catalog_retirements_expected_ledger_fk',
  'price_group_catalog_retirements_group_fk',
  'price_group_catalog_retirements_ledger_fk',
] as const;

const expectedTriggers = [
  'price_group_catalog_ledger.price_group_catalog_ledger_append_only',
  'price_group_catalog_ledger.price_group_catalog_ledger_fence',
  'price_group_compatibility_support.price_group_catalog_compatibility_append_only',
  'price_group_definition_effective_intervals.price_group_catalog_intervals_append_only',
  'price_group_definition_effective_intervals.price_group_catalog_intervals_guard_insert',
  'price_group_definition_revisions.price_group_catalog_definitions_append_only',
  'price_group_definition_revisions.price_group_catalog_definitions_guard_insert',
  'price_group_retirements.price_group_catalog_retirements_append_only',
  'price_group_retirements.price_group_catalog_retirements_guard_insert',
  'price_group_retirements.price_group_retirements_consistency',
  'price_groups.price_groups_guard_update',
  'price_groups.price_groups_no_delete',
  'price_groups.price_groups_retirement_consistency',
] as const;

const expectedFunctions = [
  'assert_operation_scope(uuid)',
  'canonical_price_group_meaning(text)',
  'complete_price_group_containment_projection(uuid, uuid, timestamp with time zone)',
  'create_definition_revision(uuid, jsonb)',
  'create_definition_revision_with_continuity(uuid, jsonb)',
  'create_price_group(uuid, jsonb)',
  'create_price_group_with_complete_schedule(uuid, jsonb)',
  'create_price_group_with_containment_projection(uuid, jsonb)',
  'definition_json(uuid, uuid, uuid, bigint)',
  'enforce_catalog_fence()',
  'guard_definition_insert()',
  'guard_interval_insert()',
  'guard_price_group_update()',
  'guard_retirement_insert()',
  'price_group_meaning_fingerprint(text)',
  'read_current_definition(uuid, uuid, timestamp with time zone)',
  'read_current_definition_with_retirement(uuid, uuid, timestamp with time zone)',
  'read_definition_revision(uuid, uuid, uuid, timestamp with time zone)',
  'read_definition_revision_with_retirement(uuid, uuid, uuid, timestamp with time zone)',
  'read_price_group_containment_projection_intent(uuid, uuid)',
  'reject_append_only_mutation()',
  'retirement_acceptance_json(uuid, uuid)',
  'retire_price_group(uuid, jsonb)',
  'validate_compatibility(uuid, uuid, text, bigint, timestamp with time zone, jsonb)',
  'verify_retirement_consistency()',
] as const;

const expectedRuntimeFunctions = [
  'complete_price_group_containment_projection(uuid, uuid, timestamp with time zone)',
  'create_definition_revision_with_continuity(uuid, jsonb)',
  'create_price_group_with_complete_schedule(uuid, jsonb)',
  'read_current_definition_with_retirement(uuid, uuid, timestamp with time zone)',
  'read_definition_revision_with_retirement(uuid, uuid, uuid, timestamp with time zone)',
  'read_price_group_containment_projection_intent(uuid, uuid)',
  'retire_price_group(uuid, jsonb)',
  'validate_compatibility(uuid, uuid, text, bigint, timestamp with time zone, jsonb)',
] as const;

const expectedSecurityDefinerFunctions = new Set([
  'assert_operation_scope(uuid)',
  'complete_price_group_containment_projection(uuid, uuid, timestamp with time zone)',
  'create_definition_revision(uuid, jsonb)',
  'create_definition_revision_with_continuity(uuid, jsonb)',
  'create_price_group(uuid, jsonb)',
  'create_price_group_with_complete_schedule(uuid, jsonb)',
  'create_price_group_with_containment_projection(uuid, jsonb)',
  'definition_json(uuid, uuid, uuid, bigint)',
  'read_current_definition(uuid, uuid, timestamp with time zone)',
  'read_current_definition_with_retirement(uuid, uuid, timestamp with time zone)',
  'read_definition_revision(uuid, uuid, uuid, timestamp with time zone)',
  'read_definition_revision_with_retirement(uuid, uuid, uuid, timestamp with time zone)',
  'read_price_group_containment_projection_intent(uuid, uuid)',
  'retirement_acceptance_json(uuid, uuid)',
  'retire_price_group(uuid, jsonb)',
  'validate_compatibility(uuid, uuid, text, bigint, timestamp with time zone, jsonb)',
]);

const tenantPolicyPredicate = "(tenant_id = (NULLIF(current_setting('ontos.tenant_id'::text, true), ''::text))::uuid)";
const expectedPolicyPrefixes = {
  price_group_catalog_ledger: 'price_group_catalog_ledger_scope',
  price_group_compatibility_support: 'price_group_catalog_compatibility_scope',
  price_group_containment_projection_intents: 'price_group_catalog_containment_intents_scope',
  price_group_definition_effective_intervals: 'price_group_catalog_intervals_scope',
  price_group_definition_revisions: 'price_group_catalog_definitions_scope',
  price_group_retirements: 'price_group_catalog_retirements_scope',
  price_groups: 'price_group_catalog_groups_scope',
} as const;
const expectedPolicies = Object.entries(expectedPolicyPrefixes).flatMap(([table, prefix]) => [
  `${table}|${prefix}_delete|d|t|{ontos_runtime}|${tenantPolicyPredicate}|`,
  `${table}|${prefix}_insert|a|t|{ontos_runtime}||${tenantPolicyPredicate}`,
  `${table}|${prefix}_select|r|t|{ontos_runtime}|${tenantPolicyPredicate}|`,
  `${table}|${prefix}_update|w|t|{ontos_runtime}|${tenantPolicyPredicate}|${tenantPolicyPredicate}`,
]);

const exactValuesMatch = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.length === expected.length && actual.every((value, index) => value === expected[index]);

const verifyExactValues = (label: string, actual: readonly string[], expected: readonly string[]) => {
  const sortedActual = EffectArray.sort(actual, Order.String);
  const sortedExpected = EffectArray.sort(expected, Order.String);
  return exactValuesMatch(sortedActual, sortedExpected)
    ? Effect.void
    : Effect.fail(
        verificationFailure(
          `${label} mismatch; expected=[${sortedExpected.join(', ')}], actual=[${sortedActual.join(', ')}]`,
        ),
      );
};

const verifyCatalogInventory = (qualifiedTables: readonly string[]) => {
  const difference = comparePriceGroupCatalog(qualifiedTables);
  return difference.missing.length === 0 && difference.unexpected.length === 0
    ? Effect.void
    : Effect.fail(
        verificationFailure(
          `Price Group Catalog mismatch; missing=[${difference.missing.join(', ')}], unexpected=[${difference.unexpected.join(', ')}]`,
        ),
      );
};

interface InfrastructureCatalog {
  readonly extension_count: number;
  readonly force_rls_count: number;
  readonly function_count: number;
  readonly governed_runtime_function_count: number;
  readonly journal_count: number;
  readonly no_overlap_count: number;
  readonly policy_count: number;
  readonly role_bypass_rls: boolean;
  readonly role_super: boolean;
  readonly runtime_create: boolean;
  readonly runtime_delete_count: number;
  readonly runtime_execute_count: number;
  readonly runtime_insert_count: number;
  readonly runtime_select_count: number;
  readonly runtime_update_count: number;
  readonly runtime_usage: boolean;
  readonly table_count: number;
  readonly wrong_owner_count: number;
}

const verifyInfrastructure = (catalog: InfrastructureCatalog | undefined) =>
  catalog !== undefined &&
  catalog.table_count === PRICE_GROUP_CATALOG_TABLES.length &&
  catalog.force_rls_count === PRICE_GROUP_CATALOG_TABLES.length - 1 &&
  catalog.wrong_owner_count === 0 &&
  catalog.policy_count === (PRICE_GROUP_CATALOG_TABLES.length - 1) * 4 &&
  catalog.no_overlap_count === 1 &&
  catalog.function_count === expectedFunctions.length &&
  catalog.governed_runtime_function_count === expectedRuntimeFunctions.length &&
  catalog.runtime_execute_count === expectedRuntimeFunctions.length &&
  catalog.journal_count === 1 &&
  catalog.extension_count === 1 &&
  !catalog.runtime_create &&
  catalog.runtime_usage &&
  catalog.runtime_select_count === 1 &&
  catalog.runtime_insert_count === 1 &&
  catalog.runtime_update_count === 0 &&
  catalog.runtime_delete_count === 1 &&
  !catalog.role_super &&
  !catalog.role_bypass_rls
    ? Effect.void
    : Effect.fail(
        verificationFailure(
          'Price Group Catalog infrastructure violates its exact owner, forced-RLS, immutable-history, journal, or least-privilege contract',
        ),
      );

const verification = Effect.gen(function* verifyPriceGroupCatalogDatabase() {
  const connections = yield* loadDatabaseConnectionPair();
  const database = yield* PriceGroupCatalogDatabase;
  for (const table of PRICE_GROUP_CATALOG_TABLES) {
    yield* database.executor
      .select()
      .from(table)
      .limit(0)
      .pipe(
        Effect.mapError((cause) => verificationFailure('Typed Price Group Catalog table verification failed', cause)),
      );
  }
  const client = yield* PgClient.makeClient({ url: Redacted.make(connections.admin.connectionString) }).pipe(
    Effect.mapError((cause) => verificationFailure('Unable to connect to the Price Group Catalog database', cause)),
  );

  const tables = yield* query<{ table_name: string }>(
    client,
    `select relation.relname as table_name
       from pg_catalog.pg_class as relation
       inner join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = $1 and relation.relkind in ('r', 'p')
      order by relation.relname`,
    [PRICE_GROUP_CATALOG_SCHEMA_NAME],
    'Unable to compare the PostgreSQL Price Group Catalog',
  );
  const qualifiedTables = tables.map((row) => `${PRICE_GROUP_CATALOG_SCHEMA_NAME}.${row.table_name}`);
  yield* verifyCatalogInventory(qualifiedTables);

  const columns = yield* query<{ column_name: string; table_name: string }>(
    client,
    `select table_name, column_name
       from information_schema.columns
      where table_schema = $1
      order by table_name, column_name`,
    [PRICE_GROUP_CATALOG_SCHEMA_NAME],
    'Unable to compare Price Group Catalog columns',
  );
  const actualColumns = EffectArray.sort(
    columns.map((row) => `${row.table_name}.${row.column_name}`),
    Order.String,
  );
  yield* verifyExactValues('Price Group Catalog column', actualColumns, expectedColumns);

  const foreignKeys = yield* query<{ name: string }>(
    client,
    `select constraint_record.conname as name
       from pg_catalog.pg_constraint as constraint_record
       inner join pg_catalog.pg_class as constrained on constrained.oid = constraint_record.conrelid
       inner join pg_catalog.pg_namespace as namespace on namespace.oid = constrained.relnamespace
      where namespace.nspname = $1 and constraint_record.contype = 'f'
      order by constraint_record.conname`,
    [PRICE_GROUP_CATALOG_SCHEMA_NAME],
    'Unable to compare Price Group Catalog foreign keys',
  );
  yield* verifyExactValues(
    'Price Group Catalog foreign-key inventory',
    foreignKeys.map(({ name }) => name),
    expectedForeignKeys,
  );

  const functions = yield* query<{
    name: string;
    owner_name: string;
    public_execute: boolean;
    safe_search_path: boolean;
    security_definer: boolean;
  }>(
    client,
    `select format('%s(%s)', routine.proname, pg_catalog.oidvectortypes(routine.proargtypes)) as name,
            pg_catalog.pg_get_userbyid(routine.proowner) as owner_name,
            exists (
              select 1
              from pg_catalog.aclexplode(coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))) as acl
              where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
            ) as public_execute,
            routine.prosecdef as security_definer,
            routine.proconfig = array['search_path=pg_catalog, pg_temp']::text[] as safe_search_path
       from pg_catalog.pg_proc as routine
       inner join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
      where namespace.nspname = $1
      order by name`,
    [PRICE_GROUP_CATALOG_SCHEMA_NAME],
    'Unable to compare Price Group Catalog routine inventory',
  );
  yield* verifyExactValues(
    'Price Group Catalog routine inventory',
    functions.map(({ name }) => name),
    expectedFunctions,
  );
  if (functions.some(({ owner_name, public_execute }) => owner_name !== connections.admin.user || public_execute)) {
    return yield* verificationFailure('Price Group Catalog routines must be owner-controlled with no PUBLIC EXECUTE');
  }
  if (
    functions.some(({ name, safe_search_path, security_definer }) => {
      const expectedSecurityDefiner = expectedSecurityDefinerFunctions.has(name);
      return security_definer !== expectedSecurityDefiner || (expectedSecurityDefiner && !safe_search_path);
    })
  ) {
    return yield* verificationFailure(
      'Price Group Catalog routines must exactly match the governed SECURITY DEFINER and pinned search_path inventory',
    );
  }

  const policies = yield* query<{ policy: string }>(
    client,
    `select concat_ws('|', governed.relname, policy.polname, policy.polcmd, policy.polpermissive,
              policy.polroles::regrole[]::text,
              coalesce(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid), ''),
              coalesce(pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid), '')) as policy
       from pg_catalog.pg_policy as policy
       inner join pg_catalog.pg_class as governed on governed.oid = policy.polrelid
       inner join pg_catalog.pg_namespace as namespace on namespace.oid = governed.relnamespace
      where namespace.nspname = $1
      order by governed.relname, policy.polname`,
    [PRICE_GROUP_CATALOG_SCHEMA_NAME],
    'Unable to compare Price Group Catalog row-level security policies',
  );
  yield* verifyExactValues(
    'Price Group Catalog row-level security policy',
    policies.map(({ policy }) => policy),
    expectedPolicies,
  );

  const runtimeFunctions = yield* query<{ name: string }>(
    client,
    `select format('%s(%s)', routine.proname, pg_catalog.oidvectortypes(routine.proargtypes)) as name
       from pg_catalog.pg_proc as routine
       inner join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
      where namespace.nspname = $1
        and has_function_privilege('ontos_runtime', routine.oid, 'EXECUTE')
      order by name`,
    [PRICE_GROUP_CATALOG_SCHEMA_NAME],
    'Unable to compare Price Group Catalog runtime routine grants',
  );
  yield* verifyExactValues(
    'Price Group Catalog runtime routine grant inventory',
    runtimeFunctions.map(({ name }) => name),
    expectedRuntimeFunctions,
  );

  const triggers = yield* query<{ name: string }>(
    client,
    `select format('%s.%s', relation.relname, trigger_record.tgname) as name
       from pg_catalog.pg_trigger as trigger_record
       inner join pg_catalog.pg_class as relation on relation.oid = trigger_record.tgrelid
       inner join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = $1 and not trigger_record.tgisinternal
      order by relation.relname, trigger_record.tgname`,
    [PRICE_GROUP_CATALOG_SCHEMA_NAME],
    'Unable to compare Price Group Catalog trigger inventory',
  );
  yield* verifyExactValues(
    'Price Group Catalog trigger inventory',
    triggers.map(({ name }) => name),
    expectedTriggers,
  );

  const infrastructure = yield* query<InfrastructureCatalog>(
    client,
    `select
       count(distinct relation.oid)::integer as table_count,
       count(distinct relation.oid) filter (where relation.relrowsecurity and relation.relforcerowsecurity)::integer as force_rls_count,
       count(distinct relation.oid) filter (where pg_catalog.pg_get_userbyid(relation.relowner) <> $2)::integer as wrong_owner_count,
       (select count(*)::integer from pg_catalog.pg_policy as policy
         inner join pg_catalog.pg_class as governed on governed.oid = policy.polrelid
         inner join pg_catalog.pg_namespace as governed_namespace on governed_namespace.oid = governed.relnamespace
        where governed_namespace.nspname = $1) as policy_count,
       (select count(*)::integer from pg_catalog.pg_constraint as constraint_record
         inner join pg_catalog.pg_class as constrained on constrained.oid = constraint_record.conrelid
         inner join pg_catalog.pg_namespace as constrained_namespace on constrained_namespace.oid = constrained.relnamespace
        where constrained_namespace.nspname = $1
          and constraint_record.conname = 'price_group_catalog_intervals_no_overlap_excl'
          and constraint_record.contype = 'x') as no_overlap_count,
       (select count(*)::integer from pg_catalog.pg_proc as routine
         inner join pg_catalog.pg_namespace as routine_namespace on routine_namespace.oid = routine.pronamespace
        where routine_namespace.nspname = $1) as function_count,
       (select count(*)::integer from pg_catalog.pg_proc as routine
         inner join pg_catalog.pg_namespace as routine_namespace on routine_namespace.oid = routine.pronamespace
        where routine_namespace.nspname = $1
          and has_function_privilege('ontos_runtime', routine.oid, 'EXECUTE')) as runtime_execute_count,
       (select count(*)::integer from pg_catalog.pg_proc as routine
         inner join pg_catalog.pg_namespace as routine_namespace on routine_namespace.oid = routine.pronamespace
        where routine_namespace.nspname = $1
          and has_function_privilege('ontos_runtime', routine.oid, 'EXECUTE')
          and routine.prosecdef
          and routine.proconfig @> array['search_path=pg_catalog, pg_temp']::text[]) as governed_runtime_function_count,
       (select count(*)::integer from pg_catalog.pg_class as journal
         inner join pg_catalog.pg_namespace as journal_namespace on journal_namespace.oid = journal.relnamespace
        where journal_namespace.nspname = 'drizzle'
          and journal.relname = '__drizzle_migrations_price_group_catalog') as journal_count,
       (select count(*)::integer from pg_catalog.pg_extension where extname = 'btree_gist') as extension_count,
       has_schema_privilege('ontos_runtime', $1, 'CREATE') as runtime_create,
       has_schema_privilege('ontos_runtime', $1, 'USAGE') as runtime_usage,
       count(distinct relation.oid) filter (where has_table_privilege('ontos_runtime', format('%I.%I', namespace.nspname, relation.relname), 'SELECT'))::integer as runtime_select_count,
       count(distinct relation.oid) filter (where has_table_privilege('ontos_runtime', format('%I.%I', namespace.nspname, relation.relname), 'INSERT'))::integer as runtime_insert_count,
       count(distinct relation.oid) filter (where has_table_privilege('ontos_runtime', format('%I.%I', namespace.nspname, relation.relname), 'UPDATE'))::integer as runtime_update_count,
       count(distinct relation.oid) filter (where has_table_privilege('ontos_runtime', format('%I.%I', namespace.nspname, relation.relname), 'DELETE'))::integer as runtime_delete_count,
       runtime_role.rolsuper as role_super,
       runtime_role.rolbypassrls as role_bypass_rls
      from pg_catalog.pg_class as relation
      inner join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      cross join pg_catalog.pg_roles as runtime_role
     where namespace.nspname = $1
       and relation.relkind in ('r', 'p')
       and runtime_role.rolname = 'ontos_runtime'
     group by runtime_role.rolsuper, runtime_role.rolbypassrls`,
    [PRICE_GROUP_CATALOG_SCHEMA_NAME, connections.admin.user],
    'Unable to verify Price Group Catalog ownership, forced RLS, grants, or journal',
  );
  const [catalog] = infrastructure;
  yield* verifyInfrastructure(catalog);

  return { typedTableCount: PRICE_GROUP_CATALOG_TABLES.length };
});

const runtime = Layer.merge(
  PriceGroupCatalogDatabaseLive.pipe(
    Layer.provide(Layer.effect(DatabaseConfig, loadDatabaseConnectionPair().pipe(Effect.map(({ admin }) => admin)))),
  ),
  Reactivity.layer,
);
const result = await Effect.runPromise(Effect.provide(Effect.scoped(verification), runtime));
console.log(`Verified ${result.typedTableCount} typed tables in PostgreSQL schema ${PRICE_GROUP_CATALOG_SCHEMA_NAME}`);
