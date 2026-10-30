import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  MerchandiseCommandSchema,
  MerchandiseLifecycleConflict,
  MerchandiseNotFound,
} from '../../shared/actions/apply-command.ts';
import { MerchandiseStateSchema } from '../../shared/apis/records.ts';
import type { MerchandiseState } from '../../shared/apis/records.ts';
import { ProductIdSchema } from '../../shared/domain/merchandise-model.ts';
import type { OrderStatus } from '../../shared/domain/merchandise-model.ts';
import { orderTotals } from '../../shared/domain/order-totals.ts';
import { evolveMerchandiseState, percentChangedPriceMinor } from '../../src/services/persistence.service.ts';
import { stockOnHandOf } from '../../src/services/stock-levels.ts';

const actor = {
  principalId: '20000000-0000-4000-8000-000000000002',
  tenantId: '20000000-0000-4000-8000-000000000001',
};
const t0 = DateTime.makeUnsafe('2026-10-05T10:00:00Z');
const t1 = DateTime.makeUnsafe('2026-10-06T10:00:00Z');
const empty: MerchandiseState = { movements: [], orders: [], products: [] };
const decodeCommand = Schema.decodeUnknownSync(MerchandiseCommandSchema);
const productIdOf = (value: string) => Schema.decodeUnknownSync(ProductIdSchema)(value);
const onHand = (state: MerchandiseState, id: string) => stockOnHandOf(state.movements, productIdOf(id));
const isConflict = Schema.is(MerchandiseLifecycleConflict);
const isNotFound = Schema.is(MerchandiseNotFound);

type CommandInput = typeof MerchandiseCommandSchema.Encoded;

const apply = (state: MerchandiseState, command: CommandInput, resourceId: string, now = t0) =>
  evolveMerchandiseState(state, decodeCommand(command), { actor, now, resourceId });

const addProduct = (state: MerchandiseState, resourceId: string, sku: string, priceMinor: number) =>
  apply(
    state,
    {
      _tag: 'CreateProduct',
      active: true,
      category: 'IT',
      lowStockThreshold: 2,
      name: `Produkt ${sku}`,
      priceMinor,
      sku,
      unit: 'ks',
      vatRate: 21,
    },
    resourceId,
  );

const receive = (state: MerchandiseState, productId: string, delta: number, resourceId: string) =>
  apply(state, { _tag: 'RecordStockMovement', delta, productId, reason: 'RECEIPT' }, resourceId);

const placeOrder = (
  state: MerchandiseState,
  orderId: string,
  lines: readonly { readonly productId: string; readonly quantity: number }[],
  resourceId: string,
) => apply(state, { _tag: 'CreateOrder', id: orderId, lines, partyId: 'party-1' }, resourceId);

const setOrderStatus = (state: MerchandiseState, orderId: string, status: OrderStatus, resourceId: string) =>
  apply(state, { _tag: 'ChangeOrderStatus', id: orderId, status }, resourceId, t1);

it.effect('CreateProduct uses the invocation id and starts a price history', () =>
  Effect.gen(function* case1() {
    const change = yield* addProduct(empty, 'product-1', 'KAB-1', 19_900);
    const [product] = change.state.products;
    expect(change.entityIds).toEqual(['product-1']);
    expect(product?.id).toBe('product-1');
    expect(product?.currentPriceMinor).toBe(19_900);
    expect(product?.priceHistory).toHaveLength(1);
  }),
);

it.effect('CreateProduct rejects a duplicate SKU', () =>
  Effect.gen(function* case2() {
    const first = yield* addProduct(empty, 'product-1', 'KAB-1', 19_900);
    const error = yield* addProduct(first.state, 'product-2', 'KAB-1', 5000).pipe(Effect.flip);
    expect(isConflict(error)).toBe(true);
    const lowercase = yield* addProduct(first.state, 'product-3', 'kab-1', 5000).pipe(Effect.flip);
    expect(isConflict(lowercase)).toBe(true);
  }),
);

