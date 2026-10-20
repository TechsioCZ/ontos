import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { MerchandiseStateSchema } from '../../shared/apis/records.ts';
import { MerchandiseCommandSchema } from '../../shared/actions/apply-command.ts';
import { AKROS_LEGAL_ENTITY_ID, assertStorefrontScope } from '../../shared/actions/command-guard.ts';
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
const place = (quantity: number, expectedUnitPriceMinor: number) =>
  evolveMerchandiseState(
    state,
    Schema.decodeUnknownSync(MerchandiseCommandSchema)({
      _tag: 'PlaceStorefrontOrder',
      clientRequestId: 'akros-unit-order',
      contact: { name: 'Jan Novák', email: 'jan@example.invalid' },
      deliveryAddress: { street: 'Ukázková 1', city: 'Brno', postalCode: '60200' },
      shippingMethod: 'OSOBNI_ODBER',
      lines: [{ productId: 'product-1', variantId: 'item-1', quantity, expectedUnitPriceMinor }],
    }),
    { actor, now: DateTime.makeUnsafe(at), resourceId: 'order-1' },
  );

it('retains exact source gross price, tiers and minimum in the read projection', () => {
  const record = toProductRecord(state.products[0]!, state.movements).variantRecords?.[0];
  expect(record?.grossPriceMinor).toBe(10);
  expect(record?.priceTiers?.[1]?.priceMinor).toBe(7);
  expect(record?.minimumQuantity).toBe(10);
  expect(record?.sourceId).toBe('1');
});
it.effect('enforces minimum and package quantities without persisting rejected orders', () =>
  Effect.gen(function* () {
    const minimum = yield* place(5, 10);
    expect(minimum.storefrontOrder?.issues[0]?.code).toBe('MINIMUM_QUANTITY');
    expect(minimum.state.orders).toHaveLength(0);
    const packaging = yield* place(11, 10);
    expect(packaging.storefrontOrder?.issues[0]?.code).toBe('PACKAGE_QUANTITY');
    expect(packaging.state.orders).toHaveLength(0);
  }),
);
it.effect('returns the exact current gross tier and snapshots the tier on placement', () =>
  Effect.gen(function* () {
    const changed = yield* place(100, 10);
    expect(changed.storefrontOrder?.issues[0]?.code).toBe('PRICE_CHANGED');
    expect(changed.storefrontOrder?.issues[0]?.currentUnitPriceMinor).toBe(7);
    const placed = yield* place(100, 7);
    expect(placed.storefrontOrder?.outcome).toBe('PLACED');
    expect(placed.state.orders[0]?.lines[0]?.unitPriceMinor).toBe(7);
    expect(placed.state.orders[0]?.totalMinor).toBe(700);
    expect(placed.state.movements).toEqual(state.movements);
  }),
);
it.effect('AKROS API keys may only place storefront orders', () =>
  Effect.gen(function* () {
    yield* assertStorefrontScope('non_human', AKROS_LEGAL_ENTITY_ID, 'PlaceStorefrontOrder');
    for (const tag of ['ChangePrice', 'UpdateProduct', 'CreateOrder', 'ChangeOrderStatus']) {
      const denied = yield* assertStorefrontScope('non_human', AKROS_LEGAL_ENTITY_ID, tag).pipe(Effect.flip);
      expect(denied._tag).toBe('MerchandisePermissionDenied');
    }
  }),
);
it.effect('staff price edits update live tier prices without losing source metadata', () =>
  Effect.gen(function* () {
    const changed = yield* evolveMerchandiseState(
      state,
      Schema.decodeUnknownSync(MerchandiseCommandSchema)({
        _tag: 'ChangePrice',
        id: 'product-1',
        variantId: 'item-1',
        priceMinor: 16,
      }),
      { actor, now: DateTime.makeUnsafe(at), resourceId: 'price-1' },
    );
    const variant = toProductRecord(changed.state.products[0]!, changed.state.movements).variantRecords?.[0];
    expect(variant?.grossPriceMinor).toBe(19);
    expect(variant?.priceTiers?.[1]?.priceMinor).toBe(13);
    expect(variant?.sourceId).toBe('1');
  }),
);

it.effect('first seeded variant edit snapshots its existing price through both staff commands', () =>
  Effect.gen(function* () {
    for (const command of [
      { _tag: 'ChangePrice', id: 'product-1', variantId: 'item-1', priceMinor: 9 },
      {
        _tag: 'UpdateProduct',
        id: 'product-1',
        patch: { variants: [{ ...state.products[0]!.variants![0]!, priceMinor: 9 }] },
      },
    ]) {
      const changed = yield* evolveMerchandiseState(
        state,
        Schema.decodeUnknownSync(MerchandiseCommandSchema)(command),
        { actor, now: DateTime.makeUnsafe(at), resourceId: 'first-price' },
      );
      const history = toProductRecord(changed.state.products[0]!, changed.state.movements).variantRecords?.[0]
        ?.priceHistory;
      expect(history).toHaveLength(1);
      expect(history?.[0]?.previousPriceMinor).toBe(8);
      expect(history?.[0]?.priceMinor).toBe(9);
    }
  }),
);

it.effect('AKROS pickup retains company identity when editing shipping and persisting history', () =>
  Effect.gen(function* () {
    const placed = yield* place(10, 10);
    for (const akros of [true, false]) {
      const scoped = {
        ...placed.state,
        products: placed.state.products.map((product) => ({
          ...product,
          ...(akros ? { sourceGroupId: 'source-1' } : {}),
        })),
      };
      const edited = yield* evolveMerchandiseState(
        scoped,
        Schema.decodeUnknownSync(MerchandiseCommandSchema)({
          _tag: 'EditOrder',
          id: placed.state.orders[0]!.id,
          shipping: { method: 'OSOBNI_ODBER', priceMinor: 1000 },
        }),
        { actor, now: DateTime.makeUnsafe(at), resourceId: 'shipping-edit' },
      );
      const order = edited.state.orders[0]!;
      const company = akros ? 'AKROS' : 'Kavárna Doma';
      expect(order.shipping?.label).toContain(company);
      expect(order.history?.at(-1)?.after).toContain(company);
      if (akros) expect(order.history?.at(-1)?.after).not.toContain('Kavárna');
    }
  }),
);
