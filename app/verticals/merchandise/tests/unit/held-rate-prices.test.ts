// A product held at its stored rate (BOOK-IT on stage: reduced, sold at 10 % until Tax first prices the company)
// stores every price entered for it in that time at the held 10 %, as its order lines and the storefront sell it:
// a price change, a bulk percentage change, a variant entered with a price and a variant's own price change. Once Tax
// prices the company the product is held no more: the stored gross stays, and an order splits it at 12 %.
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { MerchandiseCommandSchema } from '../../shared/actions/apply-command.ts';
import type { MerchandiseState } from '../../shared/apis/records.ts';
import { ProductSchema, grossUnitPriceMinor } from '../../shared/domain/merchandise-model.ts';
import { withStorefrontVat } from '../../src/services/merchandise-queries.ts';
import { evolveMerchandiseState } from '../../src/services/persistence.service.ts';
import type { CommandTax } from '../../src/services/persistence.service.ts';
import { stockLevelsOf, toProductRecord } from '../../src/services/stock-levels.ts';
import { TEST_RATES, TEST_TAX } from '../support/tax-fixtures.ts';

const actor = {
  principalId: '20000000-0000-4000-8000-000000000002',
  tenantId: '20000000-0000-4000-8000-000000000001',
};
const t0 = DateTime.makeUnsafe('2026-10-19T10:00:00Z');
const empty: MerchandiseState = { movements: [], orders: [], products: [] };
const decodeCommand = Schema.decodeUnknownSync(MerchandiseCommandSchema);
type CommandInput = typeof MerchandiseCommandSchema.Encoded;

/** The migrated, unconfirmed state: BOOK-IT keeps selling at its stored 10 %; the reduced rate is 12 %. */
const HELD_TAX: CommandTax = { ...TEST_TAX, held: { 'book-it': 10 }, migrated: true };

const apply = (state: MerchandiseState, command: CommandInput, resourceId: string, tax: CommandTax = HELD_TAX) =>
  evolveMerchandiseState(state, decodeCommand(command), { actor, now: t0, resourceId, tax });

const productOf = (state: MerchandiseState) => {
  const product = state.products.find((entry) => entry.id === 'book-it');
  if (product === undefined) {
    throw new Error('BOOK-IT is missing');
  }
  return product;
};

/** BOOK-IT as the migration leaves it (net 49 000, gross 53 900 at 10 %), in stock. */
const bookIt = Effect.gen(function* seedBookIt() {
  const created = yield* apply(
    empty,
    {
      _tag: 'CreateProduct',
      active: true,
      category: 'Software',
      lowStockThreshold: 0,
      name: 'BOOK-IT',
      priceMinor: 49_000,
      sku: 'BOOK-IT',
      taxClassificationCode: 'cz.vat.reduced',
      unit: 'lic',
    },
    'book-it',
  );
  const migrated: MerchandiseState = {
    ...created.state,
    products: [{ ...productOf(created.state), grossPriceMinor: 53_900 }],
  };
  const stocked = yield* apply(
    migrated,
    { _tag: 'RecordStockMovement', delta: 10, productId: 'book-it', reason: 'RECEIPT' },
    'receipt',
  );
  return stocked.state;
});

const order = (expectedUnitPriceMinor: number, variantId?: string): CommandInput => ({
  _tag: 'PlaceStorefrontOrder',
  clientRequestId: `client-request-${expectedUnitPriceMinor}`,
  contact: { email: 'tereza@example.cz', name: 'Tereza Ukázková' },
  deliveryAddress: { city: 'Brno', postalCode: '602 00', street: 'Ukázková 12' },
  lines: [
    variantId === undefined
      ? { expectedUnitPriceMinor, productId: 'book-it', quantity: 1 }
      : { expectedUnitPriceMinor, productId: 'book-it', quantity: 1, variantId },
  ],
  partyId: 'test-customer-party',
  shippingMethod: 'ZASILKOVNA',
});

