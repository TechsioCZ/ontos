import { DatabaseConfig, loadDatabaseConnectionPair } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Array as EffectArray, Console, Effect, Layer, Order, Schema } from 'effect';
import { PromotionDatabase, PromotionDatabaseLive, PromotionPgClientLive } from '../src/database/client.ts';
import { Reactivity } from 'effect/reactivity';
import { promotionTables } from '../src/services/persistence-schema.service.ts';

class PromotionVerificationFailed extends Schema.TaggedError<PromotionVerificationFailed>()(
  'PromotionVerificationFailed',
  { reason: Schema.String },
) {}
const failed = <Cause,>(cause?: Cause) =>
  Object.defineProperty(
    new PromotionVerificationFailed({
      reason: 'Promotion schema, columns, RLS, journal or grants differ from the owner contract',
    }),
    'cause',
    { enumerable: false, value: cause },
  );
const typedTables = Object.values(promotionTables).map(getTableConfig);
const expectedColumns = EffectArray.sort(
  typedTables.flatMap((t) => t.columns.map((c) => `${t.name}.${c.name}`)),
  Order.String,
);
const immutableTables = new Set([
  'published_promotions',
  'lifecycle_facts',
  'vouchers',
  'voucher_disable_facts',
  'issued_proofs',
  'policy_changes',
]);
const program = Effect.gen(function* verifyPromotion() {
  const database = (yield* PromotionDatabase).executor;
  const rows = yield* database
    .execute<{ column_name: string; table_name: string }>(
      sql`select table_name, column_name from information_schema.columns where table_schema = 'promotion' order by table_name, column_name`,
      'objects',
    )
    .pipe(Effect.mapError(failed));
  const actualColumns = EffectArray.sort(
    rows.map((r) => `${r.table_name}.${r.column_name}`),
    Order.String,
  );
  if (actualColumns.length !== expectedColumns.length || actualColumns.some((v, i) => v !== expectedColumns[i])) {
    return yield* failed();
  }
  const tables = yield* database
    .execute<{
      can_create: boolean;
      can_delete: boolean;
      can_insert: boolean;
      can_select: boolean;
      can_update: boolean;
      enabled: boolean;
      forced: boolean;
      name: string;
    }>(
      sql`select c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced, has_schema_privilege('ontos_runtime', 'promotion', 'CREATE') as can_create, has_table_privilege('ontos_runtime', c.oid, 'SELECT') as can_select, has_table_privilege('ontos_runtime', c.oid, 'INSERT') as can_insert, has_table_privilege('ontos_runtime', c.oid, 'UPDATE') as can_update, has_table_privilege('ontos_runtime', c.oid, 'DELETE') as can_delete from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = 'promotion' and c.relkind in ('r', 'p')`,
      'objects',
    )
    .pipe(Effect.mapError(failed));
  if (tables.length !== typedTables.length) {
    return yield* failed();
  }
  for (const table of tables) {
    const auth = table.name === 'gateway_assertion_redemptions';
    const mutable = ['promotion_drafts', 'tenant_generations', 'selection_policies', 'basis_policies'].includes(
      table.name,
    );
    if (
      table.enabled !== !auth ||
      table.forced !== !auth ||
      table.can_create ||
      !table.can_select ||
      !table.can_insert ||
      table.can_update !== mutable ||
      table.can_delete !== auth ||
      (immutableTables.has(table.name) && table.can_update)
    ) {
      return yield* failed();
    }
  }
  const journals = yield* database
    .execute<{ present: boolean }>(
      sql`select to_regclass('drizzle.__drizzle_migrations_promotion') is not null as present`,
      'objects',
    )
    .pipe(Effect.mapError(failed));
  if (!journals[0]?.present) {
    return yield* failed();
  }
  return yield* Console.log(
    `Verified ${typedTables.length} typed tables, exact columns, forced Tenant RLS, immutable grants and Promotion journal`,
  );
});
const configuration = Layer.effect(DatabaseConfig, loadDatabaseConnectionPair().pipe(Effect.map(({ admin }) => admin)));
await Effect.runPromise(
  Effect.scoped(program).pipe(
    Effect.provide(
      PromotionDatabaseLive.pipe(
        Layer.provide(PromotionPgClientLive),
        Layer.provide(Reactivity.layer),
        Layer.provide(configuration),
      ),
    ),
  ),
);
