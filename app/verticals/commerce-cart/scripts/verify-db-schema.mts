import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { getTableName } from 'drizzle-orm';
import { Effect, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import {
  COMMERCE_CART_SCHEMA_NAME,
  COMMERCE_CART_TABLES,
  COMMERCE_CART_BUSINESS_TABLES,
} from '../src/database/schema.ts';

class CartSchemaVerificationError extends Schema.TaggedError<CartSchemaVerificationError>()(
  'CartSchemaVerificationError',
  { reason: Schema.String },
) {}
const failure = (cause?: unknown) => {
  const error = new CartSchemaVerificationError({
    reason: 'Commerce Cart database ownership or consistency infrastructure is invalid',
  });
  return cause === undefined ? error : Object.defineProperty(error, 'cause', { value: cause });
};
const expectedTables = new Set<string>(COMMERCE_CART_TABLES.map(getTableName));
const businessTables = new Set<string>(COMMERCE_CART_BUSINESS_TABLES.map(getTableName));
const expectedFunctions = [
  'check_cart_population_consistency',
  'check_final_cart_candidate',
  'guard_cart_head_update',
  'guard_population_generation',
  'reject_immutable_change',
];
interface TableRow {
  readonly enabled: boolean;
  readonly forced: boolean;
  readonly table_name: string;
}
interface CheckRow {
  readonly deferred_count: number;
  readonly functions: readonly string[];
  readonly journal_count: number;
  readonly policy_count: number;
  readonly replay_infrastructure_safe: boolean;
  readonly runtime_bypass_rls: boolean;
  readonly runtime_create: boolean;
  readonly runtime_super: boolean;
  readonly runtime_usage: boolean;
  readonly trigger_count: number;
  readonly unsafe_functions: number;
}
const verify = Effect.gen(function* verifyCartSchemaEffect() {
  const connections = yield* loadDatabaseConnectionPair();
  const client = yield* PgClient.makeClient({ url: Redacted.make(connections.admin.connectionString) }).pipe(
    Effect.mapError(failure),
  );
  // Infrastructure-only catalog inspection. Business queries remain typed Drizzle.
  const tables = yield* client
    .unsafe<TableRow>(
      `select c.relname table_name, c.relforcerowsecurity forced, c.relrowsecurity enabled
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname=$1 and c.relkind in ('r','p') order by c.relname`,
      [COMMERCE_CART_SCHEMA_NAME],
    )
    .pipe(Effect.mapError(failure));
  if (
    tables.length !== expectedTables.size ||
    tables.some(
      (row) =>
        !expectedTables.has(row.table_name) ||
        (businessTables.has(row.table_name) ? !row.forced || !row.enabled : row.forced || row.enabled),
    )
  ) {
    return yield* failure();
  }
  const [state] = yield* client
    .unsafe<CheckRow>(
      `select
    (select count(*)::int from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid=t.tgrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and not t.tgisinternal and t.tgdeferrable and t.tginitdeferred and t.tgname=c.relname||'_population_consistency') deferred_count,
    (select count(*)::int from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid=t.tgrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and not t.tgisinternal) trigger_count,
    (select count(*)::int from pg_catalog.pg_policies where schemaname=$1) policy_count,
    (select count(*)::int from information_schema.tables where table_schema='drizzle' and table_name='__drizzle_migrations_commerce_cart') journal_count,
    (select count(*)::int from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname=$1 and (p.prosecdef or p.proconfig is distinct from array['search_path=pg_catalog, commerce_cart, pg_temp']::text[])) unsafe_functions,
    (select array_agg(p.proname order by p.proname) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname=$1) functions,
    (select rolsuper from pg_catalog.pg_roles where rolname=$2) runtime_super,
    (select rolbypassrls from pg_catalog.pg_roles where rolname=$2) runtime_bypass_rls,
    has_schema_privilege($2,$1,'CREATE') runtime_create, has_schema_privilege($2,$1,'USAGE') runtime_usage,
      (has_table_privilege($2,'commerce_cart.gateway_assertion_redemptions','INSERT')
       and has_column_privilege($2,'commerce_cart.gateway_assertion_redemptions','jti','SELECT')
       and exists (select 1 from pg_catalog.pg_constraint c where c.conrelid='commerce_cart.gateway_assertion_redemptions'::regclass
         and c.conname='cart_gateway_assertion_redemptions_identity_uk' and c.contype='u'
         and pg_catalog.pg_get_constraintdef(c.oid)='UNIQUE (issuer, audience, jti)')) replay_infrastructure_safe`,
      [COMMERCE_CART_SCHEMA_NAME, decodeURIComponent(new URL(connections.runtime.connectionString).username)],
    )
    .pipe(Effect.mapError(failure));
  if (
    state === undefined ||
    state.deferred_count !== 9 ||
    state.trigger_count !== 20 ||
    state.policy_count !== 33 ||
    !state.replay_infrastructure_safe ||
    state.journal_count !== 1 ||
    state.unsafe_functions !== 0 ||
    state.runtime_super ||
    state.runtime_bypass_rls ||
    state.runtime_create ||
    !state.runtime_usage ||
    state.functions.length !== expectedFunctions.length ||
    state.functions.some((name, index) => name !== expectedFunctions[index])
  ) {
    return yield* failure();
  }
  return state;
});
await Effect.runPromise(verify.pipe(Effect.scoped, Effect.provide(Reactivity.layer)));
process.stdout.write(
  `Verified ${COMMERCE_CART_BUSINESS_TABLES.length} governed business tables and one technical ingress table in ${COMMERCE_CART_SCHEMA_NAME}\n`,
);
