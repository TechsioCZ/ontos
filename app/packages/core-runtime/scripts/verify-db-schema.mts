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

class DatabaseVerificationError extends Schema.TaggedError<DatabaseVerificationError>()('DatabaseVerificationError', {
  reason: Schema.String,
}) {}

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
  query: () => Effect.Effect<Result, EffectDrizzleQueryError>,
): Effect.Effect<void, DatabaseVerificationError> =>
  query().pipe(
    Effect.mapError(
      () =>
        new DatabaseVerificationError({
          reason: `Typed verification failed for ${CORE_SCHEMA_NAME}.${tableName}`,
        }),
    ),
    Effect.asVoid,
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
      'objects',
    )
    .pipe(
      Effect.mapError(
        () =>
          new DatabaseVerificationError({
            reason: 'Unable to verify the PostgreSQL runtime role',
          }),
      ),
    );
  const [role] = runtimeRole;
  if (isUnsafeRuntimeRole(role)) {
    return yield* new DatabaseVerificationError({
      reason: 'The application runtime role must be non-superuser and must not bypass RLS',
    });
  }
  return yield* Effect.void;
});

const verifySearchIsolation = Effect.gen(function* verifySearchIsolationEffect() {
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
        'objects',
      )
      .pipe(
        Effect.mapError(
          () =>
            new DatabaseVerificationError({
              reason: 'Unable to verify Core Search tenant isolation',
            }),
        ),
      );
    const [searchIsolationRow] = searchIsolation;
    const expectedSearchPolicies = operations.map((operation) => `core_${tableName}_tenant_${operation}`);
    if (
      searchIsolationRow === undefined ||
      !searchIsolationRow.relrowsecurity ||
      !searchIsolationRow.relforcerowsecurity ||
      searchIsolationRow.policy_names.length !== expectedSearchPolicies.length ||
      searchIsolationRow.policy_names.some((policy, index) => policy !== expectedSearchPolicies[index])
    ) {
      return yield* new DatabaseVerificationError({
        reason: 'Core Search must enforce forced tenant RLS with complete owner-operation policies',
      });
    }
  }
  return yield* Effect.void;
});

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
      'objects',
    )
    .pipe(
      Effect.mapError(
        () =>
          new DatabaseVerificationError({
            reason: 'Unable to compare the PostgreSQL application catalog',
          }),
      ),
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
    migrationBookkeepingTables.length !== expectedMigrationBookkeepingTables.length ||
    migrationBookkeepingTables.some((tableName, index) => tableName !== expectedMigrationBookkeepingTables[index])
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

const EXPECTED_COMPOSITE_CONSTRAINTS = [
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

const EXPECTED_AUTH_CONSTRAINTS = [
  'core_auth_bindings_tenant_principal_fk',
  'core_auth_bindings_provider_ck',
  'core_auth_bindings_namespace_ck',
  'core_auth_bindings_subject_type_ck',
  'core_auth_bindings_subject_id_ck',
  'core_auth_bindings_status_ck',
  'core_auth_bindings_revision_ck',
  'core_auth_bindings_lifecycle_ck',
].toSorted();

const EXPECTED_AUTH_COLUMNS = [
  { columnName: 'authentication_namespace_id', dataType: 'text', isNullable: 'NO' },
  { columnName: 'provider', dataType: 'text', isNullable: 'NO' },
  { columnName: 'binding_revision', dataType: 'integer', isNullable: 'NO' },
  { columnName: 'provider_subject_id', dataType: 'text', isNullable: 'NO' },
  { columnName: 'created_by_invocation_id', dataType: 'uuid', isNullable: 'YES' },
  { columnName: 'last_transition_ref', dataType: 'uuid', isNullable: 'YES' },
] as const;

const EXPECTED_AUTH_INDEXES = [
  {
    columns: ['tenant_id', 'principal_auth_binding_id'],
    name: 'core_auth_bindings_tenant_id_uk',
    predicate: null,
    unique: true,
  },
  {
    columns: ['tenant_id', 'authentication_namespace_id', 'subject_type', 'provider_subject_id'],
    name: 'core_auth_bindings_namespace_subject_uk',
    predicate: null,
    unique: true,
  },
  {
    columns: ['provider', 'subject_type', 'provider_subject_id'],
    name: 'core_auth_bindings_api_key_subject_global_uk',
    predicate: `subject_type = 'api_key'`,
    unique: true,
  },
  {
    columns: ['principal_id'],
    name: 'core_auth_bindings_principal_idx',
    predicate: null,
    unique: false,
  },
] as const;

const normalizeIndexPredicate = (predicate: string | null): string | null =>
  predicate === null
    ? null
    : predicate
        .replaceAll('"', '')
        .replaceAll('(', '')
        .replaceAll(')', '')
        .replaceAll('::text', '')
        .replaceAll(/\s+/gu, ' ')
        .trim()
        .toLowerCase();

const verifyCoreConstraints = Effect.gen(function* verifyCoreConstraintsEffect() {
  const database = yield* CoreDatabase;
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
      'objects',
    )
    .pipe(
      Effect.mapError(
        () =>
          new DatabaseVerificationError({
            reason: 'Unable to verify same-tenant constraints',
          }),
      ),
    );
  const presentCompositeConstraints = constraintRows
    .map((row) => row.conname)
    .filter((name) => EXPECTED_COMPOSITE_CONSTRAINTS.includes(name))
    .toSorted();
  if (
    presentCompositeConstraints.length !== EXPECTED_COMPOSITE_CONSTRAINTS.length ||
    presentCompositeConstraints.some((name, index) => name !== EXPECTED_COMPOSITE_CONSTRAINTS[index])
  ) {
    return yield* new DatabaseVerificationError({
      reason: 'Required composite same-tenant constraints are missing',
    });
  }

  const actualAuthConstraints = constraintRows
    .map((row) => row.conname)
    .filter((name) => name.startsWith('core_auth_bindings_'))
    .toSorted();
  if (
    actualAuthConstraints.length !== EXPECTED_AUTH_CONSTRAINTS.length ||
    actualAuthConstraints.some((name, index) => name !== EXPECTED_AUTH_CONSTRAINTS[index])
  ) {
    return yield* new DatabaseVerificationError({
      reason: 'Core authentication binding constraints are missing or unexpected',
    });
  }
  return yield* Effect.void;
});

const verifyAuthBindingColumns = Effect.gen(function* verifyAuthBindingColumnsEffect() {
  const database = yield* CoreDatabase;
  const authColumnRows = yield* database.executor
    .execute<{
      column_default: string | null;
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      sql`
        select column_name, is_nullable, data_type, column_default
        from information_schema.columns
        where table_schema = ${CORE_SCHEMA_NAME}
          and table_name = ${getTableName(principalAuthBindings)}
        order by ordinal_position
      `,
      'objects',
    )
    .pipe(
      Effect.mapError(
        () =>
          new DatabaseVerificationError({
            reason: 'Unable to verify Core authentication binding columns',
          }),
      ),
    );
  const authColumns = new Map(authColumnRows.map((row) => [row.column_name, row]));
  const requiredColumnsMatch = EXPECTED_AUTH_COLUMNS.every(({ columnName, dataType, isNullable }) => {
    const column = authColumns.get(columnName);
    return column !== undefined && column.data_type === dataType && column.is_nullable === isNullable;
  });
  const namespaceColumn = authColumns.get('authentication_namespace_id');
  const revisionColumn = authColumns.get('binding_revision');
  const normalizedRevisionDefault = revisionColumn?.column_default
    ?.replaceAll('::integer', '')
    .replaceAll('(', '')
    .replaceAll(')', '')
    .trim();
  if (!requiredColumnsMatch || namespaceColumn?.column_default !== null || normalizedRevisionDefault !== '1') {
    return yield* new DatabaseVerificationError({
      reason:
        'Core authentication binding namespace, revision, or subject columns have incompatible nullability or types',
    });
  }
  return yield* Effect.void;
});

const verifyAuthBindingIndexes = Effect.gen(function* verifyAuthBindingIndexesEffect() {
  const database = yield* CoreDatabase;
  const authIndexRows = yield* database.executor
    .execute<{
      column_names: string[];
      index_name: string;
      is_unique: boolean;
      predicate: string | null;
    }>(
      sql`
        select
          index_relation.relname as index_name,
          index_record.indisunique as is_unique,
          max(pg_get_expr(index_record.indpred, index_record.indrelid)) as predicate,
          coalesce(
            array_agg(attribute.attname::text order by index_key.ordinality)
              filter (where attribute.attname is not null),
            array[]::text[]
          ) as column_names
        from pg_catalog.pg_class as table_relation
        inner join pg_catalog.pg_namespace as table_namespace
          on table_namespace.oid = table_relation.relnamespace
        inner join pg_catalog.pg_index as index_record
          on index_record.indrelid = table_relation.oid
        inner join pg_catalog.pg_class as index_relation
          on index_relation.oid = index_record.indexrelid
        cross join lateral unnest(index_record.indkey) with ordinality as index_key(attnum, ordinality)
        left join pg_catalog.pg_attribute as attribute
          on attribute.attrelid = table_relation.oid and attribute.attnum = index_key.attnum
        where table_namespace.nspname = ${CORE_SCHEMA_NAME}
          and table_relation.relname = ${getTableName(principalAuthBindings)}
        group by index_relation.relname, index_record.indisunique, index_record.indrelid
        order by index_relation.relname
      `,
      'objects',
    )
    .pipe(
      Effect.mapError(
        () =>
          new DatabaseVerificationError({
            reason: 'Unable to verify Core authentication binding indexes',
          }),
      ),
    );
  const namedAuthIndexRows = authIndexRows.filter(({ index_name }) => index_name.startsWith('core_auth_bindings_'));
  const expectedAuthIndexNames = EXPECTED_AUTH_INDEXES.map(({ name }) => name).toSorted();
  const actualAuthIndexNames = namedAuthIndexRows.map(({ index_name }) => index_name).toSorted();
  if (
    actualAuthIndexNames.length !== expectedAuthIndexNames.length ||
    actualAuthIndexNames.some((name, index) => name !== expectedAuthIndexNames[index])
  ) {
    return yield* new DatabaseVerificationError({
      reason: 'Core authentication binding indexes are missing or unexpected',
    });
  }

  const authIndexes = new Map(namedAuthIndexRows.map((row) => [row.index_name, row]));
  const mismatchedAuthIndex = EXPECTED_AUTH_INDEXES.find((expectedIndex) => {
    const actualIndex = authIndexes.get(expectedIndex.name);
    return (
      actualIndex === undefined ||
      actualIndex.is_unique !== expectedIndex.unique ||
      actualIndex.column_names.length !== expectedIndex.columns.length ||
      actualIndex.column_names.some((name, index) => name !== expectedIndex.columns[index]) ||
      normalizeIndexPredicate(actualIndex.predicate) !== normalizeIndexPredicate(expectedIndex.predicate)
    );
  });
  if (mismatchedAuthIndex !== undefined) {
    return yield* new DatabaseVerificationError({
      reason: `Core authentication binding index ${mismatchedAuthIndex.name} is missing or incompatible`,
    });
  }
  return yield* Effect.void;
});

const verifyDatabase = Effect.gen(function* verifyDatabaseEffect() {
  const database = yield* CoreDatabase;
  yield* verifyRuntimeRole;
  yield* verifySearchIsolation;
  yield* verifyCoreConstraints;
  yield* verifyAuthBindingColumns;
  yield* verifyAuthBindingIndexes;
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
  ].map((table) => verifyTypedQuery(getTableName(table), () => database.executor.select().from(table).limit(0)));

  for (const query of typedQueries) {
    yield* query;
  }

  yield* verifyCatalog;

  return {
    tableCount: typedQueries.length,
  };
});

const DatabaseRuntimeLive = CoreDatabaseLive.pipe(Layer.provide(DatabaseConfigLive));
const result = await Effect.runPromise(Effect.provide(verifyDatabase, DatabaseRuntimeLive));

console.log(`Verified ${result.tableCount} typed tables in PostgreSQL schema ${CORE_SCHEMA_NAME}`);
