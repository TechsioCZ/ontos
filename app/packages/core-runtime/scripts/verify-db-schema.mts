// @effect-diagnostics processEnv:off globalConsole:off strictEffectProvide:off
import { sql } from 'drizzle-orm';
import { Effect, Layer, Schema } from 'effect';
import { CoreDatabase, CoreDatabaseLive } from '../src/db/client.ts';
import { compareApplicationCatalog } from '../src/db/catalog.ts';
import type { CatalogEntry } from '../src/db/catalog.ts';
import { DatabaseConfigLive } from '../src/db/config.ts';
import {
  CORE_SCHEMA_NAME,
  actionInvocations,
  auditEvents,
  dataAccessEvents,
  domainEvents,
  evidenceReferences,
  legalEntities,
  mediaAssets,
  mediaLinks,
  outboxAttempts,
  outboxDeliveries,
  outboxMessages,
  principalAuthBindings,
  principals,
  searchIndexEntries,
  tenantModuleStateChanges,
  tenantModuleStates,
  tenants,
  workerCheckpoints,
} from '../src/db/schema.ts';

class DatabaseVerificationError extends Schema.TaggedErrorClass<DatabaseVerificationError>()(
  'DatabaseVerificationError',
  {
    reason: Schema.String,
  },
) {}

type CatalogRow = Record<string, unknown> & {
  readonly kind: 'migration' | 'schema' | 'table';
  readonly schema_name: string;
  readonly table_name: null | string;
};

const verifyTypedQuery = (
  tableName: string,
  query: () => PromiseLike<unknown>,
): Effect.Effect<void, DatabaseVerificationError> =>
  Effect.tryPromise({
    catch: () =>
      new DatabaseVerificationError({
        reason: `Typed verification failed for ${CORE_SCHEMA_NAME}.${tableName}`,
      }),
    try: query,
  }).pipe(Effect.asVoid);

