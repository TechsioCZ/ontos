import { DatabaseConfig, loadDatabaseConnectionPair } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { Console, Array as EffectArray, Effect, Layer, Order, Schema } from 'effect';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Reactivity } from 'effect/reactivity';
import { TaxDatabase, TaxDatabaseLive, TaxPgClientLive } from '../src/database/client.ts';
import { TAX_SCHEMA_NAME, TAX_TABLES, TAX_TABLE_INVENTORY } from '../src/database/schema.ts';

class TaxVerificationError extends Schema.TaggedError<TaxVerificationError>()('TaxVerificationError', {
  reason: Schema.String,
}) {}

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
  readonly runtime_usage: boolean;
  readonly table_count: number;
}

const expectedTables = EffectArray.sort(
  TAX_TABLE_INVENTORY.map((name) => `${TAX_SCHEMA_NAME}.${name}`),
  Order.String,
);
const expectedColumns = EffectArray.sort(
  TAX_TABLES.flatMap((table) => {
    const config = getTableConfig(table);
    return config.columns.map((column) => `${config.name}.${column.name}`);
  }),
  Order.String,
);
const expectedPolicyCount = TAX_TABLES.reduce((count, table) => count + getTableConfig(table).policies.length, 0);

const sameList = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.length === expected.length && actual.every((value, index) => value === expected[index]);