it.effect('ChangePrice appends an effective-dated entry and leaves existing order lines unchanged', () =>
  Effect.gen(function* case3() {
    const created = yield* addProduct(empty, 'product-1', 'KAB-1', 19_900);
    const stocked = yield* receive(created.state, 'product-1', 5, 'rec-1');
    const ordered = yield* placeOrder(stocked.state, 'order-1', [{ productId: 'product-1', quantity: 2 }], 'ord-1');
    const repriced = yield* apply(
      ordered.state,
      { _tag: 'ChangePrice', id: 'product-1', priceMinor: 24_900 },
      'price-1',
      t1,
    );
    const [product] = repriced.state.products;
    const [order] = repriced.state.orders;
    expect(product?.currentPriceMinor).toBe(24_900);
    expect(product?.priceHistory.map((entry) => entry.priceMinor)).toEqual([19_900, 24_900]);
    expect(product?.priceHistory[1]?.effectiveFrom).toEqual(t1);
    expect(product?.priceHistory[1]?.changedBy).toEqual(actor);
    expect(order?.lines[0]?.unitPriceMinor).toBe(19_900);
    expect(order?.lines).toEqual(ordered.state.orders[0]?.lines);
    expect(order?.totalMinor).toBe(ordered.state.orders[0]?.totalMinor);
  }),
);

it.effect('ChangePrice to the current price adds no history entry', () =>
  Effect.gen(function* case4() {
    const created = yield* addProduct(empty, 'product-1', 'KAB-1', 19_900);
    const same = yield* apply(created.state, { _tag: 'ChangePrice', id: 'product-1', priceMinor: 19_900 }, 'price-1');
    expect(same.state.products[0]?.priceHistory).toHaveLength(1);
  }),
);

it.effect('RecordStockMovement rejects an issue that would take stock below zero', () =>
  Effect.gen(function* case5() {
    const created = yield* addProduct(empty, 'product-1', 'KAB-1', 19_900);
    const received = yield* receive(created.state, 'product-1', 3, 'rec-1');
    const error = yield* apply(
      received.state,
      { _tag: 'RecordStockMovement', delta: -4, productId: 'product-1', reason: 'ISSUE' },
      'iss-1',
    ).pipe(Effect.flip);
    expect(isConflict(error)).toBe(true);
    const issued = yield* apply(
      received.state,
      { _tag: 'RecordStockMovement', delta: -3, productId: 'product-1', reason: 'ISSUE' },
      'iss-2',
    );
    expect(onHand(issued.state, 'product-1')).toBe(0);
  }),
);

it.effect('RecordStockMovement rejects a receipt that does not increase stock', () =>
  Effect.gen(function* case6() {
    const created = yield* addProduct(empty, 'product-1', 'KAB-1', 19_900);
    const error = yield* receive(created.state, 'product-1', -1, 'rec-1').pipe(Effect.flip);
    expect(isConflict(error)).toBe(true);
  }),
);

it.effect('CreateOrder snapshots the line, totals it with VAT and numbers it in sequence', () =>
  Effect.gen(function* case7() {
    const created = yield* addProduct(empty, 'product-1', 'KAB-1', 19_900);
    const stocked = yield* receive(created.state, 'product-1', 10, 'rec-1');
    const first = yield* placeOrder(stocked.state, 'order-1', [{ productId: 'product-1', quantity: 2 }], 'ord-1');
    const second = yield* placeOrder(first.state, 'order-2', [{ productId: 'product-1', quantity: 1 }], 'ord-2');
    const [order1, order2] = second.state.orders;
    expect(order1?.number).toBe('OBJ-2026-0001');
    expect(order2?.number).toBe('OBJ-2026-0002');
    expect(order1?.lines[0]).toEqual({
      productId: 'product-1',
      productName: 'Produkt KAB-1',
      quantity: 2,
      sku: 'KAB-1',
      unitPriceMinor: 19_900,
      vatRate: 21,
    });
    // Net 39_800 plus 21 % VAT (8358 after half-up rounding) is the gross 48_158.
    expect(order1?.totalVatMinor).toBe(8358);
    expect(order1?.totalMinor).toBe(48_158);
    expect(second.state.movements.filter((entry) => entry.reason === 'ORDER').map((entry) => entry.delta)).toEqual([
      -2, -1,
    ]);
  }),
);

