// @effect-diagnostics globalConsole:off strictEffectProvide:off -- Existing compatibility boundary; expires: 2026-12-31.
import {
  DatabaseConfig,
  loadDatabaseConfig,
  loadDatabaseConnectionPair,
  PARTY_REGISTRY_REQUEST_IDENTITY,
} from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Effect, Layer, Schema } from 'effect';

import { comparePartyCatalog } from '../src/db/catalog.ts';
import { PartyDatabase, PartyDatabaseLive } from '../src/db/client.ts';
import { PARTY_REGISTRY_WORKER_PARTY_TABLES } from '../src/db/database-grants.ts';
import { PARTY_SCHEMA_NAME, PARTY_TABLES } from '../src/db/schema.ts';
import { policyMismatches, rolePrivilegeMismatches } from './database-role-contract.mts';

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
}

const expectedColumns = PARTY_TABLES.flatMap((table) => {
  const config = getTableConfig(table);
  return config.columns.map((column) => `${config.name}.${column.name}`);
}).toSorted();

const ownerPrivilegesMismatch = (owner: OwnerInfrastructureRow): boolean => owner.role_super || owner.role_bypass_rls;

const ownerConstraintsMismatch = (owner: OwnerInfrastructureRow): boolean =>
  owner.journal_count !== 1 ||
  owner.foreign_key_count !== 41 ||
  owner.external_foreign_key_count !== 0 ||
  owner.relationship_exclusion_count !== 1 ||
  owner.counterparty_role_exclusion_count !== 1 ||
  owner.correction_trigger_count !== 1;

const ownerInfrastructureMismatch = (owner: OwnerInfrastructureRow | undefined): boolean =>
  owner === undefined || ownerPrivilegesMismatch(owner) || ownerConstraintsMismatch(owner);

const verification = Effect.gen(function* verifyPartyDatabase() {
  const connections = yield* loadDatabaseConnectionPair({ identity: PARTY_REGISTRY_REQUEST_IDENTITY });
  const database = yield* PartyDatabase;

  for (const table of PARTY_TABLES) {
    yield* database.executor
      .select()
      .from(table)
      .limit(0)
      .pipe(
        Effect.mapError(
          () =>
            new PartyDatabaseVerificationError({
              reason: `Typed verification failed for one ${PARTY_SCHEMA_NAME} table`,
            }),
        ),
      );
  }

  const catalog = yield* database.executor
    .execute<TableCatalogRow>(
      sql`
        select relation.relname as table_name
        from pg_catalog.pg_class as relation
        inner join pg_catalog.pg_namespace as namespace
          on namespace.oid = relation.relnamespace
        where namespace.nspname = ${PARTY_SCHEMA_NAME}
          and relation.relkind in (${'r'}, ${'p'})
        order by relation.relname
      `,
      'objects',
    )
    .pipe(
      Effect.mapError(
        () =>
          new PartyDatabaseVerificationError({
            reason: 'Unable to compare the PostgreSQL Party Registry catalog',
          }),
      ),
    );
  const difference = comparePartyCatalog(catalog.map((row) => `${PARTY_SCHEMA_NAME}.${row.table_name}`));
  if (difference.missing.length > 0 || difference.unexpected.length > 0) {
    return yield* new PartyDatabaseVerificationError({
      reason: `Party Registry catalog mismatch; missing=[${difference.missing.join(', ')}], unexpected=[${difference.unexpected.join(', ')}]`,
    });
  }

  const columns = yield* database.executor
    .execute<ColumnCatalogRow>(
      sql`
        select table_name, column_name
        from information_schema.columns
        where table_schema = ${PARTY_SCHEMA_NAME}
        order by table_name, column_name
      `,
      'objects',
    )
    .pipe(
      Effect.mapError(
        () =>
          new PartyDatabaseVerificationError({
            reason: 'Unable to compare the PostgreSQL Party Registry column catalog',
          }),
      ),
    );
  const actualColumns = columns.map((row) => `${row.table_name}.${row.column_name}`).toSorted();
  if (
    actualColumns.length !== expectedColumns.length ||
    actualColumns.some((column, index) => column !== expectedColumns[index])
  ) {
    return yield* new PartyDatabaseVerificationError({
      reason: `Party Registry column catalog mismatch; expected=[${expectedColumns.join(', ')}], actual=[${actualColumns.join(', ')}]`,
    });
  }

  const tables = yield* database.executor
    .execute<TableInfrastructureRow>(
      sql`
        select
          relation.relname as table_name,
          pg_catalog.pg_get_userbyid(relation.relowner) as table_owner
        from pg_catalog.pg_class as relation
        inner join pg_catalog.pg_namespace as namespace
          on namespace.oid = relation.relnamespace
        where namespace.nspname = ${PARTY_SCHEMA_NAME}
          and relation.relkind in (${'r'}, ${'p'})
        order by relation.relname
      `,
      'objects',
    )
    .pipe(
      Effect.mapError(
        () =>
          new PartyDatabaseVerificationError({
            reason: 'Unable to verify Party Registry table ownership',
          }),
      ),
    );
  if (tables.length !== PARTY_TABLES.length || tables.some((row) => row.table_owner !== connections.admin.user)) {
    return yield* new PartyDatabaseVerificationError({
      reason: 'Party Registry tables are not owned by the migration owner',
    });
  }

  const accessMismatches = yield* Effect.all([
    rolePrivilegeMismatches(database.executor, PARTY_SCHEMA_NAME),
    policyMismatches(database.executor, PARTY_SCHEMA_NAME, PARTY_TABLES, PARTY_REGISTRY_WORKER_PARTY_TABLES),
  ]).pipe(
    Effect.map((groups) => groups.flat()),
    Effect.mapError(
      () =>
        new PartyDatabaseVerificationError({
          reason: 'Unable to verify Party Registry grants and row-level security policies',
        }),
    ),
  );
  if (accessMismatches.length > 0) {
    return yield* new PartyDatabaseVerificationError({
      reason: `Party Registry grants or policies do not match the database role manifest: ${accessMismatches.join('; ')}`,
    });
  }

  const infrastructure = yield* database.executor
    .execute<OwnerInfrastructureRow>(
      sql`
        select
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
        where runtime_role.rolname = ${PARTY_REGISTRY_REQUEST_IDENTITY.role}
      `,
      'objects',
    )
    .pipe(
      Effect.mapError(
        () =>
          new PartyDatabaseVerificationError({
            reason: 'Unable to verify Party Registry migration and constraint infrastructure',
          }),
      ),
    );
  const [owner] = infrastructure;
  if (ownerInfrastructureMismatch(owner)) {
    return yield* new PartyDatabaseVerificationError({
      reason:
        'Party Registry owner infrastructure does not match its journal, owner-local FK, exclusion, append-only, or least-privilege contract',
    });
  }

  return { typedTableCount: PARTY_TABLES.length };
});

const runtime = PartyDatabaseLive.pipe(
  Layer.provide(Layer.effect(DatabaseConfig, loadDatabaseConfig({ identity: PARTY_REGISTRY_REQUEST_IDENTITY }))),
);
const result = await Effect.runPromise(Effect.provide(verification, runtime));

console.log(`Verified ${result.typedTableCount} typed tables in PostgreSQL schema ${PARTY_SCHEMA_NAME}`);
