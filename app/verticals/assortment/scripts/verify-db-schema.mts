// @effect-diagnostics globalConsole:off strictEffectProvide:off -- Operator verifier boundary; expires: 2027-03-31.
import { DatabaseConfig, loadDatabaseConnectionPair } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { Array as EffectArray, Effect, Layer, Order, Schema } from 'effect';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Reactivity } from 'effect/unstable/reactivity';
import { AssortmentDatabase, AssortmentDatabaseLive, AssortmentPgClientLive } from '../src/database/client.ts';
import {
  ASSORTMENT_SCHEMA_NAME,
  ASSORTMENT_TABLES,
  ASSORTMENT_TABLE_INVENTORY,
  DECISION_SET_FENCE_SOURCE_TABLES,
} from '../src/database/schema.ts';

class AssortmentVerificationError extends Schema.TaggedError<AssortmentVerificationError>()(
  'AssortmentVerificationError',
  { reason: Schema.String },
) {}

interface CatalogRow extends Readonly<Record<string, string>> {
  readonly table_name: string;
}
interface InfrastructureRow extends Readonly<Record<string, boolean | number>> {
  readonly append_only_trigger_count: number;
  readonly force_rls_count: number;
  readonly journal_count: number;
  readonly policy_count: number;
  readonly role_bypass_rls: boolean;
  readonly role_super: boolean;
  readonly runtime_create: boolean;
  readonly runtime_delete: boolean;
  readonly runtime_insert: boolean;
  readonly runtime_select: boolean;
  readonly runtime_update: boolean;
  readonly table_count: number;
}

const expectedTables = EffectArray.sort(
  ASSORTMENT_TABLE_INVENTORY.map((name) => `${ASSORTMENT_SCHEMA_NAME}.${name}`),
  Order.String,
);
const expectedColumns = EffectArray.sort(
  ASSORTMENT_TABLES.flatMap((table) => {
    const config = getTableConfig(table);
    return config.columns.map((column) => `${config.name}.${column.name}`);
  }),
  Order.String,
);

