// @effect-diagnostics globalConsole:off strictEffectProvide:off -- Operator verifier boundary; expires: 2027-03-31.
import { DatabaseConfig, loadDatabaseConnectionPair } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { Array as EffectArray, Effect, Layer, Order, Schema } from 'effect';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Reactivity } from 'effect/reactivity';
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

const runtimePrivilegesAreUnsafe = (row: InfrastructureRow): boolean =>
  row.runtime_create ||
  row.runtime_select ||
  row.runtime_insert ||
  row.runtime_update ||
  row.runtime_delete ||
  row.role_super ||
  row.role_bypass_rls;

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

  const [gateway] = yield* database.executor
    .execute<{ readonly valid: boolean }>(
      sql`select (
  (select count(*) = 1 from pg_catalog.pg_class relation join pg_catalog.pg_namespace ns on ns.oid=relation.relnamespace
    where ns.nspname='assortment' and relation.relname='gateway_assertion_redemptions' and relation.relkind='r'
      and not relation.relrowsecurity and not relation.relforcerowsecurity)
  and (select count(*) = 5 from information_schema.columns where table_schema='assortment' and table_name='gateway_assertion_redemptions'
    and is_nullable='NO' and ((column_name in ('issuer','audience') and data_type='text')
      or (column_name='jti' and data_type='uuid')
      or (column_name in ('expires_at','redeemed_at') and data_type='timestamp with time zone')))
  and (select count(*) = 1 from pg_catalog.pg_constraint c join pg_catalog.pg_class t on t.oid=c.conrelid
    join pg_catalog.pg_namespace ns on ns.oid=t.relnamespace where ns.nspname='assortment' and t.relname='gateway_assertion_redemptions'
      and c.contype='u' and pg_catalog.pg_get_constraintdef(c.oid)='UNIQUE (issuer, audience, jti)')
  and (select count(*) = 1 from pg_catalog.pg_indexes where schemaname='assortment' and tablename='gateway_assertion_redemptions'
    and indexdef like '% USING btree (expires_at)')
  and has_table_privilege('ontos_runtime','assortment.gateway_assertion_redemptions','SELECT')
  and has_table_privilege('ontos_runtime','assortment.gateway_assertion_redemptions','INSERT')
  and has_table_privilege('ontos_runtime','assortment.gateway_assertion_redemptions','DELETE')
  and not has_table_privilege('ontos_runtime','assortment.gateway_assertion_redemptions','UPDATE')
  and not has_table_privilege('ontos_runtime','assortment.gateway_assertion_redemptions','REFERENCES')
  and not has_table_privilege('ontos_runtime','assortment.gateway_assertion_redemptions','TRUNCATE')
  and not has_table_privilege('ontos_runtime','assortment.gateway_assertion_redemptions','TRIGGER')
  and not exists(select 1 from pg_catalog.pg_class t join pg_catalog.pg_namespace ns on ns.oid=t.relnamespace,
    lateral pg_catalog.aclexplode(coalesce(t.relacl,pg_catalog.acldefault('r',t.relowner))) acl
    where ns.nspname='assortment' and t.relname='gateway_assertion_redemptions' and acl.grantee=0)
) as valid`,
      'objects',
    )
    .pipe(
      Effect.mapError(
        () => new AssortmentVerificationError({ reason: 'Unable to verify gateway assertion redemption' }),
      ),
    );
  if (!gateway?.valid) {
    return yield* new AssortmentVerificationError({
      reason: 'Gateway assertion redemption shape, replay identity, expiry index or exact privileges mismatch',
    });
  }
  const [infrastructure] = yield* database.executor
    .execute<InfrastructureRow>(
      sql`select count(distinct relation.oid)::integer as table_count, count(distinct relation.oid) filter (where relation.relrowsecurity and relation.relforcerowsecurity)::integer as force_rls_count, (select count(*)::integer from pg_catalog.pg_policy as policy inner join pg_catalog.pg_class as governed on governed.oid = policy.polrelid inner join pg_catalog.pg_namespace as governed_namespace on governed_namespace.oid = governed.relnamespace where governed_namespace.nspname = ${ASSORTMENT_SCHEMA_NAME}) as policy_count, (select count(*)::integer from pg_catalog.pg_trigger as trigger_record inner join pg_catalog.pg_class as triggered on triggered.oid = trigger_record.tgrelid inner join pg_catalog.pg_namespace as trigger_namespace on trigger_namespace.oid = triggered.relnamespace where trigger_namespace.nspname = ${ASSORTMENT_SCHEMA_NAME} and trigger_record.tgname like 'assortment_%_append_only' and not trigger_record.tgisinternal) as append_only_trigger_count, (select count(*)::integer from pg_catalog.pg_class as journal inner join pg_catalog.pg_namespace as journal_namespace on journal_namespace.oid = journal.relnamespace where journal_namespace.nspname = 'drizzle' and journal.relname = '__drizzle_migrations_assortment') as journal_count, has_schema_privilege('ontos_runtime', ${ASSORTMENT_SCHEMA_NAME}, 'CREATE') as runtime_create, bool_or(has_table_privilege('ontos_runtime', format('%I.%I', namespace.nspname, relation.relname), 'SELECT')) filter (where relation.relname <> ${'gateway_assertion_redemptions'}) as runtime_select, bool_or(has_table_privilege('ontos_runtime', format('%I.%I', namespace.nspname, relation.relname), 'INSERT')) filter (where relation.relname <> ${'gateway_assertion_redemptions'}) as runtime_insert, bool_or(has_table_privilege('ontos_runtime', format('%I.%I', namespace.nspname, relation.relname), 'UPDATE')) filter (where relation.relname <> ${'gateway_assertion_redemptions'}) as runtime_update, bool_or(has_table_privilege('ontos_runtime', format('%I.%I', namespace.nspname, relation.relname), 'DELETE')) filter (where relation.relname <> ${'gateway_assertion_redemptions'}) as runtime_delete, runtime_role.rolsuper as role_super, runtime_role.rolbypassrls as role_bypass_rls from pg_catalog.pg_class as relation inner join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace cross join pg_catalog.pg_roles as runtime_role where namespace.nspname = ${ASSORTMENT_SCHEMA_NAME} and relation.relkind in ('r', 'p') and runtime_role.rolname = 'ontos_runtime' group by runtime_role.rolsuper, runtime_role.rolbypassrls`,
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
    infrastructure.force_rls_count !== ASSORTMENT_TABLES.length - 1 ||
    infrastructure.policy_count !== (ASSORTMENT_TABLES.length - 1) * 4 + 1 ||
    infrastructure.append_only_trigger_count !== ASSORTMENT_TABLES.length - 2 ||
    fenceTriggers[0]?.trigger_count !== DECISION_SET_FENCE_SOURCE_TABLES.length ||
    infrastructure.journal_count !== 1 ||
    runtimePrivilegesAreUnsafe(infrastructure)
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