const verification = Effect.gen(function* verifyTaxDatabase() {
  const connections = yield* loadDatabaseConnectionPair();
  const database = yield* TaxDatabase;
  const catalog = yield* database.executor
    .execute<CatalogRow>(
      sql`select relation.relname as table_name from pg_catalog.pg_class as relation inner join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace where namespace.nspname = ${TAX_SCHEMA_NAME} and relation.relkind in ('r', 'p') order by relation.relname`,
      'objects',
    )
    .pipe(Effect.mapError(() => new TaxVerificationError({ reason: 'Unable to read Tax table catalog' })));
  const actualTables = EffectArray.sort(
    catalog.map((row) => `${TAX_SCHEMA_NAME}.${row.table_name}`),
    Order.String,
  );
  if (!sameList(actualTables, expectedTables)) {
    return yield* new TaxVerificationError({ reason: 'Tax table catalog mismatch' });
  }

  const columns = yield* database.executor
    .execute<Readonly<Record<string, string>> & { readonly column_name: string; readonly table_name: string }>(
      sql`select table_name, column_name from information_schema.columns where table_schema = ${TAX_SCHEMA_NAME} order by table_name, column_name`,
      'objects',
    )
    .pipe(Effect.mapError(() => new TaxVerificationError({ reason: 'Unable to read Tax columns' })));
  const actualColumns = EffectArray.sort(
    columns.map((row) => `${row.table_name}.${row.column_name}`),
    Order.String,
  );
  if (!sameList(actualColumns, expectedColumns)) {
    return yield* new TaxVerificationError({ reason: 'Tax column catalog mismatch' });
  }

  const [gateway] = yield* database.executor
    .execute<{ readonly valid: boolean }>(
      sql`select (
  (select count(*) = 1 from pg_catalog.pg_class relation join pg_catalog.pg_namespace ns on ns.oid=relation.relnamespace
    where ns.nspname='tax' and relation.relname='gateway_assertion_redemptions' and relation.relkind='r'
      and not relation.relrowsecurity and not relation.relforcerowsecurity)
  and (select count(*) = 5 from information_schema.columns where table_schema='tax' and table_name='gateway_assertion_redemptions'
    and is_nullable='NO' and ((column_name in ('issuer','audience') and data_type='text')
      or (column_name='jti' and data_type='uuid')
      or (column_name in ('expires_at','redeemed_at') and data_type='timestamp with time zone')))
  and (select count(*) = 1 from pg_catalog.pg_constraint c join pg_catalog.pg_class t on t.oid=c.conrelid
    join pg_catalog.pg_namespace ns on ns.oid=t.relnamespace where ns.nspname='tax' and t.relname='gateway_assertion_redemptions'
      and c.contype='u' and pg_catalog.pg_get_constraintdef(c.oid)='UNIQUE (issuer, audience, jti)')
  and (select count(*) = 1 from pg_catalog.pg_indexes where schemaname='tax' and tablename='gateway_assertion_redemptions'
    and indexdef like '% USING btree (expires_at)')
  and has_table_privilege('ontos_runtime','tax.gateway_assertion_redemptions','SELECT')
  and has_table_privilege('ontos_runtime','tax.gateway_assertion_redemptions','INSERT')
  and has_table_privilege('ontos_runtime','tax.gateway_assertion_redemptions','DELETE')
  and not has_table_privilege('ontos_runtime','tax.gateway_assertion_redemptions','UPDATE')
  and not has_table_privilege('ontos_runtime','tax.gateway_assertion_redemptions','REFERENCES')
  and not has_table_privilege('ontos_runtime','tax.gateway_assertion_redemptions','TRUNCATE')
  and not has_table_privilege('ontos_runtime','tax.gateway_assertion_redemptions','TRIGGER')
  and not exists(select 1 from pg_catalog.pg_class t join pg_catalog.pg_namespace ns on ns.oid=t.relnamespace,
    lateral pg_catalog.aclexplode(coalesce(t.relacl,pg_catalog.acldefault('r',t.relowner))) acl
    where ns.nspname='tax' and t.relname='gateway_assertion_redemptions' and acl.grantee=0)
) as valid`,
      'objects',
    )
    .pipe(Effect.mapError(() => new TaxVerificationError({ reason: 'Unable to verify gateway assertion redemption' })));
  if (!gateway?.valid) {
    return yield* new TaxVerificationError({
      reason: 'Gateway assertion redemption shape, replay identity, expiry index or exact privileges mismatch',
    });
  }
  const [infrastructure] = yield* database.executor
    .execute<InfrastructureRow>(
      sql`select count(distinct relation.oid)::integer as table_count, count(distinct relation.oid) filter (where relation.relrowsecurity and relation.relforcerowsecurity)::integer as force_rls_count, (select count(*)::integer from pg_catalog.pg_policy as policy inner join pg_catalog.pg_class as governed on governed.oid = policy.polrelid inner join pg_catalog.pg_namespace as governed_namespace on governed_namespace.oid = governed.relnamespace where governed_namespace.nspname = ${TAX_SCHEMA_NAME}) as policy_count, (select count(*)::integer from pg_catalog.pg_trigger as trigger_record inner join pg_catalog.pg_class as triggered on triggered.oid = trigger_record.tgrelid inner join pg_catalog.pg_namespace as trigger_namespace on trigger_namespace.oid = triggered.relnamespace where trigger_namespace.nspname = ${TAX_SCHEMA_NAME} and trigger_record.tgname like 'tax_%_append_only' and not trigger_record.tgisinternal) as append_only_trigger_count, (select count(*)::integer from pg_catalog.pg_class as journal inner join pg_catalog.pg_namespace as journal_namespace on journal_namespace.oid = journal.relnamespace where journal_namespace.nspname = 'drizzle' and journal.relname = '__drizzle_migrations_tax') as journal_count, has_schema_privilege('ontos_runtime', ${TAX_SCHEMA_NAME}, 'USAGE') as runtime_usage, has_schema_privilege('ontos_runtime', ${TAX_SCHEMA_NAME}, 'CREATE') as runtime_create, runtime_role.rolsuper as role_super, runtime_role.rolbypassrls as role_bypass_rls from pg_catalog.pg_class as relation inner join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace cross join pg_catalog.pg_roles as runtime_role where namespace.nspname = ${TAX_SCHEMA_NAME} and relation.relkind in ('r', 'p') and runtime_role.rolname = 'ontos_runtime' group by runtime_role.rolsuper, runtime_role.rolbypassrls`,
      'objects',
    )
    .pipe(Effect.mapError(() => new TaxVerificationError({ reason: 'Unable to verify Tax RLS and grants' })));
  if (
    infrastructure === undefined ||
    infrastructure.table_count !== TAX_TABLES.length ||
    infrastructure.force_rls_count !== TAX_TABLES.length - 1 ||
    infrastructure.policy_count !== expectedPolicyCount ||
    infrastructure.append_only_trigger_count !== TAX_TABLES.length - 1 ||
    infrastructure.journal_count !== 1 ||
    !infrastructure.runtime_usage ||
    infrastructure.runtime_create ||
    infrastructure.role_super ||
    infrastructure.role_bypass_rls
  ) {
    return yield* new TaxVerificationError({ reason: 'Tax owner isolation or append-only contract failed' });
  }
  return { adminUser: connections.admin.user, typedTableCount: TAX_TABLES.length };
});

const TaxVerifierLive = TaxDatabaseLive.pipe(
  Layer.provide(TaxPgClientLive),
  Layer.provide(
    Layer.mergeAll(
      Layer.effect(DatabaseConfig, loadDatabaseConnectionPair().pipe(Effect.map(({ admin }) => admin))),
      Reactivity.layer,
    ),
  ),
);

// The operator entry point: the composed layers are built once for the verification and released after it.
const program = Effect.scoped(
  Effect.gen(function* runTaxVerifier() {
    const services = yield* Layer.build(TaxVerifierLive);
    const { typedTableCount } = yield* verification.pipe(Effect.provideContext(services));
    yield* Console.log(`Verified ${typedTableCount} typed tables in PostgreSQL schema ${TAX_SCHEMA_NAME}`);
  }),
);

await Effect.runPromise(program);