it.effect('CreateOrder rejects lines that exceed stock, including a product listed twice', () =>
  Effect.gen(function* case8() {
    const created = yield* addProduct(empty, 'product-1', 'KAB-1', 19_900);
    const stocked = yield* receive(created.state, 'product-1', 3, 'rec-1');
    const error = yield* placeOrder(
      stocked.state,
      'order-1',
      [
        { productId: 'product-1', quantity: 2 },
        { productId: 'product-1', quantity: 2 },
      ],
      'ord-1',
    ).pipe(Effect.flip);
    expect(isConflict(error)).toBe(true);
  }),
);

it.effect('EditOrder sums repeated original product and variant lines before reconciling stock', () =>
  Effect.gen(function* editRepeatedLines() {
    for (const variantId of [undefined, 'variants-v1']) {
      const created = yield* addProduct(empty, 'product-1', 'KAB-1', 19_900);
      const catalog =
        variantId === undefined
          ? created
          : yield* apply(
              created.state,
              {
                _tag: 'UpdateProduct',
                id: 'product-1',
                patch: {
                  variants: [{ attributes: 'Standard', name: 'Standard', priceMinor: 19_900, sku: 'KAB-1-STD' }],
                },
              },
              'variants',
            );
      const selection = variantId === undefined ? { productId: 'product-1' } : { productId: 'product-1', variantId };
      const stocked = yield* apply(
        catalog.state,
        { _tag: 'RecordStockMovement', delta: 10, reason: 'RECEIPT', ...selection },
        'rec-1',
      );
      const ordered = yield* apply(
        stocked.state,
        {
          _tag: 'CreateOrder',
          id: 'order-1',
          lines: [
            { ...selection, quantity: 2 },
            { ...selection, quantity: 3 },
          ],
          partyId: 'party-1',
        },
        'ord-1',
      );
      expect(ordered.state.orders[0]?.lines.map((line) => line.quantity)).toEqual([2, 3]);
      expect(onHand(ordered.state, 'product-1')).toBe(5);
      for (const quantity of [4, 6]) {
        const command = { _tag: 'EditOrder', id: 'order-1', lines: [{ ...selection, quantity }] } as const;
        const edited = yield* apply(ordered.state, command, `edit-${quantity}`);
        expect(edited.state.orders[0]?.lines.map((line) => line.quantity)).toEqual([quantity]);
        expect(onHand(edited.state, 'product-1')).toBe(10 - quantity);
        expect(edited.state.movements.slice(ordered.state.movements.length)).toEqual([
          expect.objectContaining({ delta: 5 - quantity, reason: 'ORDER', ...selection }),
        ]);
        const unchanged = yield* apply(edited.state, command, `edit-same-${quantity}`);
        expect(unchanged.state.movements).toBe(edited.state.movements);
        const cancelled = yield* setOrderStatus(edited.state, 'order-1', 'CANCELLED', `cancel-${quantity}`);
        expect(onHand(cancelled.state, 'product-1')).toBe(10);
      }
    }
  }),
);

it.effect('cancelling an order restores its stock with compensating movements', () =>
  Effect.gen(function* case9() {
    const created = yield* addProduct(empty, 'product-1', 'KAB-1', 19_900);
    const stocked = yield* receive(created.state, 'product-1', 5, 'rec-1');
    const ordered = yield* placeOrder(stocked.state, 'order-1', [{ productId: 'product-1', quantity: 3 }], 'ord-1');
    const cancelled = yield* setOrderStatus(ordered.state, 'order-1', 'CANCELLED', 'cancel-1');
    expect(onHand(ordered.state, 'product-1')).toBe(2);
    expect(onHand(cancelled.state, 'product-1')).toBe(5);
    expect(cancelled.state.orders[0]?.status).toBe('CANCELLED');
  }),
);

