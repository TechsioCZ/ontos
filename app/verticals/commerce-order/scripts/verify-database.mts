import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Array as EffectArray, Effect, Layer, Order, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import {
  COMMERCE_ORDER_SCHEMA_NAME,
  COMMERCE_ORDER_TABLE_INVENTORY,
  COMMERCE_ORDER_TABLES,
  commerceOrderRelations,
} from '../src/db/schema.ts';

class OrderSchemaVerificationFailed extends Schema.TaggedError<OrderSchemaVerificationFailed>()(
  'OrderSchemaVerificationFailed',
  { reason: Schema.String },
) {}
const failure = (cause?: unknown) => {
  const error = new OrderSchemaVerificationFailed({ reason: 'Order database infrastructure is absent or unsafe' });
  return cause === undefined ? error : Object.defineProperty(error, 'cause', { value: cause });
};
const sortedTableInventory = EffectArray.sort(COMMERCE_ORDER_TABLE_INVENTORY, Order.String);
const expectedTriggers = [
  'order_attempt_no_delete',
  'order_attempt_transition',
  'order_bundles_immutable',
  'order_consumption_no_delete',
  'order_consumption_transition',
  'order_finalization_no_delete',
  'order_finalization_transition',
  'order_history_immutable',
  'order_orders_immutable',
];
const verify = Effect.gen(function* verifyOrderSchema() {
  const client = yield* PgClient.PgClient;
  const database = yield* makeWithDefaults({ relations: commerceOrderRelations });
  // Every owner table is also reached through its typed Drizzle reference.
  for (const table of COMMERCE_ORDER_TABLES) {
    yield* database.select().from(table).limit(0).pipe(Effect.mapError(failure));
  }
  const tables = yield* client
    .unsafe<{ readonly forced: boolean; readonly name: string; readonly unsafe: boolean }>(
      `
    select c.relname as name,
      case when c.relname = 'gateway_assertion_redemptions' then not c.relrowsecurity and not c.relforcerowsecurity
        else c.relrowsecurity and c.relforcerowsecurity end as forced,
      case when c.relname = 'gateway_assertion_redemptions' then
        not has_table_privilege('ontos_runtime', c.oid, 'SELECT') or not has_table_privilege('ontos_runtime', c.oid, 'INSERT')
        or not has_table_privilege('ontos_runtime', c.oid, 'DELETE') or has_table_privilege('ontos_runtime', c.oid, 'UPDATE')
        or has_table_privilege('ontos_runtime', c.oid, 'REFERENCES')
        else has_table_privilege('ontos_runtime', c.oid, 'DELETE') end
      or has_table_privilege('ontos_runtime', c.oid, 'TRUNCATE') or has_table_privilege('ontos_runtime', c.oid, 'TRIGGER') as unsafe
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname=$1 and c.relkind in ('r','p') order by c.relname`,
      [COMMERCE_ORDER_SCHEMA_NAME],
    )
    .pipe(Effect.mapError(failure));
  if (
    tables.length !== COMMERCE_ORDER_TABLES.length ||
    tables.some((table, index) => table.name !== sortedTableInventory[index] || !table.forced || table.unsafe)
  ) {
    yield* failure();
  }
  const triggers = yield* client
    .unsafe<{ readonly name: string }>(
      `select t.tgname as name from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid=t.tgrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and not t.tgisinternal order by t.tgname`,
      [COMMERCE_ORDER_SCHEMA_NAME],
    )
    .pipe(Effect.mapError(failure));
  if (
    triggers.length !== expectedTriggers.length ||
    triggers.some((trigger, index) => trigger.name !== expectedTriggers[index])
  ) {
    yield* failure();
  }
  const [intentAuthority] = yield* client
    .unsafe<{
      readonly constraints: number;
      readonly safe_privileges: boolean;
    }>(
      `select
        (select count(*)::integer from pg_catalog.pg_constraint k
          where k.conrelid = 'commerce_order.finalization_intents'::regclass
            and k.conname = any(array[
              'order_finalization_scope_id_uk', 'order_finalization_business_uk',
              'order_finalization_proof_uk', 'order_finalization_attempt_fk',
              'order_finalization_stage_ck', 'order_finalization_result_ck',
              'order_finalization_hash_ck'
            ])) as constraints,
        has_table_privilege('ontos_runtime', c.oid, 'SELECT')
          and has_table_privilege('ontos_runtime', c.oid, 'INSERT')
          and not has_table_privilege('ontos_runtime', c.oid, 'UPDATE')
          and not has_table_privilege('ontos_runtime', c.oid, 'REFERENCES')
          and not exists (
            select 1 from pg_catalog.pg_attribute a
            where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
              and has_column_privilege('ontos_runtime', c.oid, a.attnum, 'UPDATE')
                is distinct from (a.attname = any(array['status', 'result', 'proof_ref']))
          )
          and not exists (
            select 1 from pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) acl
            where acl.grantee = 0
          ) as safe_privileges
      from pg_catalog.pg_class c
      where c.oid = 'commerce_order.finalization_intents'::regclass`,
    )
    .pipe(Effect.mapError(failure));
  if (intentAuthority === undefined || intentAuthority.constraints !== 7 || !intentAuthority.safe_privileges) {
    yield* failure();
  }
  const [infrastructure] = yield* client
    .unsafe<{
      readonly approval_unique: number;
      readonly foreign_keys: number;
      readonly journal: number;
      readonly policies: number;
      readonly safe_role: boolean;
      readonly safe_schema: boolean;
    }>(
      `
    select (select count(*)::integer from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='drizzle' and c.relname='__drizzle_migrations_commerce_order') as journal,
      not r.rolsuper and not r.rolbypassrls as safe_role,
      has_schema_privilege('ontos_runtime',$1,'USAGE') and not has_schema_privilege('ontos_runtime',$1,'CREATE') as safe_schema,
      (select count(*)::integer from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid=p.polrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname=$1) as policies,
      (select count(*)::integer from pg_catalog.pg_constraint k join pg_catalog.pg_namespace n on n.oid=k.connamespace where n.nspname=$1 and k.conname='order_orders_approval_request_uk' and k.contype='u') as approval_unique,
      (select count(*)::integer from pg_catalog.pg_constraint k join pg_catalog.pg_namespace n on n.oid=k.connamespace where n.nspname=$1 and k.contype='f' and cardinality(k.conkey)>=3) as foreign_keys
    from pg_catalog.pg_roles r where r.rolname='ontos_runtime'`,
      [COMMERCE_ORDER_SCHEMA_NAME],
    )
    .pipe(Effect.mapError(failure));
  if (
    infrastructure === undefined ||
    infrastructure.journal !== 1 ||
    !infrastructure.safe_role ||
    !infrastructure.safe_schema ||
    infrastructure.policies !== 24 ||
    infrastructure.approval_unique !== 1 ||
    infrastructure.foreign_keys !== 6
  ) {
    yield* failure();
  }
});
const databaseLayer = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* connectOrderVerifier() {
    const connections = yield* loadDatabaseConnectionPair();
    return yield* PgClient.makeClient({ url: Redacted.make(connections.admin.connectionString) }).pipe(
      Effect.mapError(failure),
    );
  }),
).pipe(Layer.provide(Reactivity.layer));
await Effect.runPromise(verify.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(Reactivity.layer, databaseLayer))));
process.stdout.write('Verified commerce.order durable commitment tables, scope, immutability and uniqueness\n');
