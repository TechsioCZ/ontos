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
  readonly kind: 'migration' | 'schema' | 'table';
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
        with user_schemas as (
          select namespace.oid, namespace.nspname
          from pg_catalog.pg_namespace as namespace
          where namespace.nspname <> ${'information_schema'}
            and namespace.nspname not like ${'pg\\_%'}
        ),
        auth_tables as (
          select
            ${'table'}::text as kind,
            user_schemas.nspname as schema_name,
            relation.relname as table_name
          from user_schemas
          inner join pg_catalog.pg_class as relation
            on relation.relnamespace = user_schemas.oid
          where relation.relkind in (${'r'}, ${'p'})
            and user_schemas.nspname = ${AUTH_SCHEMA_NAME}
        ),
        unexpected_schemas as (
          select
            ${'schema'}::text as kind,
            user_schemas.nspname as schema_name,
            null::text as table_name
          from user_schemas
          where user_schemas.nspname not in (
            ${AUTH_SCHEMA_NAME},
            ${'core'},
            ${'drizzle'},
            ${'public'}
          )
        ),
        migration_bookkeeping as (
          select
            ${'migration'}::text as kind,
            user_schemas.nspname as schema_name,
            relation.relname as table_name
          from user_schemas
          inner join pg_catalog.pg_class as relation
            on relation.relnamespace = user_schemas.oid
          where relation.relkind = ${'r'}
            and user_schemas.nspname = ${'drizzle'}
        )
        select kind, schema_name, table_name from auth_tables
        union all
        select kind, schema_name, table_name from unexpected_schemas
        union all
        select kind, schema_name, table_name from migration_bookkeeping
        order by kind, schema_name, table_name
      `),
  });

  const tableNames: string[] = [];
  const unexpectedSchemas: string[] = [];
  const migrationBookkeepingTables: string[] = [];

  for (const row of catalog.rows) {
    if (row.kind === 'migration') {
      if (row.table_name !== null) {
        migrationBookkeepingTables.push(row.table_name);
      }
    } else if (row.kind === 'schema') {
      unexpectedSchemas.push(row.schema_name);
    } else if (row.table_name !== null) {
      tableNames.push(`${row.schema_name}.${row.table_name}`);
    }
  }

  const expectedMigrationBookkeepingTables = [
    '__drizzle_migrations_auth',
    '__drizzle_migrations_core',
  ];
  migrationBookkeepingTables.sort();
  const difference = compareAuthCatalog(tableNames);
  if (
    JSON.stringify(migrationBookkeepingTables) !==
      JSON.stringify(expectedMigrationBookkeepingTables) ||
    unexpectedSchemas.length > 0 ||
    difference.missing.length > 0 ||
    difference.unexpected.length > 0
  ) {
    return yield* new AuthDatabaseVerificationError({
      reason: `Auth catalog mismatch; missing=[${difference.missing.join(', ')}], unexpected=[${[
        ...difference.unexpected,
        ...unexpectedSchemas,
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
