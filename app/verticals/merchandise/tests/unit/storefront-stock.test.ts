import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { MerchandiseStateSchema } from '../../shared/apis/records.ts';
import type { MerchandiseState } from '../../shared/apis/records.ts';
import { MerchandiseCommandSchema, MerchandiseLifecycleConflict } from '../../shared/actions/apply-command.ts';
import { OrderStatusSchema, VariantIdSchema } from '../../shared/domain/merchandise-model.ts';
import { evolveMerchandiseState } from '../../src/services/persistence.service.ts';
import { stockLevelsOf, toProductRecord } from '../../src/services/stock-levels.ts';

/** A missing fixture value fails the test before its fields are read. */
const requireFixture = <T>(value: T | null | undefined): T => {
  if (value === undefined || value === null) {
    expect.unreachable('The fixture must be present before its fields are read');
  }
  return value;
};

const recordOf = (product: Parameters<typeof toProductRecord>[0], movements: Parameters<typeof stockLevelsOf>[0]) =>
  toProductRecord(product, stockLevelsOf(movements, product.id));

const actor = { principalId: '20000000-0000-4000-8000-000000000002', tenantId: '20000000-0000-4000-8000-000000000001' };
const at = '2026-10-19T08:00:00.000Z';
const state = Schema.decodeUnknownSync(MerchandiseStateSchema)({
  movements: [{ at, delta: 500, id: 'receipt', productId: 'product-1', reason: 'RECEIPT', variantId: 'item-1' }],
  orders: [],
  products: [
    {
      active: true,
      category: 'Šrouby',
      createdAt: at,
      currentPriceMinor: 8,
      id: 'product-1',
      lowStockThreshold: 5,
      name: 'Nerezový šroub',
      priceHistory: [],
      sku: 'DIN933',
      unit: 'ks',
      updatedAt: at,
      variants: [
        {
          active: true,
          attributes: '',
          id: 'item-1',
          minimumQuantity: 10,
          name: 'M6 × 20',
          packageQuantity: 5,
          priceMinor: 8,
          priceTiers: [
            { minimumQuantity: 1, priceExcludingVatMinor: 8, priceMinor: 10 },
            { minimumQuantity: 100, priceExcludingVatMinor: 6, priceMinor: 7 },
          ],
          sku: 'DIN933-M6',
          sourceId: '1',
          sourceUnit: 'ks',
        },
      ],
      vatRate: 21,
    },
  ],
});

const run = (current: MerchandiseState, command: typeof MerchandiseCommandSchema.Encoded, resourceId: string) =>
  evolveMerchandiseState(current, Schema.decodeUnknownSync(MerchandiseCommandSchema)(command), {
    actor,
    now: DateTime.makeUnsafe(at),
    resourceId,
  });
const order = (
  quantity: number,
  clientRequestId: string,
): Extract<typeof MerchandiseCommandSchema.Encoded, { readonly _tag: 'PlaceStorefrontOrder' }> => ({
  _tag: 'PlaceStorefrontOrder',
  clientRequestId,
  contact: { email: 'jan@example.invalid', name: 'Jan Novák' },
  customerAccountId: 'portal-customer-one',
  deliveryAddress: { city: 'Brno', postalCode: '60200', street: 'Ukázková 1' },
  lines: [{ expectedUnitPriceMinor: 7, productId: 'product-1', quantity, variantId: 'item-1' }],
  partyId: 'test-customer-party',
  shippingMethod: 'OSOBNI_ODBER',
});
const stockOf = (current: MerchandiseState) =>
  recordOf(current.products[0], current.movements).variantRecords?.[0]?.stockOnHand;

// Demo cleanup tests explicitly construct demo records; actual placements are never marked simulated.
const asDemo = (current: MerchandiseState): MerchandiseState => ({
  ...current,
  orders: current.orders.map((entry) => ({ ...entry, demo: true })),
});

it.effect('placed storefront order decrements variant stock with one ORDER movement', () =>
  Effect.gen(function* merchandiseScenario1() {
    const placed = yield* run(state, order(100, 'akros-stock-order-1'), 'order-1');
    expect(placed.storefrontOrder?.outcome).toBe('PLACED');
    expect(placed.state.orders[0]?.customerAccountId).toBe('portal-customer-one');
    expect(placed.state.orders[0]?.demo).toBeUndefined();
    expect(stockOf(placed.state)).toBe(400);
    const movement = placed.state.movements.at(-1);
    const number = placed.storefrontOrder?.orderNumber;
    expect(movement?.reason).toBe('ORDER');
    expect(movement?.delta).toBe(-100);
    expect(movement?.variantId).toBe('item-1');
    expect(movement?.reference).toBe(number);
    expect(movement?.note).toBe(`Objednávka ${number} z e-shopu`);
  }),
);

it.effect('rejects more than stock on hand and saves nothing', () =>
  Effect.gen(function* merchandiseScenario2() {
    const result = yield* run(state, order(600, 'akros-stock-order-2'), 'order-2');
    expect(result.storefrontOrder?.issues[0]?.code).toBe('INSUFFICIENT_STOCK');
    expect(result.state).toBe(state);
  }),
);

