/**
 * Read-only VAT preflight for the classification migration (`pnpm --filter @app/merchandise vat:preflight`).
 * Run it against the database a deploy will migrate (DATABASE_ADMIN_URL, e.g. stage) BEFORE the push:
 *
 * - per tenant and company: products and order lines by their stored VAT rate;
 * - every product at 10 %: it becomes reduced (12 %), keeps its net price and gets new gross prices (listed);
 * - every product the migration cannot map (0 % or any rate other than 21, 12 and 10): the deploy stops on these,
 *   so they must be decided first; order lines at 0 % keep 0 % and get no classification.
 *
 * Exit code 0: the migration maps everything. Exit code 2: blocking rows exist. Nothing is written; the queries run in
 * one read-only transaction. A database that already has the classification column reports that and exits 0.
 */
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Config, Console, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';

const ProductRateRowSchema = Schema.Struct({
  legal_entity_id: Schema.String,
  products: Schema.Number,
  rate: Schema.NullOr(Schema.String),
  tenant_id: Schema.String,
});
const LineRateRowSchema = Schema.Struct({
  legal_entity_id: Schema.String,
  lines: Schema.Number,
  orders: Schema.Number,
  rate: Schema.NullOr(Schema.String),
  tenant_id: Schema.String,
});
const RepricedRowSchema = Schema.Struct({
  current_gross: Schema.NullOr(Schema.Number),
  id: Schema.String,
  legal_entity_id: Schema.String,
  name: Schema.String,
  net: Schema.Number,
  new_gross: Schema.Number,
  sku: Schema.String,
  tenant_id: Schema.String,
  tiers: Schema.Number,
  variants: Schema.Number,
});
const BlockingRowSchema = Schema.Struct({
  id: Schema.String,
  legal_entity_id: Schema.String,
  name: Schema.String,
  rate: Schema.NullOr(Schema.String),
  sku: Schema.String,
  tenant_id: Schema.String,
});

const MAPPED_LINE_RATES = new Set(['21', '12', '10', '0']);

const CLASSIFICATION_BY_RATE = new Map([
  ['10', 'reduced'],
  ['12', 'reduced'],
  ['21', 'standard'],
]);
const classificationOf = (rate: string | null) =>
  CLASSIFICATION_BY_RATE.get(rate ?? '') ?? 'NO MAPPING (blocks the deploy)';

const company = (row: { readonly legal_entity_id: string; readonly tenant_id: string }) =>
  `${row.tenant_id} / ${row.legal_entity_id}`;

const money = (minor: number | null) => (minor === null ? '—' : `${(minor / 100).toFixed(2)} Kč`);

