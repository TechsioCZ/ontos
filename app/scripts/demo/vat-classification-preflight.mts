#!/usr/bin/env node
/**
 * Read-only VAT preflight for the Merchandise classification migration, through governed reads only (staff sign-in,
 * company switch, gateway context, `merchandise` `reads/records`), so it runs against stage without database access:
 *
 *   ONTOS_DEMO_SEED_URL=https://… ONTOS_DEMO_SEED_PASSWORD=… \
 *   ONTOS_VAT_PREFLIGHT_TARGETS='[{"label":"Obchodní firma","email":"…","tenantId":"…","legalEntityId":"…"}]' \
 *   pnpm demo:vat-preflight
 *
 * Per company it reports products and order lines by their stored VAT rate, every product at 10 % (it becomes reduced
 * and keeps its net and gross prices exactly) and every product the migration cannot map (a rate other than 21, 12
 * and 10): the deploy stops on these, so they must be decided first. Order lines keep their rate and amounts; only
 * lines at 21 and 12 % gain a classification. Exit code 0: the migration maps every product; 2: blocking products.
 */
import { NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, Exit, Layer, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';

import { connectSeedClient, SeedLegalEntityId, SeedTenantId } from './seed-client.mts';
import type { SeedClient } from './seed-client.mts';

const PAGE = 250;
const MAPPED_RATES = new Set([21, 12, 10]);

const TargetsSchema = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      email: Schema.String,
      label: Schema.String,
      legalEntityId: SeedLegalEntityId,
      tenantId: SeedTenantId,
    }),
  ),
);
type Target = (typeof TargetsSchema.Type)[number];

/** The staff records read's paging view; the deployed (pre-migration) Merchandise accepts the same fields. */
const PageRequestSchema = Schema.Struct({
  view: Schema.Struct({
    limit: Schema.Int,
    offset: Schema.optionalKey(Schema.Int),
    ordersLimit: Schema.Int,
    ordersOffset: Schema.optionalKey(Schema.Int),
    productSort: Schema.optionalKey(Schema.Literal('sku')),
    summary: Schema.Boolean,
  }),
});
/** Only what the preflight needs, from either shape: products carry `vatRate` before and a classification after. */
const ProductRowSchema = Schema.Struct({
  currentPriceMinor: Schema.Number,
  grossPriceMinor: Schema.optionalKey(Schema.Number),
  id: Schema.String,
  name: Schema.String,
  sku: Schema.String,
  taxClassificationCode: Schema.optionalKey(Schema.String),
  vatRate: Schema.optionalKey(Schema.Number),
});
type ProductRow = typeof ProductRowSchema.Type;
const OrderRowSchema = Schema.Struct({
  lines: Schema.Array(Schema.Struct({ vatRate: Schema.Number })),
  number: Schema.String,
});
type OrderRow = typeof OrderRowSchema.Type;
const PageSchema = Schema.Struct({
  orders: Schema.Array(OrderRowSchema),
  products: Schema.Array(ProductRowSchema),
  totalOrders: Schema.optionalKey(Schema.Number),
  totalProducts: Schema.optionalKey(Schema.Number),
});

const readPage = (client: SeedClient, view: typeof PageRequestSchema.Type.view) =>
  client.call('merchandise', '/reads/records', PageRequestSchema, { view }, PageSchema);

/** Every page of one collection, until the reported total or an empty page. */
const allPages = <A, E, R>(
  page: (offset: number) => Effect.Effect<{ readonly items: readonly A[]; readonly total: number }, E, R>,
) =>
  Effect.gen(function* readAllPages() {
    const items: A[] = [];
    let total = Number.POSITIVE_INFINITY;
    for (let offset = 0; offset < total; offset += PAGE) {
      const next = yield* page(offset);
      items.push(...next.items);
      ({ total } = next);
      if (next.items.length === 0) {
        break;
      }
    }
    return items;
  });

const countBy = <A,>(items: readonly A[], key: (item: A) => string) =>
  Object.fromEntries(
    [...Map.groupBy(items, key)]
      .map(([group, members]) => [group, members.length] as const)
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );

const rateOf = (product: ProductRow) =>
  product.vatRate === undefined ? (product.taxClassificationCode ?? 'missing') : String(product.vatRate);

const companyReport = (target: Target, products: readonly ProductRow[], orders: readonly OrderRow[]) => {
  const priceOf = (product: ProductRow) => ({
    gross: product.grossPriceMinor ?? null,
    name: product.name,
    net: product.currentPriceMinor,
    sku: product.sku,
  });
  const migrated = products.length > 0 && products.every((product) => product.vatRate === undefined);
  return {
    blocking: products
      .filter((product) => !migrated && (product.vatRate === undefined || !MAPPED_RATES.has(product.vatRate)))
      .map((product) => ({ ...priceOf(product), rate: rateOf(product) })),
    company: target.label,
    migrated,
    orderLinesByRate: countBy(
      orders.flatMap((order) => order.lines),
      (line) => String(line.vatRate),
    ),
    ordersWithLinesOutside21And12: orders
      .filter((order) => order.lines.some((line) => line.vatRate !== 21 && line.vatRate !== 12))
      .map((order) => order.number),
    productsAt10: products.filter((product) => product.vatRate === 10).map(priceOf),
    productsByRate: countBy(products, rateOf),
  };
};

const preflightCompany = (shellUrl: string, password: Config.Success<ReturnType<typeof Config.Redacted>>) =>
  Effect.fn('VatPreflight.company')(function* preflightOneCompany(target: Target) {
    const client = yield* Effect.acquireRelease(
      connectSeedClient(
        { legalEntityId: target.legalEntityId, shellUrl, tenantId: target.tenantId },
        target.email,
        password,
      ),
      (connected) => connected.signOut.pipe(Effect.ignore),
    );
    const products = yield* allPages((offset) =>
      readPage(client, { limit: PAGE, offset, ordersLimit: 0, productSort: 'sku', summary: true }).pipe(
        Effect.map((page) => ({ items: page.products, total: page.totalProducts ?? 0 })),
      ),
    );
    const orders = yield* allPages((ordersOffset) =>
      readPage(client, { limit: 0, ordersLimit: PAGE, ordersOffset, summary: true }).pipe(
        Effect.map((page) => ({ items: page.orders, total: page.totalOrders ?? 0 })),
      ),
    );
    return companyReport(target, products, orders);
  });

const preflight = Effect.gen(function* vatPreflight() {
  const shellUrl = yield* Config.String('ONTOS_DEMO_SEED_URL');
  const password = yield* Config.Redacted('ONTOS_DEMO_SEED_PASSWORD');
  const targets = yield* Config.schema(TargetsSchema, 'ONTOS_VAT_PREFLIGHT_TARGETS');
  const reports = yield* Effect.forEach(
    targets,
    (target) => Effect.scoped(preflightCompany(shellUrl, password)(target)),
    {
      concurrency: 1,
    },
  );
  yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ companies: reports }));
  const blocking = reports.flatMap((report) => report.blocking);
  if (blocking.length > 0) {
    yield* Console.error(`${blocking.length} products have a VAT rate the migration cannot map; decide them first.`);
  }
  return blocking.length === 0;
});

if (import.meta.main) {
  const result = await Effect.runPromiseExit(
    preflight.pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
  );
  process.exitCode = Exit.match(result, { onFailure: () => 1, onSuccess: (mapped) => (mapped ? 0 : 2) });
}
