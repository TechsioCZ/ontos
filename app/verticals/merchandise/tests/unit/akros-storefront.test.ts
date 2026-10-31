import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { MerchandiseStateSchema } from '../../shared/apis/records.ts';
import { SourceGroupIdSchema } from '../../shared/domain/merchandise-model.ts';
import { MerchandiseCommandSchema, MerchandisePermissionDenied } from '../../shared/actions/apply-command.ts';
import { AKROS_LEGAL_ENTITY_ID, assertStorefrontScope } from '../../shared/actions/command-guard.ts';
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
const place = (quantity: number, expectedUnitPriceMinor: number) =>
  evolveMerchandiseState(
    state,
    Schema.decodeUnknownSync(MerchandiseCommandSchema)({
      _tag: 'PlaceStorefrontOrder',
      clientRequestId: 'akros-unit-order',
      contact: { email: 'jan@example.invalid', name: 'Jan Novák' },
      deliveryAddress: { city: 'Brno', postalCode: '60200', street: 'Ukázková 1' },
      lines: [{ expectedUnitPriceMinor, productId: 'product-1', quantity, variantId: 'item-1' }],
      partyId: 'test-customer-party',
      shippingMethod: 'OSOBNI_ODBER',
    }),
    { actor, now: DateTime.makeUnsafe(at), resourceId: 'order-1' },
  );

it('retains exact source gross price, tiers and minimum in the read projection', () => {
  const record = recordOf(state.products[0], state.movements).variantRecords?.[0];
  expect(record?.grossPriceMinor).toBe(10);
  expect(record?.priceTiers?.[1]?.priceMinor).toBe(7);
  expect(record?.minimumQuantity).toBe(10);
  expect(record?.sourceId).toBe('1');
});
it.effect('enforces minimum and package quantities without persisting rejected orders', () =>
  Effect.gen(function* merchandiseScenario1() {
    const minimum = yield* place(5, 10);
    expect(minimum.storefrontOrder?.issues[0]?.code).toBe('MINIMUM_QUANTITY');
    expect(minimum.state.orders).toHaveLength(0);
    const packaging = yield* place(11, 10);
    expect(packaging.storefrontOrder?.issues[0]?.code).toBe('PACKAGE_QUANTITY');
    expect(packaging.state.orders).toHaveLength(0);
  }),
);
it.effect('returns the exact current gross tier and snapshots the tier on placement', () =>
  Effect.gen(function* merchandiseScenario2() {
    const changed = yield* place(100, 10);
    expect(changed.storefrontOrder?.issues[0]?.code).toBe('PRICE_CHANGED');
    expect(changed.storefrontOrder?.issues[0]?.currentUnitPriceMinor).toBe(7);
    const placed = yield* place(100, 7);
    expect(placed.storefrontOrder?.outcome).toBe('PLACED');
    expect(placed.state.orders[0]?.lines[0]?.unitPriceMinor).toBe(7);
    expect(placed.state.orders[0]?.totalMinor).toBe(700);
    expect(placed.state.movements).toHaveLength(state.movements.length + 1);
    expect(placed.state.movements.at(-1)?.delta).toBe(-100);
  }),
);
it.effect('AKROS API keys may only place storefront orders', () =>
  Effect.gen(function* merchandiseScenario3() {
    yield* assertStorefrontScope('api_key', AKROS_LEGAL_ENTITY_ID, 'PlaceStorefrontOrder');
    for (const tag of ['ChangePrice', 'UpdateProduct', 'CreateOrder', 'ChangeOrderStatus']) {
      const denied = yield* assertStorefrontScope('api_key', AKROS_LEGAL_ENTITY_ID, tag).pipe(Effect.flip);
      expect(Schema.is(MerchandisePermissionDenied)(denied)).toBe(true);
    }
  }),
);
it.effect('staff price edits update live tier prices without losing source metadata', () =>
  Effect.gen(function* merchandiseScenario4() {
    const changed = yield* evolveMerchandiseState(
      state,
      Schema.decodeUnknownSync(MerchandiseCommandSchema)({
        _tag: 'ChangePrice',
        id: 'product-1',
        priceMinor: 16,
        variantId: 'item-1',
      }),
      { actor, now: DateTime.makeUnsafe(at), resourceId: 'price-1' },
    );
    const variant = recordOf(changed.state.products[0], changed.state.movements).variantRecords?.[0];
    expect(variant?.grossPriceMinor).toBe(19);
    expect(variant?.priceTiers?.[1]?.priceMinor).toBe(13);
    expect(variant?.sourceId).toBe('1');
  }),
);

it.effect('first seeded variant edit snapshots its existing price through both staff commands', () =>
  Effect.gen(function* merchandiseScenario5() {
    for (const command of [
      { _tag: 'ChangePrice', id: 'product-1', priceMinor: 9, variantId: 'item-1' },
      {
        _tag: 'UpdateProduct',
        id: 'product-1',
        patch: { variants: [{ ...requireFixture(state.products[0].variants)[0], priceMinor: 9 }] },
      },
    ]) {
      const changed = yield* evolveMerchandiseState(
        state,
        Schema.decodeUnknownSync(MerchandiseCommandSchema)(command),
        { actor, now: DateTime.makeUnsafe(at), resourceId: 'first-price' },
      );
      const history = recordOf(changed.state.products[0], changed.state.movements).variantRecords?.[0]?.priceHistory;
      expect(history).toHaveLength(1);
      expect(history?.[0]?.previousPriceMinor).toBe(8);
      expect(history?.[0]?.priceMinor).toBe(9);
    }
  }),
);

it.effect('AKROS pickup retains company identity when editing shipping and persisting history', () =>
  Effect.gen(function* merchandiseScenario6() {
    const placed = yield* place(10, 10);
    for (const akros of [true, false]) {
      const scoped = {
        ...placed.state,
        products: placed.state.products.map((product) => {
          if (akros) {
            return { ...product, sourceGroupId: Schema.decodeSync(SourceGroupIdSchema)('source-1') };
          }
          return { ...product };
        }),
      };
      const edited = yield* evolveMerchandiseState(
        scoped,
        Schema.decodeUnknownSync(MerchandiseCommandSchema)({
          _tag: 'EditOrder',
          id: placed.state.orders[0].id,
          shipping: { method: 'OSOBNI_ODBER', priceMinor: 1000 },
        }),
        { actor, now: DateTime.makeUnsafe(at), resourceId: 'shipping-edit' },
      );
      const [order] = edited.state.orders;
      const company = akros ? 'AKROS' : 'Osobní odběr';
      expect(order.shipping?.label).toContain(company);
      expect(order.history?.at(-1)?.after).toContain(company);
      if (akros) {
        expect(order.history?.at(-1)?.after).not.toContain('Kavárna');
      }
    }
  }),
);