it.effect('a price entered for a held product stores its gross at the held rate, as it sells', () =>
  Effect.gen(function* heldPrices() {
    const state = yield* bookIt;
    // A price change: 50 000 net is 55 000 with 10 %, never 56 000 with 12 %.
    const changed = yield* apply(state, { _tag: 'ChangePrice', id: 'book-it', priceMinor: 50_000 }, 'change');
    expect(productOf(changed.state).grossPriceMinor).toBe(grossUnitPriceMinor(50_000, 10));
    expect(productOf(changed.state).grossPriceMinor).toBe(55_000);
    // A bulk change of +10 %: 55 000 net, 60 500 with 10 %.
    const bulk = yield* apply(
      changed.state,
      { _tag: 'BulkUpdateProducts', ids: ['book-it'], patch: { priceChangePercent: 10 } },
      'bulk',
    );
    expect(productOf(bulk.state)).toMatchObject({ currentPriceMinor: 55_000, grossPriceMinor: 60_500 });
    // The order line sells at that gross and records the held 10 %; the storefront shows 10 %.
    const sold = yield* apply(bulk.state, order(60_500), 'order-held');
    expect(sold.storefrontOrder?.outcome).toBe('PLACED');
    expect(sold.state.orders[0]?.lines[0]).toMatchObject({ unitPriceMinor: 60_500, vatRate: 10 });
    const product = productOf(bulk.state);
    const record = toProductRecord(product, stockLevelsOf(bulk.state.movements, product.id), TEST_RATES, {});
    expect(record.grossPriceMinor).toBe(60_500);
    expect(withStorefrontVat(record, TEST_RATES, HELD_TAX.held).vatRate).toBe(10);
    // Tax prices the company: BOOK-IT is held no more. Its stored gross stays, and an order splits it at 12 %.
    const priced = yield* apply(bulk.state, order(60_500), 'order-priced', TEST_TAX);
    expect(priced.state.orders[0]?.lines[0]).toMatchObject({ unitPriceMinor: 60_500, vatRate: 12 });
    expect(withStorefrontVat(record, TEST_RATES, {}).vatRate).toBe(12);
  }),
);

it.effect('a variant entered or repriced for a held product stores its gross at the held rate', () =>
  Effect.gen(function* heldVariants() {
    const state = yield* bookIt;
    // A variant entered with a price: 30 000 net, 33 000 with 10 %.
    const edited = yield* apply(
      state,
      {
        _tag: 'UpdateProduct',
        id: 'book-it',
        patch: { variants: [{ attributes: 'Licence: roční', name: 'Roční', priceMinor: 30_000, sku: 'BOOK-IT-Y' }] },
      },
      'variant',
    );
    const [variant] = productOf(edited.state).variants ?? [];
    expect(variant).toMatchObject({ grossPriceMinor: 33_000, priceMinor: 30_000 });
    const variantId = variant?.id ?? '';
    // The variant's own price change: 40 000 net, 44 000 with 10 %.
    const repriced = yield* apply(
      edited.state,
      { _tag: 'ChangePrice', id: 'book-it', priceMinor: 40_000, variantId },
      'variant-price',
    );
    const [after] = productOf(repriced.state).variants ?? [];
    expect(after).toMatchObject({ grossPriceMinor: 44_000, priceMinor: 40_000 });
    const stocked = yield* apply(
      repriced.state,
      { _tag: 'RecordStockMovement', delta: 3, productId: 'book-it', reason: 'RECEIPT', variantId },
      'variant-receipt',
    );
    const sold = yield* apply(stocked.state, order(44_000, variantId), 'variant-order');
    expect(sold.state.orders[0]?.lines[0]).toMatchObject({ unitPriceMinor: 44_000, vatRate: 10 });
    // Once Tax prices the company the variant keeps its gross; the order splits it at 12 %.
    const priced = yield* apply(stocked.state, order(44_000, variantId), 'variant-priced', TEST_TAX);
    expect(priced.state.orders[0]?.lines[0]).toMatchObject({ unitPriceMinor: 44_000, vatRate: 12 });
  }),
);

it.effect('a held price stored without its gross is shown, labelled and charged at the held rate, never at 12 %', () =>
  Effect.gen(function* heldWithoutGross() {
    const state = yield* bookIt;
    // BOOK-IT and a variant of it as stage may hold them: no gross stored anywhere.
    const { grossPriceMinor: _gross, ...withoutGross } = productOf(state);
    void _gross;
    const variant = { attributes: 'Licence: roční', id: 'yearly', name: 'Roční', priceMinor: 30_000, sku: 'BOOK-IT-Y' };
    const plain = toProductRecord(withoutGross, stockLevelsOf([], 'book-it'), TEST_RATES, HELD_TAX.held);
    expect(plain.grossPriceMinor).toBe(grossUnitPriceMinor(49_000, 10));
    expect(withStorefrontVat(plain, TEST_RATES, HELD_TAX.held).vatRate).toBe(10);
    const withVariant = toProductRecord(
      Schema.decodeUnknownSync(ProductSchema)({
        ...Schema.encodeSync(ProductSchema)(withoutGross),
        variants: [variant],
      }),
      stockLevelsOf([], 'book-it'),
      TEST_RATES,
      HELD_TAX.held,
    );
    expect(withVariant.variantRecords?.map((entry) => entry.grossPriceMinor)).toEqual([
      grossUnitPriceMinor(30_000, 10),
    ]);
    expect(withVariant.grossPriceMinor).toBe(grossUnitPriceMinor(30_000, 10));
    // The order line charges the same 10 %: the gross the storefront showed, split at the rate it was labelled with.
    const sold = yield* apply({ ...state, products: [withoutGross] }, order(grossUnitPriceMinor(49_000, 10)), 'sold');
    expect(sold.state.orders[0]?.lines[0]).toMatchObject({
      unitPriceMinor: grossUnitPriceMinor(49_000, 10),
      vatRate: 10,
    });
  }),
);
