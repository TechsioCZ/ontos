// @effect-diagnostics globalConsole:off nodeBuiltinImport:off -- Operator-only database verification adapts the PostgreSQL driver at the infrastructure edge; expires: 2027-03-31.
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { PgClient } from '@effect/sql-pg';
import { Array as EffectArray, Console, Effect, Order, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';

import { STOREFRONT_REGISTRY_SCHEMA_NAME, STOREFRONT_REGISTRY_TABLES } from '../src/database/schema.ts';

class StorefrontRegistrySchemaVerificationError extends Schema.TaggedError<StorefrontRegistrySchemaVerificationError>()(
  'StorefrontRegistrySchemaVerificationError',
  { reason: Schema.String },
) {}

interface InfrastructureRow {
  readonly append_only_trigger_count: number;
  readonly forced_rls_count: number;
  readonly journal_count: number;
  readonly policy_count: number;
  readonly raw_runtime_privilege_count: number;
  readonly runtime_routine_count: number;
  readonly unsafe_runtime_routine_count: number;
}

const expectedTables = EffectArray.sort(
  STOREFRONT_REGISTRY_TABLES.map((table) => getTableConfig(table).name),
  Order.String,
);
const expectedColumns = EffectArray.sort(
  STOREFRONT_REGISTRY_TABLES.flatMap((table) => {
    const config = getTableConfig(table);
    return config.columns.map((column) => `${config.name}.${column.name}`);
  }),
  Order.String,
);

const verification = Effect.gen(function* verifyStorefrontRegistryDatabase() {
  const configuration = yield* loadDatabaseConnectionPair();
  const client = yield* PgClient.makeClient({ url: Redacted.make(configuration.admin.connectionString) }).pipe(
    Effect.mapError(
      () =>
        new StorefrontRegistrySchemaVerificationError({
          reason: 'Unable to connect to the Storefront Registry database',
        }),
    ),
  );
  const tables = yield* client
    .unsafe<{ readonly table_name: string }>(
      `select table_name
           from information_schema.tables
          where table_schema = $1 and table_type = 'BASE TABLE'
          order by table_name`,
      [STOREFRONT_REGISTRY_SCHEMA_NAME],
    )
    .pipe(
      Effect.mapError(
        () => new StorefrontRegistrySchemaVerificationError({ reason: 'Unable to inspect Storefront Registry tables' }),
      ),
    );
  const actualTables = EffectArray.sort(
    tables.map(({ table_name }) => table_name),
    Order.String,
  );
  if (
    actualTables.length !== expectedTables.length ||
    actualTables.some((table, index) => table !== expectedTables[index])
  ) {
    return yield* new StorefrontRegistrySchemaVerificationError({
      reason: 'Storefront Registry table inventory mismatch',
    });
  }
  const columns = yield* client
    .unsafe<{ readonly column_name: string; readonly table_name: string }>(
      `select table_name, column_name
           from information_schema.columns
          where table_schema = $1
          order by table_name, column_name`,
      [STOREFRONT_REGISTRY_SCHEMA_NAME],
    )
    .pipe(
      Effect.mapError(
        () =>
          new StorefrontRegistrySchemaVerificationError({ reason: 'Unable to inspect Storefront Registry columns' }),
      ),
    );
  const actualColumns = EffectArray.sort(
    columns.map(({ column_name, table_name }) => `${table_name}.${column_name}`),
    Order.String,
  );
  if (
    actualColumns.length !== expectedColumns.length ||
    actualColumns.some((column, index) => column !== expectedColumns[index])
  ) {
    return yield* new StorefrontRegistrySchemaVerificationError({
      reason: 'Storefront Registry column inventory does not match the typed schema',
    });
  }
  const infrastructure = yield* client
    .unsafe<InfrastructureRow>(
      `select
           (select count(*)::integer
              from pg_catalog.pg_trigger as trigger_record
              join pg_catalog.pg_class as relation on relation.oid = trigger_record.tgrelid
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and not trigger_record.tgisinternal
               and trigger_record.tgname = 'storefront_registry_revisions_append_only') as append_only_trigger_count,
           (select count(*)::integer
              from pg_catalog.pg_class as relation
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relkind in ('r', 'p')
               and relation.relrowsecurity and relation.relforcerowsecurity) as forced_rls_count,
           (select count(*)::integer
              from pg_catalog.pg_class as journal
              join pg_catalog.pg_namespace as namespace on namespace.oid = journal.relnamespace
             where namespace.nspname = 'drizzle'
               and journal.relname = '__drizzle_migrations_storefront_registry') as journal_count,
           (select count(*)::integer
              from pg_catalog.pg_policy as policy
              join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1) as policy_count,
           (select count(*)::integer
              from pg_catalog.pg_class as relation
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relkind in ('r', 'p')
               and (has_table_privilege('ontos_runtime', relation.oid, 'SELECT')
                 or has_table_privilege('ontos_runtime', relation.oid, 'INSERT')
                 or has_table_privilege('ontos_runtime', relation.oid, 'UPDATE')
                 or has_table_privilege('ontos_runtime', relation.oid, 'DELETE'))) as raw_runtime_privilege_count,
           (select count(*)::integer
              from pg_catalog.pg_proc as routine
              join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = $1
               and routine.proname in (
                 'read_current_storefront_application',
                 'register_storefront_application',
                 'revise_storefront_application'
               )
               and has_function_privilege('ontos_runtime', routine.oid, 'EXECUTE')) as runtime_routine_count,
           (select count(*)::integer
              from pg_catalog.pg_proc as routine
              join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = $1
               and routine.proname in (
                 'read_current_storefront_application',
                 'register_storefront_application',
                 'revise_storefront_application'
               )
               and (not routine.prosecdef
                 or not coalesce(routine.proconfig @> array['search_path=pg_catalog, pg_temp']::text[], false)))
             as unsafe_runtime_routine_count`,
      [STOREFRONT_REGISTRY_SCHEMA_NAME],
    )
    .pipe(
      Effect.mapError(
        () =>
          new StorefrontRegistrySchemaVerificationError({
            reason: 'Unable to inspect Storefront Registry database infrastructure',
          }),
      ),
    );
  const [row] = infrastructure;
  const expectedPolicyCount = STOREFRONT_REGISTRY_TABLES.reduce(
    (count, table) => count + getTableConfig(table).policies.length,
    0,
  );
  if (
    row === undefined ||
    row.append_only_trigger_count !== 1 ||
    row.forced_rls_count !== STOREFRONT_REGISTRY_TABLES.length ||
    row.journal_count !== 1 ||
    row.policy_count !== expectedPolicyCount ||
    row.raw_runtime_privilege_count !== 0 ||
    row.runtime_routine_count !== 3 ||
    row.unsafe_runtime_routine_count !== 0
  ) {
    return yield* new StorefrontRegistrySchemaVerificationError({
      reason: 'Storefront Registry RLS, policy, journal, trigger, privilege, or routine inventory mismatch',
    });
  }
  return { tableCount: actualTables.length };
});

await Effect.runPromise(
  Effect.scoped(verification).pipe(
    Effect.provide(Reactivity.layer),
    Effect.tap(({ tableCount }) =>
      Console.log(`Verified ${tableCount} tables in PostgreSQL schema ${STOREFRONT_REGISTRY_SCHEMA_NAME}`),
    ),
  ),
);
