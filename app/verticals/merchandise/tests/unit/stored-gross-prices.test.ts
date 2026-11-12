// Stored prices are never recomputed: the gross a product was entered with stays its price through stock writes, a
// classification change and a later rate change in Tax, and a storefront order sells at it. Only the VAT split inside
// the gross follows the rate in force when the order is placed. The case is BOOK-IT on stage: entered at 10 %
// (net 49 000, gross 53 900), now reduced (12 %), still sold at 539 Kč.
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { MerchandiseCommandSchema } from '../../shared/actions/apply-command.ts';
import type { MerchandiseState } from '../../shared/apis/records.ts';
import { OrderSchema } from '../../shared/domain/merchandise-model.ts';
import { evolveMerchandiseState } from '../../src/services/persistence.service.ts';
import { stockLevelsOf, toProductRecord } from '../../src/services/stock-levels.ts';
import { sellableRatesAt } from '../../src/services/tax-rates.ts';
import { TEST_RATES, TEST_TAX, testTaxBook } from '../support/tax-fixtures.ts';

const actor = {
  principalId: '20000000-0000-4000-8000-000000000002',
  tenantId: '20000000-0000-4000-8000-000000000001',
};
const t0 = DateTime.makeUnsafe('2026-10-19T10:00:00Z');
const empty: MerchandiseState = { movements: [], orders: [], products: [] };
const decodeCommand = Schema.decodeUnknownSync(MerchandiseCommandSchema);
type CommandInput = typeof MerchandiseCommandSchema.Encoded;

const apply = (state: MerchandiseState, command: CommandInput, resourceId: string, tax = TEST_TAX) =>
  evolveMerchandiseState(state, decodeCommand(command), { actor, now: t0, resourceId, tax });

/** Tax later moves the standard rate to 23 % and the reduced one to 14 %. */
const raisedBook = testTaxBook({ reduced: '14', standard: '23' });
const RAISED_TAX = { book: raisedBook, held: {}, rates: sellableRatesAt(raisedBook, t0), refused: false };

/** BOOK-IT as the migration leaves it: classified reduced, its stored 10 % prices untouched. */
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
  const [product] = created.state.products;
  if (product === undefined) {
    return yield* Effect.die('BOOK-IT was not created');
  }
  const migrated: MerchandiseState = { ...created.state, products: [{ ...product, grossPriceMinor: 53_900 }] };
  const stocked = yield* apply(
    migrated,
    { _tag: 'RecordStockMovement', delta: 5, productId: 'book-it', reason: 'RECEIPT' },
    'receipt',
  );
  return stocked.state;
});

const productOf = (state: MerchandiseState) => state.products.find((product) => product.id === 'book-it');
const grossOf = (state: MerchandiseState, rates = TEST_RATES) => {
  const product = productOf(state);
  return product === undefined
    ? undefined
    : toProductRecord(product, stockLevelsOf(state.movements, product.id), rates).grossPriceMinor;
};

const storefrontOrder = (expectedUnitPriceMinor: number): CommandInput => ({
  _tag: 'PlaceStorefrontOrder',
  clientRequestId: 'client-request-book-it',
  contact: { email: 'tereza@example.cz', name: 'Tereza Ukázková' },
  deliveryAddress: { city: 'Brno', postalCode: '602 00', street: 'Ukázková 12' },
  lines: [{ expectedUnitPriceMinor, productId: 'book-it', quantity: 2 }],
  partyId: 'test-customer-party',
  shippingMethod: 'ZASILKOVNA',
});

