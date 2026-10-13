import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Command, Flag } from 'effect/unstable/cli';
import { Config, ConfigProvider, Console, DateTime, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { demoId, demoLegalEntityId, demoTenantId } from '../../../scripts/demo/fixture-ids.mts';
import {
  catalog,
  openingReceiptQuantity,
  orders as plannedOrders,
  priceChangeDaysAgo,
  productByKey,
  snapshotPriceMinor,
} from '../../../scripts/demo/sales-plan.mts';
import type { CatalogProduct, PlannedOrder } from '../../../scripts/demo/sales-plan.mts';
import { MerchandiseStateSchema } from '../shared/apis/records.ts';
import type { MerchandiseState } from '../shared/apis/records.ts';
import { OrderLineSchema } from '../shared/domain/merchandise-model.ts';
import { ORDER_NUMBER_PREFIX, orderTotals } from '../shared/domain/order-totals.ts';
import { merchandiseRelations, merchandiseStates } from '../src/database/schema.ts';

class ResetInputError extends Schema.TaggedError<ResetInputError>()('ResetInputError', { reason: Schema.String }) {}

type EncodedMerchandiseState = typeof MerchandiseStateSchema.Encoded;

/** Fixed reference instant (same as the workforce seed) so repeated resets write byte-identical state. */
const SEED_INSTANT = DateTime.makeUnsafe('2026-10-13T08:00:00Z');
const PRODUCT_CREATED_DAYS_AGO = 400;
const OPENING_RECEIPT_DAYS_AGO = 395;
const OPENING_RECEIPT_NOTE = 'Počáteční stav';
const ADJUSTMENT_NOTE = 'Inventura';
const MOVEMENT_NAMESPACE = 'stock-movement';

/** Recent stock corrections after the opening receipt; each one moves on-hand by `delta`. */
const STOCK_ADJUSTMENTS = [
  { daysAgo: 6, delta: -2, key: 'p06' },
  { daysAgo: 9, delta: 1, key: 'p12' },
] as const;

const daysAgo = (days: number): string => DateTime.formatIso(DateTime.subtract(SEED_INSTANT, { days }));

const productState = (product: CatalogProduct): EncodedMerchandiseState['products'][number] => {
  const repriced = product.currentPriceMinor !== product.originalPriceMinor;
  const createdAt = daysAgo(PRODUCT_CREATED_DAYS_AGO);
  return {
    active: true,
    category: product.category,
    createdAt,
    currentPriceMinor: product.currentPriceMinor,
    id: demoId('product', product.key),
    lowStockThreshold: product.lowStockThreshold,
    name: product.name,
    priceHistory: [
      { effectiveFrom: createdAt, priceMinor: product.originalPriceMinor },
      ...(repriced ? [{ effectiveFrom: daysAgo(priceChangeDaysAgo), priceMinor: product.currentPriceMinor }] : []),
    ],
    sku: product.sku,
    unit: product.unit,
    updatedAt: repriced ? daysAgo(priceChangeDaysAgo) : createdAt,
    vatRate: product.vatRate,
  };
};

const openingReceipt = (product: CatalogProduct): EncodedMerchandiseState['movements'][number] => ({
  at: daysAgo(OPENING_RECEIPT_DAYS_AGO),
  delta: openingReceiptQuantity(product.key),
  id: demoId(MOVEMENT_NAMESPACE, `receipt:${product.key}`),
  note: OPENING_RECEIPT_NOTE,
  productId: demoId('product', product.key),
  reason: 'RECEIPT',
});

/** Builds one order: snapshot lines (price frozen at order time), backend totals, and its ORDER movements. */
const buildOrder = Effect.fn('Merchandise.buildOrder')(function* buildOrder(planned: PlannedOrder, index: number) {
  const number = `${ORDER_NUMBER_PREFIX}${String(index + 1).padStart(4, '0')}`;
  const createdAt = daysAgo(planned.createdDaysAgo);
  const lines = planned.lines.map((line) => {
    const product = productByKey(line.productKey);
    return {
      productId: demoId('product', line.productKey),
      productName: product.name,
      quantity: line.quantity,
      sku: product.sku,
      unitPriceMinor: snapshotPriceMinor(line.productKey, planned.createdDaysAgo),
      vatRate: product.vatRate,
    };
  });
  const typedLines = yield* Schema.decodeUnknownEffect(Schema.Array(OrderLineSchema))(lines);
  const totals = orderTotals(typedLines);
  const movements: EncodedMerchandiseState['movements'] =
    planned.status === 'CANCELLED'
      ? []
      : planned.lines.map((line, lineIndex) => ({
          at: createdAt,
          delta: -line.quantity,
          id: demoId(MOVEMENT_NAMESPACE, `order:${planned.key}:${lineIndex}`),
          productId: demoId('product', line.productKey),
          reason: 'ORDER',
          reference: number,
        }));
  const base: EncodedMerchandiseState['orders'][number] = {
    createdAt,
    id: demoId('order', planned.key),
    lines,
    number,
    partyId: demoId('customer', planned.customerKey),
    status: planned.status,
    totalMinor: totals.totalMinor,
    totalVatMinor: totals.totalVatMinor,
    updatedAt: createdAt,
  };
  const order: EncodedMerchandiseState['orders'][number] =
    planned.opportunityKey === null ? base : { ...base, opportunityId: demoId('opportunity', planned.opportunityKey) };
  return { movements, order };
});

/** Builds the Merchandise state from the shared sales plan and decodes it through the vertical schema. */
const buildDemoState = Effect.fn('Merchandise.buildDemoState')(function* buildDemoState() {
  const built = yield* Effect.all(plannedOrders.map((planned, index) => buildOrder(planned, index)));
  const encoded: EncodedMerchandiseState = {
    movements: [
      ...catalog.map(openingReceipt),
      ...built.flatMap((entry) => entry.movements),
      ...STOCK_ADJUSTMENTS.map((adjustment) => ({
        at: daysAgo(adjustment.daysAgo),
        delta: adjustment.delta,
        id: demoId(MOVEMENT_NAMESPACE, `adjustment:${adjustment.key}`),
        note: ADJUSTMENT_NOTE,
        productId: demoId('product', adjustment.key),
        reason: 'ADJUSTMENT' as const,
      })),
    ],
    orders: built.map((entry) => entry.order),
    products: catalog.map(productState),
  };
  return yield* Schema.decodeUnknownEffect(MerchandiseStateSchema)(encoded);
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

const writeState = Effect.fn('Merchandise.writeDemoState')(function* writeDemoState(state: MerchandiseState) {
  const encoded = yield* Schema.encodeEffect(MerchandiseStateSchema)(state);
  const db = yield* makeWithDefaults({ relations: merchandiseRelations });
  const now = yield* DateTime.now;
  yield* db
    .insert(merchandiseStates)
    .values({
      legalEntityId: demoLegalEntityId,
      revision: 0,
      state: encoded,
      tenantId: demoTenantId,
      updatedAt: DateTime.toDateUtc(now),
    })
    .onConflictDoUpdate({
      set: { revision: 0, state: encoded, updatedAt: DateTime.toDateUtc(now) },
      target: [merchandiseStates.tenantId, merchandiseStates.legalEntityId],
    });
  yield* Console.log(
    `merchandise demo state reset to revision 0 (${state.products.length} products, ${state.movements.length} movements, ${state.orders.length} orders)`,
  );
});

const writeDemoState = (state: MerchandiseState) =>
  Layer.build(Layer.effectDiscard(writeState(state)).pipe(Layer.provide(AdminDatabaseLive))).pipe(Effect.scoped);

// `--sales-demo` is passed by scripts/demo/reset-demo.mts. `--validate-only` decodes and encodes the state
// (schema check) without touching the database.
const validateDemoState = Effect.fn('Merchandise.validateDemoState')(function* validateDemoState() {
  const state = yield* buildDemoState();
  yield* Schema.encodeEffect(MerchandiseStateSchema)(state);
  yield* Console.log(
    `merchandise sales-demo state validated (${state.products.length} products, ${state.movements.length} movements, ${state.orders.length} orders); no data changed`,
  );
});

const command = Command.make(
  'merchandise-reset',
  {
    salesDemo: Flag.Boolean('sales-demo').pipe(Flag.withDefault(false)),
    validateOnly: Flag.Boolean('validate-only').pipe(Flag.withDefault(false)),
  },
  ({ salesDemo, validateOnly }) =>
    Effect.gen(function* resetMerchandiseDemo() {
      if (!salesDemo) {
        return yield* new ResetInputError({ reason: '--sales-demo is required' });
      }
      if (validateOnly) {
        return yield* validateDemoState();
      }
      return yield* buildDemoState().pipe(Effect.flatMap(writeDemoState));
    }),
);

// The admin database connects only inside the write path, so --validate-only and flag errors never touch Postgres.
const resetProgram = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, ConfigProvider.layer(ConfigProvider.fromEnv()))),
);
NodeRuntime.runMain(Layer.build(resetProgram).pipe(Effect.scoped));
