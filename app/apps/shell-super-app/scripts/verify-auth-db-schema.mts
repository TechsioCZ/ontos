// @effect-diagnostics globalConsole:off processEnv:off strictEffectProvide:off
import { sql } from 'drizzle-orm';
import { Effect, Layer, Schema } from 'effect';
import { AuthConfigLive } from '../api/auth/config.ts';
import { AuthDatabase, AuthDatabaseLive } from '../api/auth/db/client.ts';
import { compareAuthCatalog } from '../api/auth/db/catalog.ts';
import { AUTH_SCHEMA_NAME, AUTH_TABLES } from '../api/auth/db/schema.ts';

class AuthDatabaseVerificationError extends Schema.TaggedErrorClass<AuthDatabaseVerificationError>()(
  'AuthDatabaseVerificationError',
  {
    reason: Schema.String,
  },
) {}

type CatalogRow = Record<string, unknown> & {
  readonly kind: 'migration' | 'table';
  readonly schema_name: string;
  readonly table_name: null | string;
};

const verification = Effect.gen(function* verifyAuthDatabase() {
  const database = yield* AuthDatabase;

  for (const table of AUTH_TABLES) {
    yield* Effect.tryPromise({
      catch: () =>
        new AuthDatabaseVerificationError({
          reason: `Typed verification failed for one ${AUTH_SCHEMA_NAME} table`,
        }),
      try: () => database.executor.select().from(table).limit(0),
    });
  }

  const catalog = yield* Effect.tryPromise({
    catch: () =>
      new AuthDatabaseVerificationError({
        reason: 'Unable to compare the PostgreSQL authentication catalog',
      }),
    try: () =>
      database.executor.execute<CatalogRow>(sql`
        with auth_tables as (
          select
            ${'table'}::text as kind,
            namespace.nspname as schema_name,
            relation.relname as table_name
          from pg_catalog.pg_namespace as namespace
          inner join pg_catalog.pg_class as relation
            on relation.relnamespace = namespace.oid
          where relation.relkind in (${'r'}, ${'p'})
            and namespace.nspname = ${AUTH_SCHEMA_NAME}
        ),
        migration_bookkeeping as (
          select
            ${'migration'}::text as kind,
            namespace.nspname as schema_name,
            relation.relname as table_name
          from pg_catalog.pg_namespace as namespace
          inner join pg_catalog.pg_class as relation
            on relation.relnamespace = namespace.oid
          where relation.relkind = ${'r'}
            and namespace.nspname = ${'drizzle'}
            and relation.relname = ${'__drizzle_migrations_auth'}
        )
        select kind, schema_name, table_name from auth_tables
        union all
        select kind, schema_name, table_name from migration_bookkeeping
        order by kind, schema_name, table_name
      `),
  });

  const tableNames: string[] = [];
  const migrationBookkeepingTables: string[] = [];

  for (const row of catalog.rows) {
    if (row.kind === 'migration') {
      if (row.table_name !== null) {
        migrationBookkeepingTables.push(row.table_name);
      }
    } else if (row.table_name !== null) {
      tableNames.push(`${row.schema_name}.${row.table_name}`);
    }
  }

  const expectedMigrationBookkeepingTables = ['__drizzle_migrations_auth'];
  migrationBookkeepingTables.sort();
  const difference = compareAuthCatalog(tableNames);
  if (
    JSON.stringify(migrationBookkeepingTables) !==
      JSON.stringify(expectedMigrationBookkeepingTables) ||
    difference.missing.length > 0 ||
    difference.unexpected.length > 0
  ) {
    return yield* new AuthDatabaseVerificationError({
      reason: `Auth catalog mismatch; missing=[${difference.missing.join(', ')}], unexpected=[${[
        ...difference.unexpected,
      ].join(', ')}], migrationTables=[${migrationBookkeepingTables.join(', ')}]`,
    });
  }

  return {
    tableCount: AUTH_TABLES.length,
  };
});

const runtime = AuthDatabaseLive.pipe(Layer.provide(AuthConfigLive));
const result = await Effect.runPromise(Effect.provide(verification, runtime));

console.log(`Verified ${result.tableCount} typed tables in PostgreSQL schema ${AUTH_SCHEMA_NAME}`);