const verifyDatabase = Effect.gen(function* verifyDatabaseEffect() {
  const database = yield* CoreDatabase;
  const typedQueries = [
    verifyTypedQuery('tenants', () => database.executor.select().from(tenants).limit(0)),
    verifyTypedQuery('legal_entities', () =>
      database.executor.select().from(legalEntities).limit(0),
    ),
    verifyTypedQuery('principals', () => database.executor.select().from(principals).limit(0)),
    verifyTypedQuery('principal_auth_bindings', () =>
      database.executor.select().from(principalAuthBindings).limit(0),
    ),
    verifyTypedQuery('tenant_module_states', () =>
      database.executor.select().from(tenantModuleStates).limit(0),
    ),
    verifyTypedQuery('action_invocations', () =>
      database.executor.select().from(actionInvocations).limit(0),
    ),
    verifyTypedQuery('tenant_module_state_changes', () =>
      database.executor.select().from(tenantModuleStateChanges).limit(0),
    ),
    verifyTypedQuery('audit_events', () => database.executor.select().from(auditEvents).limit(0)),
    verifyTypedQuery('data_access_events', () =>
      database.executor.select().from(dataAccessEvents).limit(0),
    ),
    verifyTypedQuery('domain_events', () => database.executor.select().from(domainEvents).limit(0)),
    verifyTypedQuery('outbox_messages', () =>
      database.executor.select().from(outboxMessages).limit(0),
    ),
    verifyTypedQuery('outbox_deliveries', () =>
      database.executor.select().from(outboxDeliveries).limit(0),
    ),
    verifyTypedQuery('outbox_attempts', () =>
      database.executor.select().from(outboxAttempts).limit(0),
    ),
    verifyTypedQuery('media_assets', () => database.executor.select().from(mediaAssets).limit(0)),
    verifyTypedQuery('media_links', () => database.executor.select().from(mediaLinks).limit(0)),
    verifyTypedQuery('evidence_references', () =>
      database.executor.select().from(evidenceReferences).limit(0),
    ),
    verifyTypedQuery('search_index_entries', () =>
      database.executor.select().from(searchIndexEntries).limit(0),
    ),
    verifyTypedQuery('worker_checkpoints', () =>
      database.executor.select().from(workerCheckpoints).limit(0),
    ),
  ] as const;

  for (const query of typedQueries) {
    yield* query;
  }

  // Necessary migration-verification exception: Drizzle has no typed builder
  // for PostgreSQL catalog metadata. Values stay parameterized and the query is
  // covered by exact-set mismatch tests.
  const catalogResult = yield* Effect.tryPromise({
    catch: () =>
      new DatabaseVerificationError({
        reason: 'Unable to compare the PostgreSQL application catalog',
      }),
    try: () =>
      database.executor.execute<CatalogRow>(sql`
        with user_schemas as (
          select namespace.oid, namespace.nspname
          from pg_catalog.pg_namespace as namespace
          where namespace.nspname <> ${'information_schema'}
            and namespace.nspname not like ${'pg\\_%'}
        ),
        application_tables as (
          select
            ${'table'}::text as kind,
            user_schemas.nspname as schema_name,
            relation.relname as table_name
          from user_schemas
          inner join pg_catalog.pg_class as relation
            on relation.relnamespace = user_schemas.oid
          where relation.relkind in (${'r'}, ${'p'})
            and user_schemas.nspname = ${CORE_SCHEMA_NAME}
        ),
        unexpected_schemas as (
          select
            ${'schema'}::text as kind,
            user_schemas.nspname as schema_name,
            null::text as table_name
          from user_schemas
          where user_schemas.nspname not in (
            ${'auth'},
            ${CORE_SCHEMA_NAME},
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
        select kind, schema_name, table_name from application_tables
        union all
        select kind, schema_name, table_name from unexpected_schemas
        union all
        select kind, schema_name, table_name from migration_bookkeeping
        order by kind, schema_name, table_name
      `),
  });

  const entries: CatalogEntry[] = [];
  const migrationBookkeepingTables: string[] = [];

  for (const row of catalogResult.rows) {
    if (row.kind === 'migration') {
      if (row.table_name !== null) {
        migrationBookkeepingTables.push(row.table_name);
      }
      continue;
    }

    if (row.kind === 'schema') {
      entries.push({
        kind: 'schema',
        schemaName: row.schema_name,
        tableName: null,
      });
      continue;
    }

    if (row.table_name === null) {
      return yield* new DatabaseVerificationError({
        reason: `Catalog table ${row.schema_name} is missing its table name`,
      });
    }

    entries.push({
      kind: 'table',
      schemaName: row.schema_name,
      tableName: row.table_name,
    });
  }

  const expectedMigrationBookkeepingTables = [
    '__drizzle_migrations_auth',
    '__drizzle_migrations_core',
  ];
  migrationBookkeepingTables.sort();

  if (
    migrationBookkeepingTables.length !== expectedMigrationBookkeepingTables.length ||
    migrationBookkeepingTables.some(
      (tableName, index) => tableName !== expectedMigrationBookkeepingTables[index],
    )
  ) {
    return yield* new DatabaseVerificationError({
      reason: `Expected Drizzle migration bookkeeping tables [${expectedMigrationBookkeepingTables.join(', ')}], found [${migrationBookkeepingTables.join(', ')}]`,
    });
  }

  const difference = compareApplicationCatalog(entries);

  if (difference.missing.length > 0 || difference.unexpected.length > 0) {
    return yield* new DatabaseVerificationError({
      reason: `Core catalog mismatch; missing=[${difference.missing.join(', ')}], unexpected=[${difference.unexpected.join(', ')}]`,
    });
  }

  return {
    tableCount: typedQueries.length,
  };
});

const DatabaseRuntimeLive = CoreDatabaseLive.pipe(Layer.provide(DatabaseConfigLive));
const result = await Effect.runPromise(Effect.provide(verifyDatabase, DatabaseRuntimeLive));

console.log(`Verified ${result.tableCount} typed tables in PostgreSQL schema ${CORE_SCHEMA_NAME}`);
