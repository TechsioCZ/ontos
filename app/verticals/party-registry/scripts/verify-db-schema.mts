// @effect-diagnostics globalConsole:off strictEffectProvide:off
import { DatabaseConfig, loadDatabaseConfig, loadDatabaseConnectionPair } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Effect, Layer, Schema } from 'effect';
import { PartyDatabase, PartyDatabaseLive } from '../src/db/client.ts';
import { comparePartyCatalog } from '../src/db/catalog.ts';
import { PARTY_SCHEMA_NAME, PARTY_TABLES } from '../src/db/schema.ts';

class PartyDatabaseVerificationError extends Schema.TaggedError<PartyDatabaseVerificationError>()(
  'PartyDatabaseVerificationError',
  {
    reason: Schema.String,
  },
) {}

interface TableCatalogRow extends Readonly<Record<string, string>> {
  readonly table_name: string;
}

interface ColumnCatalogRow extends Readonly<Record<string, string>> {
  readonly column_name: string;
  readonly table_name: string;
}

interface TableInfrastructureRow extends Readonly<Record<string, boolean | number | string>> {
  readonly force_rls: boolean;
  readonly policy_count: number;
  readonly row_security: boolean;
  readonly runtime_delete: boolean;
  readonly runtime_insert: boolean;
  readonly runtime_select: boolean;
  readonly runtime_update: boolean;
  readonly table_name: string;
  readonly table_owner: string;
}

interface OwnerInfrastructureRow extends Readonly<Record<string, boolean | number>> {
  readonly correction_trigger_count: number;
  readonly counterparty_role_exclusion_count: number;
  readonly external_foreign_key_count: number;
  readonly foreign_key_count: number;
  readonly journal_count: number;
  readonly relationship_exclusion_count: number;
  readonly role_bypass_rls: boolean;
  readonly role_super: boolean;
  readonly runtime_create: boolean;
  readonly runtime_usage: boolean;
}

const expectedColumns = PARTY_TABLES.flatMap((table) => {
  const config = getTableConfig(table);
  return config.columns.map((column) => `${config.name}.${column.name}`);
}).toSorted();

