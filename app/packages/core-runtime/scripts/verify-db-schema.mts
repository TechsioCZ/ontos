// @effect-diagnostics processEnv:off globalConsole:off strictEffectProvide:off -- Existing compatibility boundary; expires: 2026-12-31.
import { getTableName, sql } from 'drizzle-orm';
import type { EffectDrizzleQueryError } from 'drizzle-orm/effect-core';
import { Effect, Layer, Schema } from 'effect';

import type { CatalogEntry } from '../src/db/catalog.ts';
import { compareApplicationCatalog } from '../src/db/catalog.ts';
import { CoreDatabase, CoreDatabaseLive } from '../src/db/client.ts';
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
  }
) {}

const CatalogRowSchema = Schema.Struct({
  kind: Schema.Literals(['migration', 'table']),
  schema_name: Schema.String,
  table_name: Schema.Union([Schema.Null, Schema.String]),
});
type CatalogRow = typeof CatalogRowSchema.Type;

const RuntimeRoleRowSchema = Schema.Struct({
  rolbypassrls: Schema.Boolean,
  rolsuper: Schema.Boolean,
});
type RuntimeRoleRow = typeof RuntimeRoleRowSchema.Type;

const isUnsafeRuntimeRole = (role: RuntimeRoleRow | undefined): boolean =>
  role === undefined || role.rolsuper || role.rolbypassrls;

const verifyTypedQuery = <Result,>(
  tableName: string,
  query: () => Effect.Effect<Result, EffectDrizzleQueryError>
): Effect.Effect<void, DatabaseVerificationError> =>
  query().pipe(
    Effect.mapError(
      () =>
        new DatabaseVerificationError({
          reason: `Typed verification failed for ${CORE_SCHEMA_NAME}.${tableName}`,
        })
    ),
    Effect.asVoid
  );

const verifyRuntimeRole = Effect.gen(function* verifyRuntimeRoleEffect() {
  const database = yield* CoreDatabase;
  const runtimeRole = yield* database.executor
    .execute<RuntimeRoleRow>(
      sql`
        select role.rolsuper, role.rolbypassrls
        from pg_catalog.pg_roles as role
        where role.rolname = current_user
      `,
      'objects'
    )
    .pipe(
      Effect.mapError(
        () =>
          new DatabaseVerificationError({
            reason: 'Unable to verify the PostgreSQL runtime role',
          })
      )
    );
  const [role] = runtimeRole;
  if (isUnsafeRuntimeRole(role)) {
    return yield* new DatabaseVerificationError({
      reason:
        'The application runtime role must be non-superuser and must not bypass RLS',
    });
  }
  return yield* Effect.void;
});

const verifySearchIsolation = Effect.gen(
  function* verifySearchIsolationEffect() {
    const database = yield* CoreDatabase;
    for (const [tableName, operations] of [
      ['search_index_entries', ['delete', 'insert', 'select', 'update']],
      ['search_projection_generations', ['insert', 'select', 'update']],
      ['search_projection_rebuilds', ['insert', 'select', 'update']],
    ] as const) {
      const searchIsolation = yield* database.executor
        .execute<{
          policy_names: string[];
          relforcerowsecurity: boolean;
          relrowsecurity: boolean;
        }>(
          sql`
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
      `,
          'objects'
        )
        .pipe(
          Effect.mapError(
            () =>
              new DatabaseVerificationError({
                reason: 'Unable to verify Core Search tenant isolation',
              })
          )
        );
      const [searchIsolationRow] = searchIsolation;
      const expectedSearchPolicies = operations.map(
        (operation) => `core_${tableName}_tenant_${operation}`
      );
      if (
        searchIsolationRow === undefined ||
        !searchIsolationRow.relrowsecurity ||
        !searchIsolationRow.relforcerowsecurity ||
        searchIsolationRow.policy_names.length !==
          expectedSearchPolicies.length ||
        searchIsolationRow.policy_names.some(
          (policy, index) => policy !== expectedSearchPolicies[index]
        )
      ) {
        return yield* new DatabaseVerificationError({
          reason:
            'Core Search must enforce forced tenant RLS with complete owner-operation policies',
        });
      }
    }
    return yield* Effect.void;
  }
);

const verifyCatalog = Effect.gen(function* verifyCatalogEffect() {
  const database = yield* CoreDatabase;
  // Necessary migration-verification exception: Drizzle has no typed builder
  // for PostgreSQL catalog metadata. Values stay parameterized and the query is
  // covered by exact-set mismatch tests.
  const catalogResult = yield* database.executor
    .execute<CatalogRow>(
      sql`
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
      `,
      'objects'
    )
    .pipe(
      Effect.mapError(
        () =>
          new DatabaseVerificationError({
            reason: 'Unable to compare the PostgreSQL application catalog',
          })
      )
    );

  const entries: CatalogEntry[] = [];
  const migrationBookkeepingTables: string[] = [];

  for (const row of catalogResult) {
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
    migrationBookkeepingTables.length !==
      expectedMigrationBookkeepingTables.length ||
    migrationBookkeepingTables.some(
      (tableName, index) =>
        tableName !== expectedMigrationBookkeepingTables[index]
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
  return yield* Effect.void;
});

const verifyDatabase = Effect.gen(function* verifyDatabaseEffect() {
  const database = yield* CoreDatabase;
  yield* verifyRuntimeRole;
  yield* verifySearchIsolation;
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
  const constraintRows = yield* database.executor
    .execute<{ conname: string }>(
      sql`
        select constraint_record.conname
        from pg_catalog.pg_constraint as constraint_record
        inner join pg_catalog.pg_namespace as namespace
          on namespace.oid = constraint_record.connamespace
        where namespace.nspname = ${CORE_SCHEMA_NAME}
        order by constraint_record.conname
      `,
      'objects'
    )
    .pipe(
      Effect.mapError(
        () =>
          new DatabaseVerificationError({
            reason: 'Unable to verify same-tenant constraints',
          })
      )
    );
  const presentCompositeConstraints = constraintRows
    .map((row) => row.conname)
    .filter((name) => requiredCompositeConstraints.includes(name))
    .toSorted();
  if (
    presentCompositeConstraints.length !==
      requiredCompositeConstraints.length ||
    presentCompositeConstraints.some(
      (name, index) => name !== requiredCompositeConstraints[index]
    )
  ) {
    return yield* new DatabaseVerificationError({
      reason: 'Required composite same-tenant constraints are missing',
    });
  }
  const typedQueries = [
    tenants,
    legalEntities,
    principals,
    principalAuthBindings,
    tenantModuleStates,
    actionInvocations,
    tenantModuleStateChanges,
    auditEvents,
    dataAccessEvents,
    domainEvents,
    outboxMessages,
    outboxDeliveries,
    outboxAttempts,
    mediaAssets,
    mediaLinks,
    evidenceReferences,
    searchIndexEntries,
    searchProjectionGenerations,
    searchProjectionRebuilds,
    workerCheckpoints,
  ].map((table) =>
    verifyTypedQuery(getTableName(table), () =>
      database.executor.select().from(table).limit(0)
    )
  );

  for (const query of typedQueries) {
    yield* query;
  }

  yield* verifyCatalog;

  return {
    tableCount: typedQueries.length,
  };
});

const DatabaseRuntimeLive = CoreDatabaseLive.pipe(
  Layer.provide(DatabaseConfigLive)
);
const result = await Effect.runPromise(
  Effect.provide(verifyDatabase, DatabaseRuntimeLive)
);

console.log(
  `Verified ${result.tableCount} typed tables in PostgreSQL schema ${CORE_SCHEMA_NAME}`
);