it.effect('ChangeOrderStatus follows the order lifecycle and rejects skipped steps', () =>
  Effect.gen(function* case10() {
    const created = yield* addProduct(empty, 'product-1', 'KAB-1', 19_900);
    const stocked = yield* receive(created.state, 'product-1', 5, 'rec-1');
    const ordered = yield* placeOrder(stocked.state, 'order-1', [{ productId: 'product-1', quantity: 1 }], 'ord-1');
    const skipped = yield* setOrderStatus(ordered.state, 'order-1', 'SHIPPED', 'st-1').pipe(Effect.flip);
    expect(isConflict(skipped)).toBe(true);
    const confirmed = yield* setOrderStatus(ordered.state, 'order-1', 'CONFIRMED', 'st-2');
    const shipped = yield* setOrderStatus(confirmed.state, 'order-1', 'SHIPPED', 'st-3');
    const delivered = yield* setOrderStatus(shipped.state, 'order-1', 'DELIVERED', 'st-4');
    expect(delivered.state.orders[0]?.status).toBe('DELIVERED');
    const cancelDelivered = yield* setOrderStatus(delivered.state, 'order-1', 'CANCELLED', 'st-5').pipe(Effect.flip);
    expect(isConflict(cancelDelivered)).toBe(true);
  }),
);

it.effect('BulkUpdateProducts applies a whole-CZK percent change and a category in one command', () =>
  Effect.gen(function* case11() {
    const first = yield* addProduct(empty, 'product-1', 'KAB-1', 19_900);
    const second = yield* addProduct(first.state, 'product-2', 'MYS-1', 1050);
    const bulk = yield* apply(
      second.state,
      {
        _tag: 'BulkUpdateProducts',
        ids: ['product-1', 'product-2'],
        patch: { category: 'Hardware', priceChangePercent: 10 },
      },
      'bulk-1',
      t1,
    );
    const [a, b] = bulk.state.products;
    expect(bulk.entityIds).toEqual(['product-1', 'product-2']);
    expect(a?.currentPriceMinor).toBe(21_900);
    expect(b?.currentPriceMinor).toBe(1200);
    expect(a?.category).toBe('Hardware');
    expect(a?.priceHistory).toHaveLength(2);
    expect(b?.priceHistory[1]?.effectiveFrom).toEqual(t1);
  }),
);

it.effect('BulkUpdateProducts fails as a whole when one id is unknown', () =>
  Effect.gen(function* case12() {
    const created = yield* addProduct(empty, 'product-1', 'KAB-1', 19_900);
    const error = yield* apply(
      created.state,
      { _tag: 'BulkUpdateProducts', ids: ['product-1', 'missing'], patch: { active: false } },
      'bulk-1',
    ).pipe(Effect.flip);
    expect(isNotFound(error)).toBe(true);
  }),
);

it('percent price changes round half-up to whole CZK', () => {
  expect(percentChangedPriceMinor(19_900, 10)).toBe(21_900);
  expect(percentChangedPriceMinor(1050, 10)).toBe(1200);
  expect(percentChangedPriceMinor(19_900, -10)).toBe(17_900);
});

it('order totals keep VAT per line in whole minor units', () => {
  const totals = orderTotals([
    { quantity: 1, unitPriceMinor: 1050, vatRate: 21 },
    { quantity: 1, unitPriceMinor: 1000, vatRate: 0 },
  ]);
  // 1050 at 21 % is 220.5, rounded half-up to 221; the 0 % line adds nothing.
  expect(totals).toEqual({ totalMinor: 2271, totalVatMinor: 221 });
});

