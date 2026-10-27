import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
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
import { readCompanySnapshot, writeCompanySnapshot } from './company-snapshot.ts';
import { refreshObchodOrderPresentation } from './order-presentation.ts';

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
  const base = {
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
  if (product.key !== 'p01') {
    return base;
  }
  return {
    ...base,
    description:
      'Firemní pracovní stanice. Evidenční varianty popisují dostupná provedení; cena a sklad se vztahují k produktu.',
    heightMm: 18,
    lengthMm: 320,
    shortDescription: 'Přenosný pracovní počítač pro každodenní práci.',
    variants: [
      { attributes: 'Barva: černá', name: 'Tmavé provedení' },
      { attributes: 'Barva: stříbrná', name: 'Světlé provedení' },
    ],
    weightGrams: 1800,
    widthMm: 220,
  };
};

const openingReceipt = (product: CatalogProduct): EncodedMerchandiseState['movements'][number] => ({
  at: daysAgo(OPENING_RECEIPT_DAYS_AGO),
  delta: openingReceiptQuantity(product),
  id: demoId(MOVEMENT_NAMESPACE, `receipt:${product.key}`),
  note: OPENING_RECEIPT_NOTE,
  productId: demoId('product', product.key),
  reason: 'RECEIPT',
});

/** Builds one order: snapshot lines (price frozen at order time), backend totals, and its ORDER movements. */
const buildOrder = Effect.fn('Merchandise.buildOrder')(function* buildOrder(planned: PlannedOrder, index: number) {
  const number = `${ORDER_NUMBER_PREFIX}${String(index + 1).padStart(4, '0')}`;
  const createdAt = daysAgo(planned.createdDaysAgo);
  const lines = yield* Effect.all(
    planned.lines.map((line) =>
      Effect.gen(function* plannedLine() {
        const product = yield* productByKey(line.productKey);
        return {
          productId: demoId('product', line.productKey),
          productName: product.name,
          quantity: line.quantity,
          sku: product.sku,
          unitPriceMinor: snapshotPriceMinor(product, planned.createdDaysAgo),
          vatRate: product.vatRate,
        };
      }),
    ),
  );
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
  return yield* Schema.decodeUnknownEffect(MerchandiseStateSchema)(refreshObchodOrderPresentation(encoded));
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

const sameEncodedState = Schema.toEquivalence(Schema.toEncoded(MerchandiseStateSchema));

const scope = { legalEntityId: demoLegalEntityId, tenantId: demoTenantId };

const writeState = Effect.fn('Merchandise.writeDemoState')(function* writeDemoState(state: MerchandiseState) {
  const revision = yield* writeCompanySnapshot(scope, state);
  yield* Console.log(
    `merchandise demo data reset at revision ${revision} (${state.products.length} products, ${state.movements.length} movements, ${state.orders.length} orders)`,
  );
});

/** Explicit non-destructive mode: patch only untouched old open fixtures in Obchodní firma. */
const repairOrderPresentation = Effect.gen(function* repairOrderPresentation() {
  const current = yield* readCompanySnapshot(scope);
  if (current === undefined) {
    return yield* Effect.fail(new ResetInputError({ reason: 'Obchodní firma merchandise must already exist' }));
  }
  const encoded = yield* Schema.encodeEffect(MerchandiseStateSchema)(current.state);
  const repaired = refreshObchodOrderPresentation(encoded);
  if (sameEncodedState(repaired, encoded)) {
    return yield* Console.log('Obchodní firma open orders already presentable; nothing changed');
  }
  const state = yield* Schema.decodeUnknownEffect(MerchandiseStateSchema)(repaired);
  yield* writeCompanySnapshot(scope, state);
  return yield* Console.log(
    'Obchodní firma: five old open fixture dates and matching stock timestamps refreshed; completed history, prices and statuses preserved',
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
    repairOrderPresentation: Flag.Boolean('repair-order-presentation').pipe(Flag.withDefault(false)),
    salesDemo: Flag.Boolean('sales-demo').pipe(Flag.withDefault(false)),
    validateOnly: Flag.Boolean('validate-only').pipe(Flag.withDefault(false)),
  },
  ({ repairOrderPresentation: repair, salesDemo, validateOnly }) =>
    Effect.gen(function* resetMerchandiseDemo() {
      if (!salesDemo) {
        return yield* new ResetInputError({ reason: '--sales-demo is required' });
      }
      if (validateOnly) {
        return yield* validateDemoState();
      }
      if (repair) {
        return yield* Layer.build(
          Layer.effectDiscard(repairOrderPresentation).pipe(Layer.provide(AdminDatabaseLive)),
        ).pipe(Effect.scoped);
      }
      return yield* buildDemoState().pipe(Effect.flatMap(writeDemoState));
    }),
);

// The admin database connects only inside the write path, so --validate-only and flag errors never touch Postgres.
const resetProgram = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, ConfigProvider.layer(ConfigProvider.fromEnv()))),
);
NodeRuntime.runMain(Layer.build(resetProgram).pipe(Effect.scoped));
