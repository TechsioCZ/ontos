// @effect-diagnostics globalConsole:off strictEffectProvide:off -- Operator verifier is an executable boundary; expires: 2026-12-31.
import { DatabaseConfig, loadDatabaseConnectionPair } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Array as EffectArray, Effect, Layer, Order, Schema } from 'effect';
import { compareCommerceMarketCatalog } from '../src/database/catalog.ts';
import { CommerceMarketCatalogDatabase, CommerceMarketCatalogDatabaseLive } from '../src/database/client.ts';
import { COMMERCE_MARKET_CATALOG_SCHEMA_NAME, COMMERCE_MARKET_CATALOG_TABLES } from '../src/database/schema.ts';

class VerificationError extends Schema.TaggedError<VerificationError>()('CommerceMarketCatalogVerificationError', {
  reason: Schema.String,
}) {}

interface TableRow extends Readonly<Record<string, string>> {
  readonly table_name: string;
}
interface ColumnRow extends Readonly<Record<string, string>> {
  readonly column_name: string;
  readonly table_name: string;
}
interface InfrastructureRow extends Readonly<Record<string, boolean | number>> {
  readonly append_only_trigger_count: number;
  readonly force_rls_count: number;
  readonly foreign_key_count: number;
  readonly governed_routine_count: number;
  readonly identity_trigger_count: number;
  readonly journal_count: number;
  readonly policy_count: number;
  readonly private_routine_executable: boolean;
  readonly role_bypass_rls: boolean;
  readonly role_super: boolean;
  readonly runtime_create: boolean;
  readonly runtime_delete: boolean;
  readonly runtime_insert: boolean;
  readonly runtime_select: boolean;
  readonly runtime_update: boolean;
  readonly runtime_usage: boolean;
  readonly table_count: number;
  readonly unexpected_runtime_routine_count: number;
  readonly unsafe_governed_routine_count: number;
  readonly wrong_owner_count: number;
}

const expectedColumns = EffectArray.sort(
  COMMERCE_MARKET_CATALOG_TABLES.flatMap((table) => {
    const config = getTableConfig(table);
    return config.columns.map((column) => `${config.name}.${column.name}`);
  }),
  Order.String,
);