it.effect('old JSONB products decode and metadata roundtrips and clears without changing snapshots or stock', () =>
  Effect.gen(function* metadataCompatibility() {
    const created = yield* addProduct(empty, 'product-1', 'KAB-1', 1050);
    const stocked = yield* receive(created.state, 'product-1', 4, 'receipt-1');
    const ordered = yield* placeOrder(stocked.state, 'order-1', [{ productId: 'product-1', quantity: 1 }], 'order-1');
    const oldJson = yield* Schema.encodeEffect(MerchandiseStateSchema)(ordered.state);
    const oldState = yield* Schema.decodeUnknownEffect(MerchandiseStateSchema)(oldJson);
    expect(oldState.products[0]?.description).toBeUndefined();
    const patch = {
      description: 'Long description',
      heightMm: 10,
      lengthMm: 100,
      shortDescription: 'Short description',
      variants: [{ attributes: 'Colour: black', name: 'Black' }],
      weightGrams: 120,
      widthMm: 50,
    };
    const edited = yield* apply(oldState, { _tag: 'UpdateProduct', id: 'product-1', patch }, 'edit-1', t1);
    const encoded = yield* Schema.encodeEffect(MerchandiseStateSchema)(edited.state);
    const decoded = yield* Schema.decodeUnknownEffect(MerchandiseStateSchema)(encoded);
    expect(encoded.products[0]).toMatchObject(patch);
    expect(decoded.products[0]?.priceHistory).toEqual(oldState.products[0]?.priceHistory);
    expect(decoded.orders).toEqual(oldState.orders);
    expect(decoded.movements).toEqual(oldState.movements);
    const cleared = yield* apply(
      decoded,
      {
        _tag: 'UpdateProduct',
        id: 'product-1',
        patch: {
          description: '',
          heightMm: null,
          lengthMm: null,
          shortDescription: '',
          variants: [],
          weightGrams: null,
          widthMm: null,
        },
      },
      'clear-1',
      t1,
    );
    const clearedJson = yield* Schema.encodeEffect(MerchandiseStateSchema)(cleared.state);
    const clearedState = yield* Schema.decodeUnknownEffect(MerchandiseStateSchema)(clearedJson);
    expect(clearedJson.products[0]).toMatchObject({
      description: '',
      lengthMm: null,
      variants: [],
      weightGrams: null,
    });
    expect(clearedState.orders).toEqual(oldState.orders);
  }),
);

it('metadata rejects negative, fractional and excessive measurements and unnamed variants', () => {
  const valid = Schema.is(MerchandiseCommandSchema);
  const base = { _tag: 'UpdateProduct', id: productIdOf('p') } as const;
  for (const weightGrams of [-1, 0, 1.5, 1_000_000_001]) {
    expect(valid({ ...base, patch: { weightGrams } })).toBe(false);
  }
  expect(valid({ ...base, patch: { variants: [{ attributes: '', name: '' }] } })).toBe(false);
  expect(valid({ ...base, patch: { description: 'x'.repeat(20_001) } })).toBe(false);
  expect(
    valid({ ...base, patch: { variants: Array.from({ length: 1001 }, () => ({ attributes: '', name: 'A' })) } }),
  ).toBe(false);
});

it('unit gross prices use the same half-up VAT arithmetic for zero and non-zero rates', () => {
  expect(orderTotals([{ quantity: 1, unitPriceMinor: 1050, vatRate: 21 }])).toEqual({
    totalMinor: 1271,
    totalVatMinor: 221,
  });
  expect(orderTotals([{ quantity: 1, unitPriceMinor: 1050, vatRate: 0 }])).toEqual({
    totalMinor: 1050,
    totalVatMinor: 0,
  });
});

it.effect('CreateProduct retains informational metadata and encodes optional measurements', () =>
  Effect.gen(function* createMetadata() {
    const change = yield* apply(
      empty,
      {
        _tag: 'CreateProduct',
        active: true,
        category: 'IT',
        description: 'Description',
        heightMm: null,
        lowStockThreshold: 0,
        name: 'Cable',
        priceMinor: 1050,
        sku: 'CABLE',
        unit: 'ks',
        variants: [{ attributes: 'Colour: black', name: 'Black' }],
        vatRate: 21,
        weightGrams: 100,
      },
      'metadata-product',
    );
    const encoded = yield* Schema.encodeEffect(MerchandiseStateSchema)(change.state);
    expect(encoded.products[0]).toMatchObject({
      description: 'Description',
      heightMm: null,
      variants: [{ attributes: 'Colour: black', name: 'Black' }],
      weightGrams: 100,
    });
  }),
);