it.effect('a stored gross survives stock writes and a classification change, net included', () =>
  Effect.gen(function* storedGross() {
    const state = yield* bookIt;
    expect(productOf(state)).toMatchObject({ currentPriceMinor: 49_000, grossPriceMinor: 53_900 });
    expect(grossOf(state)).toBe(53_900);
    const issued = yield* apply(
      state,
      { _tag: 'RecordStockMovement', delta: -1, productId: 'book-it', reason: 'ADJUSTMENT' },
      'adjust',
    );
    expect(productOf(issued.state)).toMatchObject({ currentPriceMinor: 49_000, grossPriceMinor: 53_900 });
    const reclassified = yield* apply(
      issued.state,
      { _tag: 'UpdateProduct', id: 'book-it', patch: { taxClassificationCode: 'cz.vat.standard' } },
      'reclassify',
    );
    expect(productOf(reclassified.state)).toMatchObject({
      currentPriceMinor: 49_000,
      grossPriceMinor: 53_900,
      taxClassificationCode: 'cz.vat.standard',
    });
    expect(grossOf(reclassified.state)).toBe(53_900);
  }),
);

it.effect('a rate change in Tax moves no stored price', () =>
  Effect.gen(function* rateChange() {
    const state = yield* bookIt;
    expect(grossOf(state, RAISED_TAX.rates)).toBe(53_900);
    const restocked = yield* apply(
      state,
      { _tag: 'RecordStockMovement', delta: 1, productId: 'book-it', reason: 'RECEIPT' },
      'restock',
      RAISED_TAX,
    );
    expect(productOf(restocked.state)).toMatchObject({ currentPriceMinor: 49_000, grossPriceMinor: 53_900 });
  }),
);

it.effect('a storefront order sells at the stored gross and records the rate and rule in force now', () =>
  Effect.gen(function* placeAtStoredGross() {
    const state = yield* bookIt;
    const placed = yield* apply(state, storefrontOrder(53_900), 'order-now');
    expect(placed.storefrontOrder?.outcome).toBe('PLACED');
    expect(placed.storefrontOrder?.totalMinor).toBe(2 * 53_900 + 7900);
    expect(placed.state.orders[0]?.lines).toEqual([
      expect.objectContaining({
        quantity: 2,
        taxClassificationCode: 'cz.vat.reduced',
        taxRuleRevisionId: 'revision-reduced',
        unitPriceMinor: 53_900,
        vatRate: 12,
      }),
    ]);
    // After Tax raises the reduced rate the customer still pays 539 Kč; only the VAT inside it is 14 %.
    const raised = yield* apply(state, storefrontOrder(53_900), 'order-raised', RAISED_TAX);
    expect(raised.storefrontOrder?.totalMinor).toBe(2 * 53_900 + 7900);
    expect(raised.state.orders[0]?.lines[0]).toMatchObject({ unitPriceMinor: 53_900, vatRate: 14 });
  }),
);

it.effect('order history keeps its rate and amounts; lines from before classifications decode as they are', () =>
  Effect.gen(function* history() {
    const orders = Schema.Array(OrderSchema);
    const placed = yield* apply(yield* bookIt, storefrontOrder(53_900), 'order-history');
    // OBJ-2026-0006 on stage: a 10 % line without a classification or a rule revision.
    const legacyOrders = Schema.decodeUnknownSync(orders)(
      Schema.encodeSync(orders)(placed.state.orders).map((order) => ({
        ...order,
        lines: order.lines.map((line) => ({
          productId: line.productId,
          productName: line.productName,
          quantity: line.quantity,
          sku: line.sku,
          unitPriceMinor: line.unitPriceMinor,
          vatRate: 10,
        })),
      })),
    );
    expect(legacyOrders).toHaveLength(1);
    const legacyLines = legacyOrders[0]?.lines;
    expect(legacyLines?.[0]).toEqual(expect.objectContaining({ quantity: 2, unitPriceMinor: 53_900, vatRate: 10 }));
    expect(legacyLines?.[0]?.taxClassificationCode).toBeUndefined();
    const confirmed = yield* apply(
      { ...placed.state, orders: legacyOrders },
      { _tag: 'ChangeOrderStatus', id: legacyOrders[0]?.id ?? '', status: 'CONFIRMED' },
      'confirm',
      RAISED_TAX,
    );
    expect(confirmed.state.orders[0]?.lines).toEqual(legacyLines);
  }),
);
