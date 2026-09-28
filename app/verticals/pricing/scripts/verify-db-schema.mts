// @effect-diagnostics globalConsole:off nodeBuiltinImport:off -- Operator-only database verification adapts the PostgreSQL driver at the infrastructure edge; expires: 2027-03-31.
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { Array as EffectArray, Console, Effect, Order, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';

import { PRICING_SCHEMA_NAME, PRICING_TABLE_INVENTORY } from '../src/database/schema.ts';

class PricingSchemaVerificationError extends Schema.TaggedError<PricingSchemaVerificationError>()(
  'PricingSchemaVerificationError',
  { reason: Schema.String },
) {}

interface InfrastructureRow {
  readonly forced_rls_count: number;
  readonly journal_count: number;
  readonly policy_count: number;
  readonly runtime_routine_count: number;
  readonly runtime_schema_create: boolean;
  readonly runtime_schema_usage: boolean;
  readonly runtime_table_access_count: number;
  readonly unsafe_runtime_table_privilege_count: number;
}

const verification = Effect.gen(function* verifyPricingDatabase() {
  const configuration = yield* loadDatabaseConnectionPair();
  const client = yield* PgClient.makeClient({ url: Redacted.make(configuration.admin.connectionString) }).pipe(
    Effect.mapError(() => new PricingSchemaVerificationError({ reason: 'Unable to connect to the Pricing database' })),
  );
  const tables = yield* client
    .unsafe<{ readonly table_name: string }>(
      `select table_name
           from information_schema.tables
          where table_schema = $1 and table_type = 'BASE TABLE'
          order by table_name`,
      [PRICING_SCHEMA_NAME],
    )
    .pipe(Effect.mapError(() => new PricingSchemaVerificationError({ reason: 'Unable to inspect Pricing tables' })));
  const actualTables = EffectArray.sort(
    tables.map(({ table_name }) => table_name),
    Order.String,
  );
  const expectedTables = EffectArray.sort([...PRICING_TABLE_INVENTORY], Order.String);
  if (
    actualTables.length !== expectedTables.length ||
    actualTables.some((table, index) => table !== expectedTables[index])
  ) {
    return yield* new PricingSchemaVerificationError({ reason: 'Pricing table inventory mismatch' });
  }
  const infrastructure = yield* client
    .unsafe<InfrastructureRow>(
      `select
           has_schema_privilege('ontos_runtime', $1, 'USAGE') as runtime_schema_usage,
           has_schema_privilege('ontos_runtime', $1, 'CREATE') as runtime_schema_create,
           (select count(*)::integer
              from pg_catalog.pg_class as relation
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relname = 'currency_support_revisions'
               and has_table_privilege('ontos_runtime', relation.oid, 'SELECT')
               and has_table_privilege('ontos_runtime', relation.oid, 'INSERT')
               and has_table_privilege('ontos_runtime', relation.oid, 'UPDATE')) as runtime_table_access_count,
           (select count(*)::integer
              from pg_catalog.pg_class as relation
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relkind in ('r', 'p')
               and has_table_privilege('ontos_runtime', relation.oid,
                 'DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN, SELECT WITH GRANT OPTION, INSERT WITH GRANT OPTION, UPDATE WITH GRANT OPTION'))
             as unsafe_runtime_table_privilege_count,
           (select count(*)::integer
              from pg_catalog.pg_class as relation
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relkind in ('r', 'p')
               and relation.relrowsecurity and relation.relforcerowsecurity) as forced_rls_count,
           (select count(*)::integer
              from pg_catalog.pg_class as journal
              join pg_catalog.pg_namespace as namespace on namespace.oid = journal.relnamespace
             where namespace.nspname = 'drizzle'
               and journal.relname = '__drizzle_migrations_pricing') as journal_count,
           (select count(*)::integer
              from pg_catalog.pg_policy as policy
              join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1) as policy_count,
           (select count(*)::integer
              from pg_catalog.pg_proc as routine
              join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = $1
               and routine.proname in ('read_current_supported_currencies', 'set_supported_currencies')
               and has_function_privilege('ontos_runtime', routine.oid, 'EXECUTE')) as runtime_routine_count`,
      [PRICING_SCHEMA_NAME],
    )
    .pipe(
      Effect.mapError(
        () => new PricingSchemaVerificationError({ reason: 'Unable to inspect Pricing database infrastructure' }),
      ),
    );
  const [row] = infrastructure;
  if (
    row === undefined ||
    row.forced_rls_count !== PRICING_TABLE_INVENTORY.length ||
    row.journal_count !== 1 ||
    row.policy_count !== 4 ||
    row.runtime_routine_count !== 2 ||
    !row.runtime_schema_usage ||
    row.runtime_schema_create ||
    row.runtime_table_access_count !== 1 ||
    row.unsafe_runtime_table_privilege_count !== 0
  ) {
    return yield* new PricingSchemaVerificationError({
      reason: 'Pricing RLS, policy, journal, runtime privilege, or routine inventory mismatch',
    });
  }
  return { tableCount: actualTables.length };
});

await Effect.runPromise(
  Effect.scoped(verification).pipe(
    Effect.provide(Reactivity.layer),
    Effect.tap(({ tableCount }) =>
      Console.log(`Verified ${tableCount} tables in PostgreSQL schema ${PRICING_SCHEMA_NAME}`),
    ),
  ),
);
