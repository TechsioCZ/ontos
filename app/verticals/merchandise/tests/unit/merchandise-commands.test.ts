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
import { computeProductRecords, stockOnHandOf } from '../../src/services/stock-levels.ts';
import { TEST_RATES, TEST_TAX } from '../support/tax-fixtures.ts';

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
  evolveMerchandiseState(state, decodeCommand(command), { actor, now, resourceId, tax: TEST_TAX });

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
      taxClassificationCode: 'cz.vat.standard',
      unit: 'ks',
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
    expect(product?.variants).toBeUndefined();
  }),
);

it.effect('CreateProduct normalizes priced variants and preserves informational variants', () =>
  Effect.gen(function* createVariants() {
    const command: CommandInput = {
      _tag: 'CreateProduct',
      active: true,
      category: 'IT',
      lowStockThreshold: 0,
      name: 'Cable',
      priceMinor: 9900,
      sku: 'CABLE',
      taxClassificationCode: 'cz.vat.standard',
      unit: 'ks',
      variants: [
        { attributes: 'Colour: black', name: 'Black', priceMinor: 1050, sku: 'CABLE-BLACK' },
        { attributes: 'Colour: white', id: 'white-variant', name: 'White', priceMinor: 0 },
        { attributes: 'Material: copper', name: 'Material' },
      ],
    };
    const created = yield* apply(empty, command, 'variant-product');
    const variants = created.state.products[0]?.variants;
    expect(variants).toEqual([
      // Each priced variant stores the gross entered with it at the standard rate then (1050 + 21 % = 1271).
      {
        ...command.variants?.[0],
        grossPriceMinor: 1271,
        id: 'variant-product-v1',
        priceHistory: [{ changedBy: actor, effectiveFrom: t0, priceMinor: 1050 }],
      },
      {
        ...command.variants?.[1],
        grossPriceMinor: 0,
        priceHistory: [{ changedBy: actor, effectiveFrom: t0, priceMinor: 0 }],
      },
      command.variants?.[2],
    ]);
    expect(command.variants?.[0]?.id).toBeUndefined();
    const replay = yield* apply(empty, command, 'variant-product');
    expect(replay.state).toEqual(created.state);
    const encoded = yield* Schema.encodeEffect(MerchandiseStateSchema)(created.state);
    const decoded = yield* Schema.decodeUnknownEffect(MerchandiseStateSchema)(encoded);
    expect(decoded).toEqual(created.state);
    expect(computeProductRecords(decoded, TEST_RATES, {})[0]?.variantRecords?.map((variant) => variant.id)).toEqual([
      'variant-product-v1',
      'white-variant',
    ]);
  }),
);

it.effect('new priced variants immediately accept stock and preserve their own order price', () =>
  Effect.gen(function* useCreatedVariant() {
    const created = yield* apply(
      empty,
      {
        _tag: 'CreateProduct',
        active: true,
        category: 'IT',
        lowStockThreshold: 0,
        name: 'Cable',
        priceMinor: 9900,
        sku: 'CABLE',
        taxClassificationCode: 'cz.vat.standard',
        unit: 'ks',
        variants: [{ attributes: 'Colour: black', name: 'Black', priceMinor: 1050 }],
      },
      'variant-product',
    );
    const stocked = yield* apply(
      created.state,
      {
        _tag: 'RecordStockMovement',
        delta: 5,
        productId: 'variant-product',
        reason: 'RECEIPT',
        variantId: 'variant-product-v1',
      },
      'variant-receipt',
    );
    expect(computeProductRecords(stocked.state, TEST_RATES, {})[0]?.variantRecords?.[0]).toMatchObject({
      id: 'variant-product-v1',
      priceMinor: 1050,
      stockOnHand: 5,
    });
    const parentReceipt = yield* receive(stocked.state, 'variant-product', 1, 'parent-receipt').pipe(Effect.flip);
    expect(isConflict(parentReceipt)).toBe(true);
    const ordered = yield* apply(
      stocked.state,
      {
        _tag: 'CreateOrder',
        id: 'variant-order',
        lines: [{ productId: 'variant-product', quantity: 2, variantId: 'variant-product-v1' }],
        partyId: 'party-1',
      },
      'variant-order',
    );
    expect(ordered.state.orders[0]?.lines[0]).toMatchObject({
      unitPriceMinor: 1050,
      variantId: 'variant-product-v1',
      variantName: 'Black',
    });
    expect(computeProductRecords(ordered.state, TEST_RATES, {})[0]?.variantRecords?.[0]?.stockOnHand).toBe(3);
  }),
);