// oxlint-disable-next-line complexity -- One operator report evaluates the correlated exact catalog in a single database snapshot; expires: 2027-03-31.
const verification = Effect.gen(function* verifyDatabase() {
  const connections = yield* loadDatabaseConnectionPair();
  const database = yield* CommerceMarketCatalogDatabase;
  for (const table of COMMERCE_MARKET_CATALOG_TABLES) {
    yield* database.executor
      .select()
      .from(table)
      .limit(0)
      .pipe(
        Effect.mapError(
          () => new VerificationError({ reason: 'Typed Commerce Market Catalog table verification failed' }),
        ),
      );
  }
  const catalog = yield* database.executor.execute<TableRow>(
    sql`select relation.relname as table_name from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = ${COMMERCE_MARKET_CATALOG_SCHEMA_NAME} and relation.relkind in (${'r'}, ${'p'})
      order by relation.relname`,
    'objects',
  );
  const difference = compareCommerceMarketCatalog(
    catalog.map(({ table_name }) => `${COMMERCE_MARKET_CATALOG_SCHEMA_NAME}.${table_name}`),
  );
  if (difference.missing.length > 0 || difference.unexpected.length > 0) {
    return yield* new VerificationError({
      reason: `Commerce Market Catalog mismatch; missing=[${difference.missing.join(', ')}], unexpected=[${difference.unexpected.join(', ')}]`,
    });
  }
  const columns = yield* database.executor.execute<ColumnRow>(
    sql`select table_name, column_name from information_schema.columns
      where table_schema = ${COMMERCE_MARKET_CATALOG_SCHEMA_NAME} order by table_name, column_name`,
    'objects',
  );
  const actualColumns = EffectArray.sort(
    columns.map(({ column_name, table_name }) => `${table_name}.${column_name}`),
    Order.String,
  );
  if (
    actualColumns.length !== expectedColumns.length ||
    actualColumns.some((column, index) => column !== expectedColumns[index])
  ) {
    return yield* new VerificationError({ reason: 'Commerce Market Catalog column inventory mismatch' });
  }
  const [infrastructure] = yield* database.executor.execute<InfrastructureRow>(
    sql`select
      count(distinct relation.oid)::integer as table_count,
      count(distinct relation.oid) filter (where relation.relrowsecurity and relation.relforcerowsecurity)::integer as force_rls_count,
      count(distinct relation.oid) filter (where pg_catalog.pg_get_userbyid(relation.relowner) <> ${connections.admin.user})::integer as wrong_owner_count,
      (select count(*)::integer from pg_catalog.pg_policy policy join pg_catalog.pg_class governed on governed.oid = policy.polrelid join pg_catalog.pg_namespace ns on ns.oid = governed.relnamespace where ns.nspname = ${COMMERCE_MARKET_CATALOG_SCHEMA_NAME}) as policy_count,
      (select count(*)::integer from pg_catalog.pg_constraint constraint_record join pg_catalog.pg_class constrained on constrained.oid = constraint_record.conrelid join pg_catalog.pg_namespace ns on ns.oid = constrained.relnamespace where ns.nspname = ${COMMERCE_MARKET_CATALOG_SCHEMA_NAME} and constraint_record.contype = ${'f'}) as foreign_key_count,
      (select count(*)::integer from pg_catalog.pg_trigger trigger_record join pg_catalog.pg_class triggered on triggered.oid = trigger_record.tgrelid join pg_catalog.pg_namespace ns on ns.oid = triggered.relnamespace where ns.nspname = ${COMMERCE_MARKET_CATALOG_SCHEMA_NAME} and trigger_record.tgname in (${'commerce_market_catalog_definition_revisions_append_only'}, ${'commerce_market_catalog_association_revisions_append_only'}) and not trigger_record.tgisinternal) as append_only_trigger_count,
      (select count(*)::integer from pg_catalog.pg_trigger trigger_record join pg_catalog.pg_class triggered on triggered.oid = trigger_record.tgrelid join pg_catalog.pg_namespace ns on ns.oid = triggered.relnamespace where ns.nspname = ${COMMERCE_MARKET_CATALOG_SCHEMA_NAME} and trigger_record.tgname in (${'commerce_market_catalog_markets_identity_immutable'}, ${'commerce_market_catalog_associations_identity_immutable'}) and not trigger_record.tgisinternal) as identity_trigger_count,
      (select count(*)::integer from pg_catalog.pg_class journal join pg_catalog.pg_namespace ns on ns.oid = journal.relnamespace where ns.nspname = ${'drizzle'} and journal.relname = ${'__drizzle_migrations_commerce_market_catalog'}) as journal_count,
      (select count(*)::integer from pg_catalog.pg_proc routine join pg_catalog.pg_namespace ns on ns.oid = routine.pronamespace where ns.nspname = ${COMMERCE_MARKET_CATALOG_SCHEMA_NAME} and routine.proname in (${'create_market'}, ${'revise_market_definition'}, ${'transition_market_lifecycle'}, ${'associate_storefront'}, ${'revise_storefront_association'}, ${'remove_storefront_association'}, ${'read_market_eligibility_snapshot'}, ${'read_current_market_catalog'}, ${'read_market_history'}) and routine.prosecdef and has_function_privilege(${'ontos_runtime'}, routine.oid, ${'EXECUTE'})) as governed_routine_count,
      (select count(*)::integer from pg_catalog.pg_proc routine join pg_catalog.pg_namespace ns on ns.oid = routine.pronamespace where ns.nspname = ${COMMERCE_MARKET_CATALOG_SCHEMA_NAME} and routine.proname in (${'create_market'}, ${'revise_market_definition'}, ${'transition_market_lifecycle'}, ${'associate_storefront'}, ${'revise_storefront_association'}, ${'remove_storefront_association'}, ${'read_market_eligibility_snapshot'}, ${'read_current_market_catalog'}, ${'read_market_history'}) and (not routine.prosecdef or not coalesce(routine.proconfig @> array[${'search_path=pg_catalog, pg_temp'}]::text[], false))) as unsafe_governed_routine_count,
      (select count(*)::integer from pg_catalog.pg_proc routine join pg_catalog.pg_namespace ns on ns.oid = routine.pronamespace where ns.nspname = ${COMMERCE_MARKET_CATALOG_SCHEMA_NAME} and routine.proname not in (${'create_market'}, ${'revise_market_definition'}, ${'transition_market_lifecycle'}, ${'associate_storefront'}, ${'revise_storefront_association'}, ${'remove_storefront_association'}, ${'read_market_eligibility_snapshot'}, ${'read_current_market_catalog'}, ${'read_market_history'}) and has_function_privilege(${'ontos_runtime'}, routine.oid, ${'EXECUTE'})) as unexpected_runtime_routine_count,
      has_function_privilege(${'ontos_runtime'}, ${'commerce_market_catalog.assert_operation_scope(uuid,uuid)'}, ${'EXECUTE'}) or has_function_privilege(${'ontos_runtime'}, ${'commerce_market_catalog.advance_completeness_generation(uuid,uuid)'}, ${'EXECUTE'}) as private_routine_executable,
      has_schema_privilege(${'ontos_runtime'}, ${COMMERCE_MARKET_CATALOG_SCHEMA_NAME}, ${'CREATE'}) as runtime_create,
      has_schema_privilege(${'ontos_runtime'}, ${COMMERCE_MARKET_CATALOG_SCHEMA_NAME}, ${'USAGE'}) as runtime_usage,
      bool_or(has_table_privilege(${'ontos_runtime'}, format('%I.%I', namespace.nspname, relation.relname), ${'SELECT'})) as runtime_select,
      bool_or(has_table_privilege(${'ontos_runtime'}, format('%I.%I', namespace.nspname, relation.relname), ${'INSERT'})) as runtime_insert,
      bool_or(has_table_privilege(${'ontos_runtime'}, format('%I.%I', namespace.nspname, relation.relname), ${'UPDATE'})) as runtime_update,
      bool_or(has_table_privilege(${'ontos_runtime'}, format('%I.%I', namespace.nspname, relation.relname), ${'DELETE'})) as runtime_delete,
      runtime_role.rolsuper as role_super, runtime_role.rolbypassrls as role_bypass_rls
      from pg_catalog.pg_class relation join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      cross join pg_catalog.pg_roles runtime_role
      where namespace.nspname = ${COMMERCE_MARKET_CATALOG_SCHEMA_NAME} and relation.relkind in (${'r'}, ${'p'}) and runtime_role.rolname = ${'ontos_runtime'}
      group by runtime_role.rolsuper, runtime_role.rolbypassrls`,
    'objects',
  );
  if (
    infrastructure === undefined ||
    infrastructure.table_count !== 6 ||
    infrastructure.force_rls_count !== 6 ||
    infrastructure.wrong_owner_count !== 0 ||
    infrastructure.policy_count !== 24 ||
    infrastructure.foreign_key_count !== 6 ||
    infrastructure.append_only_trigger_count !== 2 ||
    infrastructure.identity_trigger_count !== 2 ||
    infrastructure.journal_count !== 1 ||
    infrastructure.governed_routine_count !== 9 ||
    infrastructure.unsafe_governed_routine_count !== 0 ||
    infrastructure.unexpected_runtime_routine_count !== 0 ||
    infrastructure.private_routine_executable ||
    infrastructure.runtime_create ||
    !infrastructure.runtime_usage ||
    infrastructure.runtime_select ||
    infrastructure.runtime_insert ||
    infrastructure.runtime_update ||
    infrastructure.runtime_delete ||
    infrastructure.role_super ||
    infrastructure.role_bypass_rls
  ) {
    return yield* new VerificationError({
      reason:
        'Commerce Market Catalog ownership, RLS, routine, trigger, journal, or least-privilege verification failed',
    });
  }
  return { typedTableCount: COMMERCE_MARKET_CATALOG_TABLES.length };
});

const runtime = CommerceMarketCatalogDatabaseLive.pipe(
  Layer.provide(Layer.effect(DatabaseConfig, loadDatabaseConnectionPair().pipe(Effect.map(({ admin }) => admin)))),
);
const result = await Effect.runPromise(Effect.provide(verification, runtime));
console.log(
  `Verified ${result.typedTableCount} typed tables in PostgreSQL schema ${COMMERCE_MARKET_CATALOG_SCHEMA_NAME}`,
);
