// @effect-diagnostics asyncFunction:off globalConsole:off nodeBuiltinImport:off -- Operator-only database verification adapts the PostgreSQL driver at the infrastructure edge; expires: 2027-03-31.
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { Array as EffectArray, Console, Effect, Order, Schema } from 'effect';
import { Client } from 'pg';

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
}

const verification = Effect.gen(function* verifyPricingDatabase() {
  const configuration = yield* loadDatabaseConnectionPair();
  const client = yield* Effect.acquireRelease(
    Effect.tryPromise({
      catch: () => new PricingSchemaVerificationError({ reason: 'Unable to connect to the Pricing database' }),
      try: async () => {
        const connection = new Client({ connectionString: configuration.admin.connectionString });
        await connection.connect();
        return connection;
      },
    }),
    (connection) => Effect.promise(async () => await connection.end()),
  );
  const tables = yield* Effect.tryPromise({
    catch: () => new PricingSchemaVerificationError({ reason: 'Unable to inspect Pricing tables' }),
    try: async () =>
      await client.query<{ readonly table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = $1 and table_type = 'BASE TABLE'
          order by table_name`,
        [PRICING_SCHEMA_NAME],
      ),
  });
  const actualTables = EffectArray.sort(
    tables.rows.map(({ table_name }) => table_name),
    Order.String,
  );
  const expectedTables = EffectArray.sort([...PRICING_TABLE_INVENTORY], Order.String);
  if (
    actualTables.length !== expectedTables.length ||
    actualTables.some((table, index) => table !== expectedTables[index])
  ) {
    return yield* new PricingSchemaVerificationError({ reason: 'Pricing table inventory mismatch' });
  }
  const infrastructure = yield* Effect.tryPromise({
    catch: () => new PricingSchemaVerificationError({ reason: 'Unable to inspect Pricing database infrastructure' }),
    try: async () =>
      await client.query<InfrastructureRow>(
        `select
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
      ),
  });
  const [row] = infrastructure.rows;
  if (
    row === undefined ||
    row.forced_rls_count !== PRICING_TABLE_INVENTORY.length ||
    row.journal_count !== 1 ||
    row.policy_count !== 4 ||
    row.runtime_routine_count !== 2
  ) {
    return yield* new PricingSchemaVerificationError({
      reason: 'Pricing RLS, policy, journal, or routine inventory mismatch',
    });
  }
  return { tableCount: actualTables.length };
});

await Effect.runPromise(
  Effect.scoped(verification).pipe(
    Effect.tap(({ tableCount }) =>
      Console.log(`Verified ${tableCount} tables in PostgreSQL schema ${PRICING_SCHEMA_NAME}`),
    ),
  ),
);