it.effect('replay does not move stock twice', () =>
  Effect.gen(function* merchandiseScenario3() {
    const placed = yield* run(state, order(100, 'akros-stock-order-1'), 'order-1');
    const replayed = yield* run(placed.state, order(100, 'akros-stock-order-1'), 'order-1b');
    expect(replayed.storefrontOrder?.outcome).toBe('REPLAYED');
    expect(stockOf(replayed.state)).toBe(400);
  }),
);

it.effect('cancelling returns the stock', () =>
  Effect.gen(function* merchandiseScenario4() {
    const placed = yield* run(state, order(100, 'akros-stock-order-1'), 'order-1');
    const cancelled = yield* run(
      placed.state,
      {
        _tag: 'ChangeOrderStatus',
        id: requireFixture(requireFixture(placed.storefrontOrder).orderId),
        status: 'CANCELLED',
      },
      'cancel-1',
    );
    expect(stockOf(cancelled.state)).toBe(500);
    const movement = cancelled.state.movements.at(-1);
    expect(movement?.delta).toBe(100);
    expect(movement?.note).toBe(`Storno objednávky ${placed.storefrontOrder?.orderNumber}`);
  }),
);

it.effect('removing an open DEMO order returns the stock', () =>
  Effect.gen(function* merchandiseScenario5() {
    const placed = yield* run(state, order(100, 'akros-stock-order-1'), 'order-1');
    const removed = yield* run(
      asDemo(placed.state),
      {
        _tag: 'RemoveDemoOrder',
        id: requireFixture(requireFixture(placed.storefrontOrder).orderId),
        reason: 'Ukázka skončila',
      },
      'remove-1',
    );
    expect(stockOf(removed.state)).toBe(500);
  }),
);

it.effect('removing an already cancelled order does not return stock twice', () =>
  Effect.gen(function* merchandiseScenario6() {
    const placed = yield* run(state, order(100, 'akros-stock-order-1'), 'order-1');
    const orderId = requireFixture(requireFixture(placed.storefrontOrder).orderId);
    const cancelled = yield* run(
      placed.state,
      { _tag: 'ChangeOrderStatus', id: orderId, status: 'CANCELLED' },
      'cancel-1',
    );
    const removed = yield* run(
      asDemo(cancelled.state),
      { _tag: 'RemoveDemoOrder', id: orderId, reason: 'Ukázka skončila' },
      'remove-1',
    );
    expect(stockOf(removed.state)).toBe(500);
  }),
);

for (const status of ['SHIPPED', 'DELIVERED'] as const) {
  for (const action of ['remove', 'cancel'] as const) {
    it.effect(`${action} ${status} DEMO order nets the ledger to zero, without double returns`, () =>
      Effect.gen(function* merchandiseScenario7() {
        const placed = yield* run(state, order(100, `terminal-${status}-${action}`), 'terminal-order');
        const id = requireFixture(requireFixture(placed.storefrontOrder).orderId);
        let current = asDemo(placed.state);
        for (const next of ['CONFIRMED', 'SHIPPED', ...(status === 'DELIVERED' ? ['DELIVERED'] : [])]) {
          current = (yield* run(
            current,
            {
              _tag: 'ChangeOrderStatus',
              id,
              status: Schema.decodeUnknownSync(OrderStatusSchema)(next),
            },
            `step-${next}`,
          )).state;
        }
        if (action === 'cancel') {
          current = (yield* run(current, { _tag: 'ChangeOrderStatus', id, status: 'CANCELLED' }, 'cancel-terminal'))
            .state;
        }
        current = (yield* run(current, { _tag: 'RemoveDemoOrder', id, reason: 'Ukázka skončila' }, 'remove-terminal'))
          .state;
        expect(stockOf(current)).toBe(500);
        expect(current.movements.filter((m) => m.reason === 'ORDER').reduce((sum, m) => sum + m.delta, 0)).toBe(0);
        const replay = yield* run(current, { _tag: 'RemoveDemoOrder', id, reason: 'Ukázka skončila' }, 'remove-replay');
        expect(replay.state).toBe(current);
      }),
    );
  }
}

it.effect('staff image changes synchronize imageSrc, including empty galleries', () =>
  Effect.gen(function* merchandiseScenario8() {
    const changed = yield* run(
      state,
      { _tag: 'UpdateProduct', id: 'product-1', patch: { images: ['/first.png', '/second.png'] } },
      'image-update',
    );
    expect(changed.state.products[0]?.imageSrc).toBe('/first.png');
    const cleared = yield* run(
      changed.state,
      { _tag: 'UpdateProduct', id: 'product-1', patch: { images: [] } },
      'image-clear',
    );
    expect(cleared.state.products[0]?.imageSrc).toBe('');
  }),
);