const verification = Effect.gen(function* verifyPartyDatabase() {
  const connections = yield* loadDatabaseConnectionPair();
  const database = yield* PartyDatabase;

  for (const table of PARTY_TABLES) {
    yield* Effect.tryPromise({
      catch: () =>
        new PartyDatabaseVerificationError({
          reason: `Typed verification failed for one ${PARTY_SCHEMA_NAME} table`,
        }),
      try: () => database.executor.select().from(table).limit(0),
    });
  }

  const catalog = yield* Effect.tryPromise({
    catch: () =>
      new PartyDatabaseVerificationError({
        reason: 'Unable to compare the PostgreSQL Party Registry catalog',
      }),
    try: () =>
      database.executor.execute<TableCatalogRow>(sql`
        select relation.relname as table_name
        from pg_catalog.pg_class as relation
        inner join pg_catalog.pg_namespace as namespace
          on namespace.oid = relation.relnamespace
        where namespace.nspname = ${PARTY_SCHEMA_NAME}
          and relation.relkind in (${'r'}, ${'p'})
        order by relation.relname
      `),
  });
  const difference = comparePartyCatalog(
    catalog.rows.map((row) => `${PARTY_SCHEMA_NAME}.${row.table_name}`),
  );
  if (difference.missing.length > 0 || difference.unexpected.length > 0) {
    return yield* new PartyDatabaseVerificationError({
      reason: `Party Registry catalog mismatch; missing=[${difference.missing.join(', ')}], unexpected=[${difference.unexpected.join(', ')}]`,
    });
  }

  const columns = yield* Effect.tryPromise({
    catch: () =>
      new PartyDatabaseVerificationError({
        reason: 'Unable to compare the PostgreSQL Party Registry column catalog',
      }),
    try: () =>
      database.executor.execute<ColumnCatalogRow>(sql`
        select table_name, column_name
        from information_schema.columns
        where table_schema = ${PARTY_SCHEMA_NAME}
        order by table_name, column_name
      `),
  });
  const actualColumns = columns.rows
    .map((row) => `${row.table_name}.${row.column_name}`)
    .toSorted();
  if (
    actualColumns.length !== expectedColumns.length ||
    actualColumns.some((column, index) => column !== expectedColumns[index])
  ) {
    return yield* new PartyDatabaseVerificationError({
      reason: `Party Registry column catalog mismatch; expected=[${expectedColumns.join(', ')}], actual=[${actualColumns.join(', ')}]`,
    });
  }

  const tables = yield* Effect.tryPromise({
    catch: () =>
      new PartyDatabaseVerificationError({
        reason: 'Unable to verify Party Registry table ownership, RLS, policies, or grants',
      }),
    try: () =>
      database.executor.execute<TableInfrastructureRow>(sql`
        select
          relation.relname as table_name,
          pg_catalog.pg_get_userbyid(relation.relowner) as table_owner,
          relation.relrowsecurity as row_security,
          relation.relforcerowsecurity as force_rls,
          (select count(*)::integer from pg_catalog.pg_policy as policy
            where policy.polrelid = relation.oid) as policy_count,
          has_table_privilege(${'ontos_runtime'}, format('%I.%I', namespace.nspname, relation.relname), ${'SELECT'}) as runtime_select,
          has_table_privilege(${'ontos_runtime'}, format('%I.%I', namespace.nspname, relation.relname), ${'INSERT'}) as runtime_insert,
          has_table_privilege(${'ontos_runtime'}, format('%I.%I', namespace.nspname, relation.relname), ${'UPDATE'}) as runtime_update,
          has_table_privilege(${'ontos_runtime'}, format('%I.%I', namespace.nspname, relation.relname), ${'DELETE'}) as runtime_delete
        from pg_catalog.pg_class as relation
        inner join pg_catalog.pg_namespace as namespace
          on namespace.oid = relation.relnamespace
        where namespace.nspname = ${PARTY_SCHEMA_NAME}
          and relation.relkind in (${'r'}, ${'p'})
        order by relation.relname
      `),
  });
  if (
    tables.rows.length !== PARTY_TABLES.length ||
    tables.rows.some(
      (row) =>
        row.table_owner !== connections.admin.user ||
        !row.row_security ||
        !row.force_rls ||
        row.policy_count !== 4 ||
        !row.runtime_select ||
        !row.runtime_insert ||
        !row.runtime_update ||
        !row.runtime_delete,
    )
  ) {
    return yield* new PartyDatabaseVerificationError({
      reason:
        'Party Registry tables do not match their ownership, forced-RLS, policy, or runtime-grant contract',
    });
  }

  const infrastructure = yield* Effect.tryPromise({
    catch: () =>
      new PartyDatabaseVerificationError({
        reason: 'Unable to verify Party Registry migration and constraint infrastructure',
      }),
    try: () =>
      database.executor.execute<OwnerInfrastructureRow>(sql`
        select
          has_schema_privilege(${'ontos_runtime'}, ${PARTY_SCHEMA_NAME}, ${'CREATE'}) as runtime_create,
          has_schema_privilege(${'ontos_runtime'}, ${PARTY_SCHEMA_NAME}, ${'USAGE'}) as runtime_usage,
          runtime_role.rolsuper as role_super,
          runtime_role.rolbypassrls as role_bypass_rls,
          (select count(*)::integer from pg_catalog.pg_class as journal
            inner join pg_catalog.pg_namespace as journal_namespace
              on journal_namespace.oid = journal.relnamespace
            where journal_namespace.nspname = ${'drizzle'}
              and journal.relname = ${'__drizzle_migrations_party'}) as journal_count,
          (select count(*)::integer from pg_catalog.pg_constraint as constraint_record
            inner join pg_catalog.pg_class as relation
              on relation.oid = constraint_record.conrelid
            inner join pg_catalog.pg_namespace as namespace
              on namespace.oid = relation.relnamespace
            where namespace.nspname = ${PARTY_SCHEMA_NAME}
              and constraint_record.contype = ${'f'}) as foreign_key_count,
          (select count(*)::integer from pg_catalog.pg_constraint as constraint_record
            inner join pg_catalog.pg_class as relation
              on relation.oid = constraint_record.conrelid
            inner join pg_catalog.pg_namespace as namespace
              on namespace.oid = relation.relnamespace
            inner join pg_catalog.pg_class as referenced_relation
              on referenced_relation.oid = constraint_record.confrelid
            inner join pg_catalog.pg_namespace as referenced_namespace
              on referenced_namespace.oid = referenced_relation.relnamespace
            where namespace.nspname = ${PARTY_SCHEMA_NAME}
              and constraint_record.contype = ${'f'}
              and referenced_namespace.nspname <> ${PARTY_SCHEMA_NAME}) as external_foreign_key_count,
          (select count(*)::integer from pg_catalog.pg_constraint as constraint_record
            inner join pg_catalog.pg_class as relation
              on relation.oid = constraint_record.conrelid
            inner join pg_catalog.pg_namespace as namespace
              on namespace.oid = relation.relnamespace
            where namespace.nspname = ${PARTY_SCHEMA_NAME}
              and relation.relname = ${'party_relationships'}
              and constraint_record.conname = ${'party_relationships_no_overlap_excl'}
              and constraint_record.contype = ${'x'}) as relationship_exclusion_count,
          (select count(*)::integer from pg_catalog.pg_constraint as constraint_record
            inner join pg_catalog.pg_class as relation
              on relation.oid = constraint_record.conrelid
            inner join pg_catalog.pg_namespace as namespace
              on namespace.oid = relation.relnamespace
            where namespace.nspname = ${PARTY_SCHEMA_NAME}
              and relation.relname = ${'counterparty_role_periods'}
              and constraint_record.conname = ${'party_counterparty_role_periods_no_overlap_excl'}
              and constraint_record.contype = ${'x'}) as counterparty_role_exclusion_count,
          (select count(*)::integer from pg_catalog.pg_trigger as trigger_record
            inner join pg_catalog.pg_class as relation
              on relation.oid = trigger_record.tgrelid
            inner join pg_catalog.pg_namespace as namespace
              on namespace.oid = relation.relnamespace
            where namespace.nspname = ${PARTY_SCHEMA_NAME}
              and relation.relname = ${'party_corrections'}
              and trigger_record.tgname = ${'party_corrections_append_only'}
              and not trigger_record.tgisinternal) as correction_trigger_count
        from pg_catalog.pg_roles as runtime_role
        where runtime_role.rolname = ${'ontos_runtime'}
      `),
  });
  const [owner] = infrastructure.rows;
  if (
    owner === undefined ||
    owner.runtime_create ||
    !owner.runtime_usage ||
    owner.role_super ||
    owner.role_bypass_rls ||
    owner.journal_count !== 1 ||
    owner.foreign_key_count !== 41 ||
    owner.external_foreign_key_count !== 0 ||
    owner.relationship_exclusion_count !== 1 ||
    owner.counterparty_role_exclusion_count !== 1 ||
    owner.correction_trigger_count !== 1
  ) {
    return yield* new PartyDatabaseVerificationError({
      reason:
        'Party Registry owner infrastructure does not match its journal, owner-local FK, exclusion, append-only, or least-privilege contract',
    });
  }

  return { typedTableCount: PARTY_TABLES.length };
});

const runtime = PartyDatabaseLive.pipe(
  Layer.provide(Layer.effect(DatabaseConfig, loadDatabaseConfig())),
);
const result = await Effect.runPromise(Effect.provide(verification, runtime));

console.log(
  `Verified ${result.typedTableCount} typed tables in PostgreSQL schema ${PARTY_SCHEMA_NAME}`,
);
