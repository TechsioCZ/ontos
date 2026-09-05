// @effect-diagnostics processEnv:off globalConsole:off strictEffectProvide:off
/* eslint-disable complexity -- One verifier keeps the full fail-closed Core catalog gate visible and auditable. */
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
  searchProjectionGenerations,
  searchProjectionRebuilds,
  tenantModuleStateChanges,
  tenantModuleStates,
  tenants,
  workerCheckpoints,
} from '../src/db/schema.ts';

class DatabaseVerificationError extends Schema.TaggedError<DatabaseVerificationError>()(
  'DatabaseVerificationError',
  {
    reason: Schema.String,
  },
) {}

type CatalogRow = Readonly<Record<string, string | null>> & {
  readonly kind: 'migration' | 'table';
  readonly schema_name: string;
  readonly table_name: null | string;
};

const verifyTypedQuery = <Result,>(
  tableName: string,
  query: () => PromiseLike<Result>,
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
  const runtimeRole = yield* Effect.tryPromise({
    catch: () =>
      new DatabaseVerificationError({ reason: 'Unable to verify the PostgreSQL runtime role' }),
    try: () =>
      database.executor.execute<{
        rolbypassrls: boolean;
        rolsuper: boolean;
      }>(sql`
        select role.rolsuper, role.rolbypassrls
        from pg_catalog.pg_roles as role
        where role.rolname = current_user
      `),
  });
  const [role] = runtimeRole.rows;
  if (role === undefined || role.rolsuper || role.rolbypassrls) {
    return yield* new DatabaseVerificationError({
      reason: 'The application runtime role must be non-superuser and must not bypass RLS',
    });
  }

  for (const [tableName, operations] of [
    ['search_index_entries', ['delete', 'insert', 'select', 'update']],
    ['search_projection_generations', ['insert', 'select', 'update']],
    ['search_projection_rebuilds', ['insert', 'select', 'update']],
  ] as const) {
    const searchIsolation = yield* Effect.tryPromise({
      catch: () =>
        new DatabaseVerificationError({ reason: 'Unable to verify Core Search tenant isolation' }),
      try: () =>
        database.executor.execute<{
          policy_names: string[];
          relforcerowsecurity: boolean;
          relrowsecurity: boolean;
        }>(sql`
        select
          relation.relrowsecurity,
          relation.relforcerowsecurity,
          coalesce(array_agg(policy.policyname::text order by policy.policyname)
            filter (where policy.policyname is not null), array[]::text[]) as policy_names
        from pg_catalog.pg_class as relation
        inner join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
        left join pg_catalog.pg_policies as policy
          on policy.schemaname = namespace.nspname and policy.tablename = relation.relname
        where namespace.nspname = ${CORE_SCHEMA_NAME}
          and relation.relname = ${tableName}
        group by relation.relrowsecurity, relation.relforcerowsecurity
      `),
    });
    const [searchIsolationRow] = searchIsolation.rows;
    const expectedSearchPolicies = operations.map(
      (operation) => `core_${tableName}_tenant_${operation}`,
    );
    if (
      searchIsolationRow === undefined ||
      !searchIsolationRow.relrowsecurity ||
      !searchIsolationRow.relforcerowsecurity ||
      searchIsolationRow.policy_names.length !== expectedSearchPolicies.length ||
      searchIsolationRow.policy_names.some(
        (policy, index) => policy !== expectedSearchPolicies[index],
      )
    ) {
      return yield* new DatabaseVerificationError({
        reason: 'Core Search must enforce forced tenant RLS with complete owner-operation policies',
      });
    }
  }

  const requiredCompositeConstraints = [
    'core_action_invocations_tenant_auth_binding_fk',
    'core_action_invocations_tenant_impersonator_fk',
    'core_action_invocations_tenant_legal_entity_fk',
    'core_action_invocations_tenant_principal_fk',
    'core_audit_events_tenant_auth_binding_fk',
    'core_audit_events_tenant_impersonator_fk',
    'core_audit_events_tenant_invocation_fk',
    'core_audit_events_tenant_legal_entity_fk',
    'core_audit_events_tenant_principal_fk',
    'core_auth_bindings_tenant_principal_fk',
    'core_data_access_events_tenant_auth_binding_fk',
    'core_data_access_events_tenant_impersonator_fk',
    'core_data_access_events_tenant_invocation_fk',
    'core_data_access_events_tenant_legal_entity_fk',
    'core_data_access_events_tenant_principal_fk',
    'core_domain_events_tenant_invocation_fk',
    'core_domain_events_tenant_legal_entity_fk',
    'core_evidence_tenant_asset_fk',
    'core_evidence_tenant_audit_fk',
    'core_evidence_tenant_data_access_fk',
    'core_evidence_tenant_domain_event_fk',
    'core_evidence_tenant_invocation_fk',
    'core_evidence_tenant_legal_entity_fk',
    'core_media_assets_tenant_legal_entity_fk',
    'core_media_assets_tenant_principal_fk',
    'core_media_links_tenant_asset_fk',
    'core_media_links_tenant_invocation_fk',
    'core_media_links_tenant_principal_fk',
    'core_module_state_changes_tenant_invocation_fk',
    'core_module_state_changes_tenant_principal_fk',
    'core_outbox_messages_tenant_domain_event_fk',
    'core_search_index_entries_tenant_legal_entity_fk',
  ].toSorted();
  const constraintRows = yield* Effect.tryPromise({
    catch: () =>
      new DatabaseVerificationError({ reason: 'Unable to verify same-tenant constraints' }),
    try: () =>
      database.executor.execute<{ conname: string }>(sql`
        select constraint_record.conname
        from pg_catalog.pg_constraint as constraint_record
        inner join pg_catalog.pg_namespace as namespace
          on namespace.oid = constraint_record.connamespace
        where namespace.nspname = ${CORE_SCHEMA_NAME}
        order by constraint_record.conname
      `),
  });
  const presentCompositeConstraints = constraintRows.rows
    .map((row) => row.conname)
    .filter((name) => requiredCompositeConstraints.includes(name))
    .toSorted();
  if (
    presentCompositeConstraints.length !== requiredCompositeConstraints.length ||
    presentCompositeConstraints.some((name, index) => name !== requiredCompositeConstraints[index])
  ) {
    return yield* new DatabaseVerificationError({
      reason: 'Required composite same-tenant constraints are missing',
    });
  }
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
    verifyTypedQuery('search_projection_generations', () =>
      database.executor.select().from(searchProjectionGenerations).limit(0),
    ),
    verifyTypedQuery('search_projection_rebuilds', () =>
      database.executor.select().from(searchProjectionRebuilds).limit(0),
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
        with application_tables as (
          select
            ${'table'}::text as kind,
            namespace.nspname as schema_name,
            relation.relname as table_name
          from pg_catalog.pg_namespace as namespace
          inner join pg_catalog.pg_class as relation
            on relation.relnamespace = namespace.oid
          where relation.relkind in (${'r'}, ${'p'})
            and namespace.nspname = ${CORE_SCHEMA_NAME}
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
            and relation.relname = ${'__drizzle_migrations_core'}
        )
        select kind, schema_name, table_name from application_tables
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

  const expectedMigrationBookkeepingTables = ['__drizzle_migrations_core'];
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