it.effect('archives only inactive unpublished products and retains the ledger and actor audit', () =>
  Effect.gen(function* merchandiseScenario9() {
    const refused = yield* run(
      state,
      { _tag: 'ArchiveDemoProduct', id: 'product-1', reason: 'Úklid DEMO katalogu' },
      'archive',
    ).pipe(Effect.flip);
    expect(Schema.is(MerchandiseLifecycleConflict)(refused)).toBe(true);
    const hidden = yield* run(
      state,
      { _tag: 'UpdateProduct', id: 'product-1', patch: { active: false, published: false } },
      'hide',
    );
    const archived = yield* run(
      hidden.state,
      { _tag: 'ArchiveDemoProduct', id: 'product-1', reason: 'Úklid DEMO katalogu' },
      'archive',
    );
    expect(archived.state.products[0]?.demoArchive?.actor).toEqual(actor);
    expect(archived.state.products[0]?.demoArchive?.reason).toBe('Úklid DEMO katalogu');
    expect(archived.state.movements).toBe(state.movements);
  }),
);

it.effect('legacy removed order repair is explicit and ledger-idempotent', () =>
  Effect.gen(function* merchandiseScenario10() {
    const placed = yield* run(state, order(100, 'legacy-removed-order'), 'legacy-order');
    const [original] = placed.state.orders;
    const legacy = {
      ...placed.state,
      orders: [
        {
          ...original,
          demo: true,
          demoCleanup: { actor, at: DateTime.makeUnsafe(at), reason: 'Dřívější odstranění' },
          status: 'DELIVERED' as const,
        },
      ],
    };
    const replay = yield* run(
      legacy,
      { _tag: 'RemoveDemoOrder', id: original.id, reason: 'Opakované odstranění' },
      'legacy-replay',
    );
    expect(replay.state).toBe(legacy);
    const repaired = yield* run(
      legacy,
      { _tag: 'RemoveDemoOrder', id: original.id, reason: 'Dorovnání chybějícího skladu', repairStock: true },
      'legacy-repair',
    );
    expect(stockOf(repaired.state)).toBe(500);
    expect(repaired.state.orders[0]?.history?.at(-1)?.reason).toBe('Dorovnání chybějícího skladu');
    const repeated = yield* run(
      repaired.state,
      { _tag: 'RemoveDemoOrder', id: original.id, reason: 'Opakované dorovnání skladu', repairStock: true },
      'legacy-repair-2',
    );
    expect(repeated.state).toBe(repaired.state);
  }),
);

it.effect('a different customer cannot replay another account submission', () =>
  Effect.gen(function* merchandiseScenario11() {
    const placed = yield* run(state, order(100, 'account-replay'), 'account-order');
    const rejected = yield* run(
      placed.state,
      { ...order(100, 'account-replay'), customerAccountId: 'other-customer' },
      'other-order',
    ).pipe(Effect.flip);
    expect(Schema.is(MerchandiseLifecycleConflict)(rejected)).toBe(true);
  }),
);
it.effect('a real customer order cannot be deleted by demo cleanup', () =>
  Effect.gen(function* merchandiseScenario12() {
    const placed = yield* run(state, order(100, 'real-order'), 'real-order');
    const rejected = yield* run(
      placed.state,
      {
        _tag: 'RemoveDemoOrder',
        id: requireFixture(requireFixture(placed.storefrontOrder).orderId),
        reason: 'Not a demo record',
      },
      'cleanup',
    ).pipe(Effect.flip);
    expect(Schema.is(MerchandiseLifecycleConflict)(rejected)).toBe(true);
  }),
);
it.effect('dry-run validates actual cart without fake contact or address and saves nothing', () =>
  Effect.gen(function* merchandiseScenario13() {
    const request = order(100, 'quote-without-contact');
    const { contact: _contact, deliveryAddress: _address, ...cartRequest } = request;
    const result = yield* run(state, { ...cartRequest, dryRun: true }, 'quote');
    expect(result.storefrontOrder?.outcome).toBe('VALID');
    expect(result.state).toBe(state);
    const rejected = yield* run(state, cartRequest, 'invalid-order').pipe(Effect.flip);
    expect(Schema.is(MerchandiseLifecycleConflict)(rejected)).toBe(true);
  }),
);

it('replenishment uses the product minimum, independently of variant availability', () => {
  const [product] = state.products;
  const { variants: _variants, ...base } = requireFixture(product);
  expect(toProductRecord({ ...base, lowStockThreshold: 0 }, { total: 0, variants: new Map() })).toMatchObject({
    availability: 'OUT_OF_STOCK',
    lowStock: false,
  });
  expect(toProductRecord({ ...base, lowStockThreshold: 5 }, { total: 5, variants: new Map() }).lowStock).toBe(false);
  expect(toProductRecord({ ...base, lowStockThreshold: 5 }, { total: 4, variants: new Map() }).lowStock).toBe(true);
  const mixed = {
    ...product,
    variants: [
      ...requireFixture(product.variants),
      { ...requireFixture(product.variants)[0], id: Schema.decodeUnknownSync(VariantIdSchema)('empty-variant') },
    ],
  };
  const record = toProductRecord(mixed, { total: 500, variants: new Map([['item-1', 500]]) });
  expect(record.lowStock).toBe(false);
  expect(record.variantRecords?.find((variant) => variant.id === 'empty-variant')?.availability).toBe('OUT_OF_STOCK');
});