const preflight = Effect.gen(function* vatPreflight() {
  const sql = yield* PgClient.PgClient;
  return yield* sql.withTransaction(
    Effect.gen(function* readOnlyPreflight() {
      yield* sql.unsafe('set transaction read only');
      const migrated = yield* sql.unsafe<{ readonly present: boolean }>(
        `select exists (select 1 from information_schema.columns where table_schema = 'demo_merchandise'
           and table_name = 'products' and column_name = 'tax_classification_code') as present`,
      );
      if (migrated[0]?.present) {
        yield* Console.log('The classification migration has already run on this database; nothing to check.');
        return 0;
      }
      const productRates = yield* sql
        .unsafe(
          `select tenant_id::text, legal_entity_id::text, document->>'vatRate' as rate, count(*)::int as products
             from demo_merchandise.products group by 1, 2, 3 order by 1, 2, 3`,
        )
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ProductRateRowSchema))));
      const lineRates = yield* sql
        .unsafe(
          `select o.tenant_id::text, o.legal_entity_id::text, line->>'vatRate' as rate,
                  count(*)::int as lines, count(distinct o.id)::int as orders
             from demo_merchandise.orders as o
             cross join lateral jsonb_array_elements(o.document->'lines') as line
            group by 1, 2, 3 order by 1, 2, 3`,
        )
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(LineRateRowSchema))));
      const repriced = yield* sql
        .unsafe(
          `select p.tenant_id::text, p.legal_entity_id::text, p.id, p.sku, p.name,
                  p.current_price_minor::int as net, p.gross_price_minor::int as current_gross,
                  (p.current_price_minor + floor((p.current_price_minor * 12 + 50) / 100))::int as new_gross,
                  (select count(*)::int from demo_merchandise.product_variants as v
                    where v.tenant_id = p.tenant_id and v.legal_entity_id = p.legal_entity_id and v.product_id = p.id
                      and v.price_minor is not null) as variants,
                  (select count(*)::int from demo_merchandise.price_tiers as t
                    where t.tenant_id = p.tenant_id and t.legal_entity_id = p.legal_entity_id
                      and t.product_id = p.id) as tiers
             from demo_merchandise.products as p
            where p.document->>'vatRate' = '10'
            order by 1, 2, p.sku`,
        )
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(RepricedRowSchema))));
      const blocking = yield* sql
        .unsafe(
          `select tenant_id::text, legal_entity_id::text, id, sku, name, document->>'vatRate' as rate
             from demo_merchandise.products
            where coalesce(document->>'vatRate', '') not in ('21', '12', '10')
            order by 1, 2, sku`,
        )
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(BlockingRowSchema))));

      yield* Console.log('Products by stored VAT rate (tenant / company: rate -> classification: count)');
      for (const row of productRates) {
        yield* Console.log(
          `  ${company(row)}: ${row.rate ?? 'missing'} % -> ${classificationOf(row.rate)}: ${String(row.products)}`,
        );
      }
      yield* Console.log('Order lines by stored VAT rate (they keep their rate; classification added)');
      for (const row of lineRates) {
        const mapped = MAPPED_LINE_RATES.has(row.rate ?? '') ? '' : '  NO MAPPING (blocks the deploy)';
        const target = row.rate === '0' ? 'no classification' : classificationOf(row.rate);
        yield* Console.log(
          `  ${company(row)}: ${row.rate ?? 'missing'} % -> ${target}: ${String(row.lines)} lines in ${String(row.orders)} orders${mapped}`,
        );
      }
      yield* Console.log(`Products at 10 % that become reduced (12 %): ${String(repriced.length)}`);
      for (const row of repriced) {
        yield* Console.log(
          `  ${company(row)} ${row.sku} „${row.name}“: net ${money(row.net)} stays, gross ${money(row.current_gross)} -> ${money(row.new_gross)} (product), ${String(row.variants)} priced variants and ${String(row.tiers)} price tiers recomputed from net`,
        );
      }
      const blockingLines = lineRates.filter((row) => !MAPPED_LINE_RATES.has(row.rate ?? ''));
      yield* Console.log(`Products the migration cannot map: ${String(blocking.length)}`);
      for (const row of blocking) {
        yield* Console.log(`  ${company(row)} ${row.sku} „${row.name}“ (${row.id}): ${row.rate ?? 'missing'} %`);
      }
      const blocked = blocking.length > 0 || blockingLines.length > 0;
      yield* Console.log(
        blocked
          ? 'BLOCKED: decide the products above (or fix the order lines) before deploying the migration.'
          : 'OK: the migration maps every product and order line.',
      );
      return blocked ? 2 : 0;
    }),
  );
});

const AdminDatabaseLive = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* adminClient() {
    const connection = yield* Config.schema(
      Schema.Redacted(Schema.String.check(Schema.isMinLength(1))),
      'DATABASE_ADMIN_URL',
    );
    return yield* PgClient.makeClient({ url: connection });
  }),
).pipe(Layer.provide(Reactivity.layer));

/** Reads DATABASE_ADMIN_URL from the environment only: the operator names the database to check explicitly. */
const program = preflight.pipe(
  Effect.flatMap((exitCode) =>
    exitCode === 0 ? Effect.void : Effect.fail(new Error('VAT preflight found rows the migration cannot map')),
  ),
);

NodeRuntime.runMain(program.pipe(Effect.provide(Layer.mergeAll(AdminDatabaseLive, NodeServices.layer))));
