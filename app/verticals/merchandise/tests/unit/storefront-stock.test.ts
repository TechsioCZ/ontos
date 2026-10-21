import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { MerchandiseStateSchema } from '../../shared/apis/records.ts';
import type { MerchandiseState } from '../../shared/apis/records.ts';
import { MerchandiseCommandSchema } from '../../shared/actions/apply-command.ts';
import { evolveMerchandiseState, toProductRecord } from '../../src/services/persistence.service.ts';

const actor = { principalId: '20000000-0000-4000-8000-000000000002', tenantId: '20000000-0000-4000-8000-000000000001' };
const at = '2026-10-19T08:00:00.000Z';
const state = Schema.decodeUnknownSync(MerchandiseStateSchema)({
  orders: [],
  movements: [{ id: 'receipt', productId: 'product-1', variantId: 'item-1', delta: 500, at, reason: 'RECEIPT' }],
  products: [
    {
      id: 'product-1',
      name: 'Nerezový šroub',
      sku: 'DIN933',
      category: 'Šrouby',
      active: true,
      unit: 'ks',
      vatRate: 21,
      currentPriceMinor: 8,
      lowStockThreshold: 5,
      createdAt: at,
      updatedAt: at,
      priceHistory: [],
      variants: [
        {
          id: 'item-1',
          sourceId: '1',
          sourceUnit: 'ks',
          sku: 'DIN933-M6',
          name: 'M6 × 20',
          attributes: '',
          active: true,
          priceMinor: 8,
          minimumQuantity: 10,
          packageQuantity: 5,
          priceTiers: [
            { minimumQuantity: 1, priceMinor: 10, priceExcludingVatMinor: 8 },
            { minimumQuantity: 100, priceMinor: 7, priceExcludingVatMinor: 6 },
          ],
        },
      ],
    },
  ],
});

const run = (current: MerchandiseState, command: unknown, resourceId: string) =>
  evolveMerchandiseState(current, Schema.decodeUnknownSync(MerchandiseCommandSchema)(command), {
    actor,
    now: DateTime.makeUnsafe(at),
    resourceId,
  });
const order = (quantity: number, clientRequestId: string) => ({
  _tag: 'PlaceStorefrontOrder',
  clientRequestId,
  contact: { name: 'Jan Novák', email: 'jan@example.invalid' },
  deliveryAddress: { street: 'Ukázková 1', city: 'Brno', postalCode: '60200' },
  shippingMethod: 'OSOBNI_ODBER',
  lines: [{ productId: 'product-1', variantId: 'item-1', quantity, expectedUnitPriceMinor: 7 }],
});
const stockOf = (current: MerchandiseState) =>
  toProductRecord(current.products[0]!, current.movements).variantRecords?.[0]?.stockOnHand;

it.effect('placed storefront order decrements variant stock with one ORDER movement', () =>
  Effect.gen(function* () {
    const placed = yield* run(state, order(100, 'akros-stock-order-1'), 'order-1');
    expect(placed.storefrontOrder?.outcome).toBe('PLACED');
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
  Effect.gen(function* () {
    const result = yield* run(state, order(600, 'akros-stock-order-2'), 'order-2');
    expect(result.storefrontOrder?.issues[0]?.code).toBe('INSUFFICIENT_STOCK');
    expect(result.state).toBe(state);
  }),
);

it.effect('replay does not move stock twice', () =>
  Effect.gen(function* () {
    const placed = yield* run(state, order(100, 'akros-stock-order-1'), 'order-1');
    const replayed = yield* run(placed.state, order(100, 'akros-stock-order-1'), 'order-1b');
    expect(replayed.storefrontOrder?.outcome).toBe('REPLAYED');
    expect(stockOf(replayed.state)).toBe(400);
  }),
);

it.effect('cancelling returns the stock', () =>
  Effect.gen(function* () {
    const placed = yield* run(state, order(100, 'akros-stock-order-1'), 'order-1');
    const cancelled = yield* run(
      placed.state,
      { _tag: 'ChangeOrderStatus', id: placed.storefrontOrder!.orderId!, status: 'CANCELLED' },
      'cancel-1',
    );
    expect(stockOf(cancelled.state)).toBe(500);
    const movement = cancelled.state.movements.at(-1);
    expect(movement?.delta).toBe(100);
    expect(movement?.note).toBe(`Storno objednávky ${placed.storefrontOrder?.orderNumber}`);
  }),
);

it.effect('removing an open DEMO order returns the stock', () =>
  Effect.gen(function* () {
    const placed = yield* run(state, order(100, 'akros-stock-order-1'), 'order-1');
    const removed = yield* run(
      placed.state,
      { _tag: 'RemoveDemoOrder', id: placed.storefrontOrder!.orderId!, reason: 'Ukázka skončila' },
      'remove-1',
    );
    expect(stockOf(removed.state)).toBe(500);
  }),
);

it.effect('removing an already cancelled order does not return stock twice', () =>
  Effect.gen(function* () {
    const placed = yield* run(state, order(100, 'akros-stock-order-1'), 'order-1');
    const orderId = placed.storefrontOrder!.orderId!;
    const cancelled = yield* run(
      placed.state,
      { _tag: 'ChangeOrderStatus', id: orderId, status: 'CANCELLED' },
      'cancel-1',
    );
    const removed = yield* run(
      cancelled.state,
      { _tag: 'RemoveDemoOrder', id: orderId, reason: 'Ukázka skončila' },
      'remove-1',
    );
    expect(stockOf(removed.state)).toBe(500);
  }),
);

for (const status of ['SHIPPED', 'DELIVERED'] as const) {
  for (const action of ['remove', 'cancel'] as const) {
    it.effect(`${action} ${status} DEMO order nets the ledger to zero, without double returns`, () =>
      Effect.gen(function* () {
        const placed = yield* run(state, order(100, `terminal-${status}-${action}`), 'terminal-order');
        const id = placed.storefrontOrder!.orderId!;
        let current = placed.state;
        for (const next of ['CONFIRMED', 'SHIPPED', ...(status === 'DELIVERED' ? ['DELIVERED'] : [])]) {
          current = (yield* run(current, { _tag: 'ChangeOrderStatus', id, status: next }, `step-${next}`)).state;
        }
        if (action === 'cancel')
          current = (yield* run(current, { _tag: 'ChangeOrderStatus', id, status: 'CANCELLED' }, 'cancel-terminal'))
            .state;
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
  Effect.gen(function* () {
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
  Effect.gen(function* () {
    const refused = yield* run(
      state,
      { _tag: 'ArchiveDemoProduct', id: 'product-1', reason: 'Úklid DEMO katalogu' },
      'archive',
    ).pipe(Effect.flip);
    expect(refused._tag).toBe('MerchandiseLifecycleConflict');
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