const verification = Effect.gen(function* verifyAssortmentDatabase() {
  const connections = yield* loadDatabaseConnectionPair();
  const database = yield* AssortmentDatabase;
  const catalog = yield* database.executor
    .execute<CatalogRow>(
      sql`select relation.relname as table_name from pg_catalog.pg_class as relation inner join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace where namespace.nspname = ${ASSORTMENT_SCHEMA_NAME} and relation.relkind in ('r', 'p') order by relation.relname`,
      'objects',
    )
    .pipe(
      Effect.mapError(() => new AssortmentVerificationError({ reason: 'Unable to read Assortment table catalog' })),
    );
  const actualTables = catalog.map((row) => `${ASSORTMENT_SCHEMA_NAME}.${row.table_name}`);
  if (
    actualTables.length !== expectedTables.length ||
    actualTables.some((value, index) => value !== expectedTables[index])
  ) {
    return yield* new AssortmentVerificationError({ reason: 'Assortment table catalog mismatch' });
  }

  const columns = yield* database.executor
    .execute<Readonly<Record<string, string>> & { readonly column_name: string; readonly table_name: string }>(
      sql`select table_name, column_name from information_schema.columns where table_schema = ${ASSORTMENT_SCHEMA_NAME} order by table_name, column_name`,
      'objects',
    )
    .pipe(Effect.mapError(() => new AssortmentVerificationError({ reason: 'Unable to read Assortment columns' })));
  const actualColumns = EffectArray.sort(
    columns.map((row) => `${row.table_name}.${row.column_name}`),
    Order.String,
  );
  if (
    actualColumns.length !== expectedColumns.length ||
    actualColumns.some((value, index) => value !== expectedColumns[index])
  ) {
    return yield* new AssortmentVerificationError({ reason: 'Assortment column catalog mismatch' });
  }

  const [infrastructure] = yield* database.executor
    .execute<InfrastructureRow>(
      sql`select count(distinct relation.oid)::integer as table_count, count(distinct relation.oid) filter (where relation.relrowsecurity and relation.relforcerowsecurity)::integer as force_rls_count, (select count(*)::integer from pg_catalog.pg_policy as policy inner join pg_catalog.pg_class as governed on governed.oid = policy.polrelid inner join pg_catalog.pg_namespace as governed_namespace on governed_namespace.oid = governed.relnamespace where governed_namespace.nspname = ${ASSORTMENT_SCHEMA_NAME}) as policy_count, (select count(*)::integer from pg_catalog.pg_trigger as trigger_record inner join pg_catalog.pg_class as triggered on triggered.oid = trigger_record.tgrelid inner join pg_catalog.pg_namespace as trigger_namespace on trigger_namespace.oid = triggered.relnamespace where trigger_namespace.nspname = ${ASSORTMENT_SCHEMA_NAME} and trigger_record.tgname like 'assortment_%_append_only' and not trigger_record.tgisinternal) as append_only_trigger_count, (select count(*)::integer from pg_catalog.pg_class as journal inner join pg_catalog.pg_namespace as journal_namespace on journal_namespace.oid = journal.relnamespace where journal_namespace.nspname = 'drizzle' and journal.relname = '__drizzle_migrations_assortment') as journal_count, has_schema_privilege('ontos_runtime', ${ASSORTMENT_SCHEMA_NAME}, 'CREATE') as runtime_create, bool_or(has_table_privilege('ontos_runtime', format('%I.%I', namespace.nspname, relation.relname), 'SELECT')) as runtime_select, bool_or(has_table_privilege('ontos_runtime', format('%I.%I', namespace.nspname, relation.relname), 'INSERT')) as runtime_insert, bool_or(has_table_privilege('ontos_runtime', format('%I.%I', namespace.nspname, relation.relname), 'UPDATE')) as runtime_update, bool_or(has_table_privilege('ontos_runtime', format('%I.%I', namespace.nspname, relation.relname), 'DELETE')) as runtime_delete, runtime_role.rolsuper as role_super, runtime_role.rolbypassrls as role_bypass_rls from pg_catalog.pg_class as relation inner join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace cross join pg_catalog.pg_roles as runtime_role where namespace.nspname = ${ASSORTMENT_SCHEMA_NAME} and relation.relkind in ('r', 'p') and runtime_role.rolname = 'ontos_runtime' group by runtime_role.rolsuper, runtime_role.rolbypassrls`,
      'objects',
    )
    .pipe(
      Effect.mapError(() => new AssortmentVerificationError({ reason: 'Unable to verify Assortment RLS and grants' })),
    );
  const fenceTriggers = yield* database.executor
    .execute<Readonly<Record<string, number>> & { readonly trigger_count: number }>(
      sql`select count(*)::integer as trigger_count from pg_catalog.pg_trigger where tgname like 'assortment_decision_set_fence_%' and not tgisinternal`,
      'objects',
    )
    .pipe(
      Effect.mapError(
        () => new AssortmentVerificationError({ reason: 'Unable to verify Decision Set fence triggers' }),
      ),
    );
  if (
    infrastructure === undefined ||
    infrastructure.table_count !== ASSORTMENT_TABLES.length ||
    infrastructure.force_rls_count !== ASSORTMENT_TABLES.length ||
    infrastructure.policy_count !== ASSORTMENT_TABLES.length * 4 + 1 ||
    infrastructure.append_only_trigger_count !== ASSORTMENT_TABLES.length - 1 ||
    fenceTriggers[0]?.trigger_count !== DECISION_SET_FENCE_SOURCE_TABLES.length ||
    infrastructure.journal_count !== 1 ||
    infrastructure.runtime_create ||
    infrastructure.runtime_select ||
    infrastructure.runtime_insert ||
    infrastructure.runtime_update ||
    infrastructure.runtime_delete ||
    infrastructure.role_super ||
    infrastructure.role_bypass_rls
  ) {
    return yield* new AssortmentVerificationError({
      reason: 'Assortment owner isolation or append-only contract failed',
    });
  }
  return { adminUser: connections.admin.user, typedTableCount: ASSORTMENT_TABLES.length };
});

const runtime = AssortmentDatabaseLive.pipe(
  Layer.provide(AssortmentPgClientLive),
  Layer.provide(
    Layer.mergeAll(
      Layer.effect(DatabaseConfig, loadDatabaseConnectionPair().pipe(Effect.map(({ admin }) => admin))),
      Reactivity.layer,
    ),
  ),
);
const result = await Effect.runPromise(Effect.provide(verification, runtime));
console.log(`Verified ${result.typedTableCount} typed tables in PostgreSQL schema ${ASSORTMENT_SCHEMA_NAME}`);