it.effect('CreateProduct rejects duplicate variant identities including generated-id collisions', () =>
  Effect.gen(function* duplicateVariantIds() {
    for (const id of ['same-variant', 'variant-product-v1']) {
      const firstVariant =
        id === 'same-variant'
          ? { attributes: '', id, name: 'Black', priceMinor: 1050 }
          : { attributes: '', name: 'Black', priceMinor: 1050 };
      const error = yield* apply(
        empty,
        {
          _tag: 'CreateProduct',
          active: true,
          category: 'IT',
          lowStockThreshold: 0,
          name: 'Cable',
          priceMinor: 9900,
          sku: 'CABLE',
          taxClassificationCode: 'cz.vat.standard',
          unit: 'ks',
          variants: [firstVariant, { attributes: '', id, name: 'White', priceMinor: 1100 }],
        },
        'variant-product',
      ).pipe(Effect.flip);
      expect(isConflict(error)).toBe(true);
      expect(empty.products).toEqual([]);
    }
  }),
);

it.effect('CreateProduct rejects case-insensitive duplicate variant SKUs', () =>
  Effect.gen(function* duplicateVariantSkus() {
    const error = yield* apply(
      empty,
      {
        _tag: 'CreateProduct',
        active: true,
        category: 'IT',
        lowStockThreshold: 0,
        name: 'Cable',
        priceMinor: 9900,
        sku: 'CABLE',
        taxClassificationCode: 'cz.vat.standard',
        unit: 'ks',
        variants: [
          { attributes: '', name: 'Black', priceMinor: 1050, sku: 'CABLE-ONE' },
          { attributes: '', name: 'White', priceMinor: 1100, sku: ' cable-one ' },
        ],
      },
      'variant-product',
    ).pipe(Effect.flip);
    expect(isConflict(error)).toBe(true);
    expect(empty.products).toEqual([]);
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
      taxClassificationCode: 'cz.vat.standard',
      taxRuleRevisionId: 'revision-standard',
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
        taxClassificationCode: 'cz.vat.standard',
        unit: 'ks',
        variants: [{ attributes: 'Colour: black', name: 'Black' }],
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

const bulkMembershipState = Schema.decodeUnknownSync(MerchandiseStateSchema)({
  categories: [
    {
      description: '',
      hasChildren: true,
      heading: 'Primary',
      id: 'r',
      imageAlt: '',
      imageSrc: '',
      longDescription: '',
      name: 'Primary',
      parentId: null,
      position: 0,
      slug: 'primary',
    },
    {
      description: '',
      hasChildren: false,
      heading: 'Child',
      id: 'c',
      imageAlt: '',
      imageSrc: '',
      longDescription: '',
      name: 'Child',
      parentId: 'r',
      position: 0,
      slug: 'child',
    },
    {
      description: '',
      hasChildren: false,
      heading: 'Secondary',
      id: 's',
      imageAlt: '',
      imageSrc: '',
      longDescription: '',
      name: 'Secondary',
      parentId: null,
      position: 1,
      slug: 'secondary',
    },
  ],
  movements: [],
  orders: [],
  products: ['one', 'two'].map((id) => ({
    active: true,
    category: 'Primary',
    categoryId: 'r',
    categoryPathIds: ['r'],
    createdAt: '2026-10-05T10:00:00.000Z',
    currentPriceMinor: 100,
    id,
    lowStockThreshold: 0,
    name: id,
    priceHistory: [],
    sku: id,
    taxClassificationCode: 'cz.vat.standard',
    unit: 'ks',
    updatedAt: '2026-10-05T10:00:00.000Z',
  })),
});

it('Bulk native category fields retain the existing finite command bounds and wire representation', () => {
  const wire: CommandInput = {
    _tag: 'BulkUpdateProducts',
    ids: ['one'],
    patch: { additionalCategoryIds: ['s'], categoryId: 'r' },
  };
  expect(
    Schema.toEquivalence(Schema.toEncoded(MerchandiseCommandSchema))(
      Schema.encodeSync(MerchandiseCommandSchema)(decodeCommand(wire)),
      wire,
    ),
  ).toBe(true);
  expect(Schema.is(MerchandiseCommandSchema)({ ...wire, ids: [] })).toBe(false);
  expect(Schema.is(MerchandiseCommandSchema)({ ...wire, ids: Array.from({ length: 500 }, () => 'one') })).toBe(true);
  expect(Schema.is(MerchandiseCommandSchema)({ ...wire, ids: Array.from({ length: 501 }, () => 'one') })).toBe(false);
  expect(Schema.is(MerchandiseCommandSchema)({ ...wire, patch: { additionalCategoryIds: [12] } })).toBe(false);
});

it.effect('Bulk native membership deduplicates products, audits, retains on a move, and removes explicitly', () =>
  Effect.gen(function* bulkNativeCategoryMemberships() {
    const added = yield* apply(
      bulkMembershipState,
      {
        _tag: 'BulkUpdateProducts',
        ids: ['one', 'one', 'two'],
        patch: { additionalCategoryIds: ['s', 'r', 's'], categoryId: 'r' },
      },
      'bulk-add',
      t1,
    );
    expect(added.entityIds).toEqual(['one', 'two']);
    for (const product of added.state.products) {
      expect(product.categoryId).toBe('r');
      expect(product.additionalCategoryIds).toEqual(['s']);
      expect(product.categoryPathIds).toEqual(['r', 's']);
      expect(product.contentHistory?.at(-1)?.fields).toEqual(['Další kategorie']);
      expect(product.currentPriceMinor).toBe(100);
      expect(product.priceHistory).toEqual([]);
    }
    const moved = yield* apply(
      added.state,
      {
        _tag: 'BulkUpdateProducts',
        ids: ['one', 'two'],
        patch: { categoryId: 'c' },
      },
      'bulk-move',
      t1,
    );
    expect(moved.state.products.every((product) => product.categoryPathIds?.join(',') === 'c,r,s')).toBe(true);
    const removed = yield* apply(
      moved.state,
      {
        _tag: 'BulkUpdateProducts',
        ids: ['one', 'two'],
        patch: { additionalCategoryIds: [] },
      },
      'bulk-remove',
      t1,
    );
    for (const product of removed.state.products) {
      expect(product.categoryId).toBe('c');
      expect(product.categoryPathIds).toEqual(['c', 'r']);
      expect(product.additionalCategoryIds).toEqual([]);
      expect(product.contentHistory?.at(-1)?.fields).toEqual(['Další kategorie']);
    }
  }),
);

it.effect('Bulk native assignment rejects mixed display fields and any invalid product/category without mutation', () =>
  Effect.gen(function* invalidBulkNativeMemberships() {
    const before = Schema.encodeSync(MerchandiseStateSchema)(bulkMembershipState);
    const mixed = yield* Effect.flip(
      apply(
        bulkMembershipState,
        {
          _tag: 'BulkUpdateProducts',
          ids: ['one', 'two'],
          patch: { additionalCategoryIds: ['s'], category: 'Legacy display', categoryId: 'r' },
        },
        'bulk-mixed',
        t1,
      ),
    );
    expect(isConflict(mixed)).toBe(true);
    const unknownProduct = yield* Effect.flip(
      apply(
        bulkMembershipState,
        {
          _tag: 'BulkUpdateProducts',
          ids: ['one', 'missing'],
          patch: { additionalCategoryIds: ['s'] },
        },
        'bulk-unknown-product',
        t1,
      ),
    );
    expect(isNotFound(unknownProduct)).toBe(true);
    const unknownCategory = yield* Effect.flip(
      apply(
        bulkMembershipState,
        {
          _tag: 'BulkUpdateProducts',
          ids: ['one', 'two'],
          patch: { additionalCategoryIds: ['missing'] },
        },
        'bulk-unknown-category',
        t1,
      ),
    );
    expect(isConflict(unknownCategory)).toBe(true);
    expect(Schema.encodeSync(MerchandiseStateSchema)(bulkMembershipState)).toEqual(before);
  }),
);

it.effect('requires product stock reconciliation before adding the first sellable variant', () =>
  Effect.gen(function* firstVariantWithStock() {
    const created = yield* addProduct(empty, 'stocked-parent', 'PARENT', 100);
    const stocked = yield* receive(created.state, 'stocked-parent', 3, 'parent-stock');
    const command: CommandInput = {
      _tag: 'UpdateProduct',
      id: 'stocked-parent',
      patch: { variants: [{ attributes: '', id: 'new-variant', name: 'New', priceMinor: 100 }] },
    };
    const refused = yield* apply(stocked.state, command, 'add-first-variant').pipe(Effect.flip);
    expect(isConflict(refused)).toBe(true);
    expect(onHand(stocked.state, 'stocked-parent')).toBe(3);
    const reconciled = yield* apply(
      stocked.state,
      { _tag: 'RecordStockMovement', delta: -3, productId: 'stocked-parent', reason: 'ADJUSTMENT' },
      'reconcile-parent',
    );
    const accepted = yield* apply(reconciled.state, command, 'add-after-reconciliation');
    expect(accepted.state.products[0]?.variants?.[0]?.id).toBe('new-variant');
  }),
);

it.effect('refuses to remove a stocked variant even while another variant remains', () =>
  Effect.gen(function* removingStockedVariant() {
    const created = yield* addProduct(empty, 'variant-stock', 'VARIANT-STOCK', 100);
    const first = { attributes: '', id: 'stocked-variant', name: 'Stocked', priceMinor: 100 };
    const second = { attributes: '', id: 'empty-variant', name: 'Empty', priceMinor: 200 };
    const variants = yield* apply(
      created.state,
      { _tag: 'UpdateProduct', id: 'variant-stock', patch: { variants: [first, second] } },
      'add-variants',
    );
    const stocked = yield* apply(
      variants.state,
      { _tag: 'RecordStockMovement', delta: 3, productId: 'variant-stock', reason: 'RECEIPT', variantId: first.id },
      'stock-variant',
    );
    for (const remaining of [[], [second], [{ attributes: '', id: first.id, name: first.name }]]) {
      const refused = yield* apply(
        stocked.state,
        { _tag: 'UpdateProduct', id: 'variant-stock', patch: { variants: remaining } },
        'remove-stocked',
      ).pipe(Effect.flip);
      expect(isConflict(refused)).toBe(true);
    }
    const accepted = yield* apply(
      stocked.state,
      { _tag: 'UpdateProduct', id: 'variant-stock', patch: { variants: [first] } },
      'remove-empty',
    );
    expect(accepted.state.products[0]?.variants).toHaveLength(1);
    expect(accepted.state.movements).toBe(stocked.state.movements);
  }),
);

it.effect('refuses a bulk price selection containing sellable variants instead of changing unused parent prices', () =>
  Effect.gen(function* bulkVariantPriceRefusal() {
    const parent = yield* addProduct(empty, 'bulk-plain', 'PLAIN', 1000);
    const created = yield* addProduct(parent.state, 'bulk-variant', 'VARIANT', 2000);
    const variants = yield* apply(
      created.state,
      {
        _tag: 'UpdateProduct',
        id: 'bulk-variant',
        patch: {
          variants: [{ attributes: '', id: 'bulk-v1', name: 'Sellable', priceMinor: 3000 }],
        },
      },
      'bulk-variants',
    );
    const refused = yield* apply(
      variants.state,
      { _tag: 'BulkUpdateProducts', ids: ['bulk-plain', 'bulk-variant'], patch: { priceChangePercent: 10 } },
      'bulk-price-change',
    ).pipe(Effect.flip);
    expect(isConflict(refused)).toBe(true);
    expect(variants.state.products.map((product) => product.currentPriceMinor)).toEqual([1000, 2000]);
    const accepted = yield* apply(
      variants.state,
      { _tag: 'BulkUpdateProducts', ids: ['bulk-plain'], patch: { priceChangePercent: 10 } },
      'plain-price-change',
    );
    expect(accepted.state.products[0]?.currentPriceMinor).toBe(1100);
    expect(accepted.state.products[1]).toBe(variants.state.products[1]);
  }),
);

it.effect('scales gross and net discount tiers by the same base price ratio', () =>
  Effect.gen(function* discountedTierRepricing() {
    const created = yield* addProduct(empty, 'tiered-base', 'TIERED', 1000);
    const tier = { minimumQuantity: 10, priceExcludingVatMinor: 800, priceMinor: 968 };
    const tiered: MerchandiseState = {
      ...created.state,
      products: created.state.products.map((product) => ({ ...product, priceTiers: [tier] })),
    };
    const repriced = yield* apply(tiered, { _tag: 'ChangePrice', id: 'tiered-base', priceMinor: 2000 }, 'tier-reprice');
    expect(repriced.state.products[0]?.priceTiers).toEqual([
      { minimumQuantity: 10, priceExcludingVatMinor: 1600, priceMinor: 1936 },
    ]);
    expect(repriced.state.products[0]?.priceTiers?.[0]?.priceMinor).not.toBe(2420);
    const variant = yield* apply(
      created.state,
      {
        _tag: 'UpdateProduct',
        id: 'tiered-base',
        patch: {
          variants: [{ attributes: '', id: 'tier-v1', name: 'Tiered', priceMinor: 1000, priceTiers: [tier] }],
        },
      },
      'add-tier-variant',
    );
    const changedVariant = yield* apply(
      variant.state,
      {
        _tag: 'ChangePrice',
        id: 'tiered-base',
        priceMinor: 2000,
        variantId: 'tier-v1',
      },
      'variant-tier-reprice',
    );
    expect(changedVariant.state.products[0]?.variants?.[0]?.priceTiers).toEqual([
      { minimumQuantity: 10, priceExcludingVatMinor: 1600, priceMinor: 1936 },
    ]);
  }),
);

it.effect('records fractional manual receipts and issues without rounding the quantity', () =>
  Effect.gen(function* fractionalManualMovements() {
    const created = yield* addProduct(empty, 'fraction-product', 'FRACTION', 1000);
    const received = yield* receive(created.state, 'fraction-product', 0.3, 'fraction-receipt');
    const first = yield* apply(
      received.state,
      {
        _tag: 'RecordStockMovement',
        productId: 'fraction-product',
        reason: 'ISSUE',
        delta: -0.1,
      },
      'fraction-issue-1',
    );
    const second = yield* apply(
      first.state,
      {
        _tag: 'RecordStockMovement',
        productId: 'fraction-product',
        reason: 'ISSUE',
        delta: -0.2,
      },
      'fraction-issue-2',
    );
    expect(second.state.movements.map((movement) => movement.delta)).toEqual([0.3, -0.1, -0.2]);
    expect(onHand(second.state, 'fraction-product')).toBe(0);
    const refused = yield* apply(
      second.state,
      {
        _tag: 'RecordStockMovement',
        productId: 'fraction-product',
        reason: 'ISSUE',
        delta: -0.001,
      },
      'fraction-overdraw',
    ).pipe(Effect.flip);
    expect(isConflict(refused)).toBe(true);
  }),
);

it('rejects manual movements that are non-finite, unbounded or more precise than stock', () => {
  const encodedCommand = Schema.is(Schema.toEncoded(MerchandiseCommandSchema));
  const command = { _tag: 'RecordStockMovement', productId: 'fraction-product', reason: 'RECEIPT' } as const;
  expect(encodedCommand({ ...command, delta: 0.125 })).toBe(true);
  for (const delta of [Number.NaN, Number.POSITIVE_INFINITY, 1_000_001, -1_000_001, 0.0000001]) {
    expect(encodedCommand({ ...command, delta })).toBe(false);
  }
});

it.effect('requires an explicit bounded SKU when a generated variant SKU would exceed the order contract', () =>
  Effect.gen(function* boundedVariantSku() {
    const created = yield* addProduct(empty, 'long-sku-product', 'P'.repeat(64), 1000);
    const variant = { attributes: '', id: 'V'.repeat(300), name: 'Long identity', priceMinor: 1000 };
    const command: CommandInput = { _tag: 'UpdateProduct', id: 'long-sku-product', patch: { variants: [variant] } };
    const refused = yield* apply(created.state, command, 'too-long-generated-sku').pipe(Effect.flip);
    expect(isConflict(refused)).toBe(true);
    const accepted = yield* apply(
      created.state,
      {
        _tag: 'UpdateProduct',
        id: 'long-sku-product',
        patch: { variants: [{ ...variant, sku: 'S'.repeat(64) }] },
      },
      'explicit-bounded-sku',
    );
    expect(accepted.state.products[0]?.variants?.[0]?.sku).toHaveLength(64);
    const stocked = yield* apply(
      accepted.state,
      {
        _tag: 'RecordStockMovement',
        productId: 'long-sku-product',
        variantId: variant.id,
        reason: 'RECEIPT',
        delta: 1,
      },
      'bounded-sku-stock',
    );
    const ordered = yield* apply(
      stocked.state,
      {
        _tag: 'CreateOrder',
        id: 'bounded-sku-order',
        partyId: 'party-1',
        lines: [{ productId: 'long-sku-product', variantId: variant.id, quantity: 1 }],
      },
      'bounded-sku-order',
    );
    expect(Schema.is(MerchandiseStateSchema)(ordered.state)).toBe(true);
    expect(ordered.state.orders[0]?.lines[0]?.sku).toHaveLength(64);
  }),
);

it.effect('refuses tier repricing without a usable old base price instead of inventing tier prices', () =>
  Effect.gen(function* noBaseForTierRatio() {
    const created = yield* addProduct(empty, 'zero-tier-base', 'ZERO-TIER', 0);
    const tier = { minimumQuantity: 10, priceExcludingVatMinor: 0, priceMinor: 0 };
    const tiered: MerchandiseState = {
      ...created.state,
      products: created.state.products.map((product) => ({ ...product, priceTiers: [tier] })),
    };
    const refused = yield* apply(
      tiered,
      { _tag: 'ChangePrice', id: 'zero-tier-base', priceMinor: 1000 },
      'zero-ratio',
    ).pipe(Effect.flip);
    expect(isConflict(refused)).toBe(true);
    expect(tiered.products[0]?.priceTiers).toEqual([tier]);
  }),
);
