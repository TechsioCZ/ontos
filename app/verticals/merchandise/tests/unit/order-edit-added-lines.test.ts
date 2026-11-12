// A line an order edit adds, priced by the server exactly as the editor offered it: the edit carries the offered price,
// the server prices the line as new and stores that price, and it refuses the edit when the price changed between
// picking the product and saving. Covered for a variant, a tiered (first-tier) price, a market order's own currency,
// a price staff typed over and then restored, and a line removed and added again in the same edit.
import { DateTime, Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { MerchandiseCommandSchema, MerchandiseLifecycleConflict } from '../../shared/actions/apply-command.ts';
import type { MerchandiseState } from '../../shared/apis/records.ts';
import { OrderMarketSchema, convertGrossMinor } from '../../shared/domain/market-offers.ts';
import { ProductIdSchema, VariantIdSchema } from '../../shared/domain/merchandise-model.ts';
import { draftOf, editCommandOf } from '../../src/routes/[lang]/prodej/objednavky/order-edit-draft.ts';
import { evolveMerchandiseState } from '../../src/services/persistence.service.ts';
import { TEST_TAX } from '../support/tax-fixtures.ts';

const actor = {
  principalId: '20000000-0000-4000-8000-000000000002',
  tenantId: '20000000-0000-4000-8000-000000000001',
};
const t0 = DateTime.makeUnsafe('2026-11-12T10:00:00Z');
const empty: MerchandiseState = { movements: [], orders: [], products: [] };
const decodeCommand = Schema.decodeUnknownSync(MerchandiseCommandSchema);
type CommandInput = typeof MerchandiseCommandSchema.Encoded;

const apply = (state: MerchandiseState, command: CommandInput, resourceId: string) =>
  evolveMerchandiseState(state, decodeCommand(command), { actor, now: t0, resourceId, tax: TEST_TAX });

const conflictReason = (outcome: Effect.Effect<unknown, unknown>) =>
  outcome.pipe(
    Effect.flip,
    // The refusal carries its own code, so the editor knows the price changed (and not something else).
    Effect.map((failure) =>
      Schema.is(MerchandiseLifecycleConflict)(failure) && failure.code === 'merchandise_offered_price_changed'
        ? failure.reason
        : 'no price-change refusal',
    ),
  );

const orderMarket = Schema.decodeSync(OrderMarketSchema)({
  currency: 'EUR',
  exchangeRate: '0.04',
  marketCode: 'TEST-SK',
  marketId: '30000000-0000-4000-8000-000000000001',
  roundingMinor: 10,
});

/** Twenty pieces received of a product, or of one of its variants. */
const receipt = (productId: string, variantId?: string): CommandInput => {
  const received = { _tag: 'RecordStockMovement', delta: 20, productId, reason: 'RECEIPT' } as const;
  return variantId === undefined ? received : { ...received, variantId };
};

/**
 * Coffee (12 %) with variants 250 g (289 Kč with VAT) and 1 kg (989 Kč), a mug (21 %) whose first tier sells at 150 Kč
 * with VAT, both in stock, and one storefront order (prices with VAT) of two 250 g bags.
 */
const seeded = Effect.gen(function* seed() {
  const coffee = yield* apply(
    empty,
    {
      _tag: 'CreateProduct',
      active: true,
      category: 'Zrnková káva',
      lowStockThreshold: 0,
      name: 'Etiopie',
      priceMinor: 25_804,
      sku: 'ETH',
      taxClassificationCode: 'cz.vat.reduced',
      unit: 'ks',
    },
    'p1',
  );
  const variants = yield* apply(
    coffee.state,
    {
      _tag: 'UpdateProduct',
      id: 'p1',
      patch: {
        variants: [
          { attributes: '250 g', name: '250 g', priceMinor: 25_804, sku: 'ETH-250' },
          { attributes: '1 kg', name: '1 kg', priceMinor: 88_304, sku: 'ETH-1KG' },
        ],
      },
    },
    'u1',
  );
  const mug = yield* apply(
    variants.state,
    {
      _tag: 'CreateProduct',
      active: true,
      category: 'Hrnky',
      lowStockThreshold: 0,
      name: 'Hrnek',
      priceMinor: 10_000,
      sku: 'MUG',
      taxClassificationCode: 'cz.vat.standard',
      unit: 'ks',
    },
    'p2',
  );
  const tiered: MerchandiseState = {
    ...mug.state,
    products: mug.state.products.map((product) =>
      product.id === 'p2'
        ? {
            ...product,
            priceTiers: [
              { minimumQuantity: 1, priceExcludingVatMinor: 12_397, priceMinor: 15_000 },
              { minimumQuantity: 10, priceExcludingVatMinor: 10_744, priceMinor: 13_000 },
            ],
          }
        : product,
    ),
  };
  const small = yield* apply(tiered, receipt('p1', 'u1-v1'), 'stock-1');
  const large = yield* apply(small.state, receipt('p1', 'u1-v2'), 'stock-2');
  const mugs = yield* apply(large.state, receipt('p2'), 'stock-3');
  const stocked = mugs.state;
  const placed = yield* apply(
    stocked,
    {
      _tag: 'PlaceStorefrontOrder',
      clientRequestId: 'client-request-0001',
      contact: { email: 'tereza@example.cz', name: 'Tereza Ukázková' },
      deliveryAddress: { city: 'Brno', postalCode: '602 00', street: 'Ukázková 12' },
      lines: [{ expectedUnitPriceMinor: 28_900, productId: 'p1', quantity: 2, variantId: 'u1-v1' }],
      partyId: 'test-customer-party',
      shippingMethod: 'ZASILKOVNA',
    },
    'order-1',
  );
  return placed.state;
});

type EditLines = NonNullable<Extract<CommandInput, { _tag: 'EditOrder' }>['lines']>;
const orderIdOf = (state: MerchandiseState) => state.orders[0]?.id ?? 'missing';
const existingLine = { productId: 'p1', quantity: 2, variantId: 'u1-v1' } as const;
const linesOf = (state: MerchandiseState) =>
  state.orders[0]?.lines.map((line) => [line.sku, line.unitPriceMinor, line.vatRate]);
const editOf = (state: MerchandiseState, lines: EditLines, resourceId: string) =>
  apply(state, { _tag: 'EditOrder', id: orderIdOf(state), lines }, resourceId);

it.effect('an added variant and an added tiered product keep the price the editor offered', () =>
  Effect.gen(function* added() {
    const state = yield* seeded;
    const edited = yield* editOf(
      state,
      [
        existingLine,
        { offeredUnitPriceMinor: 98_900, productId: 'p1', quantity: 1, variantId: 'u1-v2' },
        { offeredUnitPriceMinor: 15_000, productId: 'p2', quantity: 1 },
      ],
      'edit-1',
    );
    expect(linesOf(edited.state)).toEqual([
      ['ETH-250', 28_900, 12],
      ['ETH-1KG', 98_900, 12],
      ['MUG', 15_000, 21],
    ]);
  }),
);

it.effect('a price that changed between picking and saving refuses the edit instead of storing another price', () =>
  Effect.gen(function* changed() {
    const state = yield* seeded;
    // The 1 kg bag was offered at 989 Kč; someone changed its price before the edit was saved.
    const repriced = yield* apply(
      state,
      { _tag: 'ChangePrice', id: 'p1', priceMinor: 89_196, variantId: 'u1-v2' },
      'reprice',
    );
    expect(
      yield* conflictReason(
        editOf(
          repriced.state,
          [existingLine, { offeredUnitPriceMinor: 98_900, productId: 'p1', quantity: 1, variantId: 'u1-v2' }],
          'edit-2',
        ),
      ),
    ).toContain('Cena produktu ETH-1KG se mezitím změnila');
    // A tiered product is offered at its first tier; another amount is refused the same way.
    expect(
      yield* conflictReason(
        editOf(repriced.state, [existingLine, { offeredUnitPriceMinor: 14_000, productId: 'p2', quantity: 1 }], 'e3'),
      ),
    ).toContain('Cena produktu MUG se mezitím změnila');
    // A price staff typed themselves is theirs: it is stored as typed.
    const typed = yield* editOf(
      repriced.state,
      [
        existingLine,
        { offeredUnitPriceMinor: 98_900, productId: 'p1', quantity: 1, unitPriceMinor: 95_000, variantId: 'u1-v2' },
      ],
      'edit-4',
    );
    expect(linesOf(typed.state)?.[1]).toEqual(['ETH-1KG', 95_000, 12]);
  }),
);

it.effect('a market order prices an added line in its own currency, as the editor offered it', () =>
  Effect.gen(function* market() {
    const state = yield* seeded;
    const inEuro: MerchandiseState = {
      ...state,
      orders: state.orders.map((order) => ({ ...order, market: orderMarket })),
    };
    const offered = convertGrossMinor(15_000, orderMarket);
    const edited = yield* editOf(
      inEuro,
      [existingLine, { offeredUnitPriceMinor: offered, productId: 'p2', quantity: 1 }],
      'edit-5',
    );
    expect(linesOf(edited.state)?.[1]).toEqual(['MUG', offered, 21]);
    // The CZK amount is not the price in this order's currency: refused.
    expect(
      yield* conflictReason(
        editOf(inEuro, [existingLine, { offeredUnitPriceMinor: 15_000, productId: 'p2', quantity: 1 }], 'edit-6'),
      ),
    ).toContain('se mezitím změnila');
  }),
);

it.effect('a price typed over and restored to the offered one is sent and stored as the offered price', () =>
  Effect.gen(function* restored() {
    const state = yield* seeded;
    const order = Option.getOrThrow(Option.fromUndefinedOr(state.orders[0]));
    const base = draftOf(order);
    const picked = {
      key: 'new-1',
      name: 'Hrnek',
      offeredPriceText: '150,00',
      priceText: '140,00',
      productId: Schema.decodeSync(ProductIdSchema)('p2'),
      quantityText: '1',
      sku: 'MUG',
      taxClassificationCode: 'cz.vat.standard',
      vatRate: 21,
    } as const;
    const restoredDraft = { ...base, lines: [...base.lines, { ...picked, priceText: '150' }] };
    const command = Option.getOrThrow(Option.fromNullOr(editCommandOf(order, order.updatedAt, restoredDraft, base)));
    expect(command.lines?.[1]).toEqual({ offeredUnitPriceMinor: 15_000, productId: 'p2', quantity: 1 });
    const edited = yield* evolveMerchandiseState(state, command, {
      actor,
      now: t0,
      resourceId: 'edit-7',
      tax: TEST_TAX,
    });
    expect(linesOf(edited.state)?.[1]).toEqual(['MUG', 15_000, 21]);
  }),
);

it.effect('a line removed and added again in one edit is priced as a new line, as the editor shows it', () =>
  Effect.gen(function* readded() {
    const seededState = yield* seeded;
    // Staff once lowered the 250 g line to 270 Kč by hand.
    const lowered = yield* editOf(seededState, [{ ...existingLine, unitPriceMinor: 27_000 }], 'edit-lowered');
    const order = Option.getOrThrow(Option.fromUndefinedOr(lowered.state.orders[0]));
    const base = draftOf(order);
    // The line is removed and the same variant picked again: the editor shows today's 289 Kč.
    const picked = {
      key: 'new-1',
      name: 'Etiopie',
      offeredPriceText: '289,00',
      priceText: '289,00',
      productId: Schema.decodeSync(ProductIdSchema)('p1'),
      quantityText: '2',
      sku: 'ETH-250',
      taxClassificationCode: 'cz.vat.reduced',
      variantId: Schema.decodeSync(VariantIdSchema)('u1-v1'),
      variantName: '250 g',
      vatRate: 12,
    } as const;
    const command = Option.getOrThrow(
      Option.fromNullOr(editCommandOf(order, order.updatedAt, { ...base, lines: [picked] }, base)),
    );
    const edited = yield* evolveMerchandiseState(lowered.state, command, {
      actor,
      now: t0,
      resourceId: 'edit-readded',
      tax: TEST_TAX,
    });
    expect(linesOf(edited.state)).toEqual([['ETH-250', 28_900, 12]]);
  }),
);

it.effect('a line added back with the same quantity and price still takes the VAT the editor showed', () =>
  Effect.gen(function* sameWords() {
    const seededState = yield* seeded;
    // The 250 g line was snapshotted before the reduced rate was 12 %: it carries 10 % and no classification.
    const older: MerchandiseState = {
      ...seededState,
      orders: seededState.orders.map((order) => ({
        ...order,
        lines: order.lines.map(({ taxClassificationCode: _code, taxRuleRevisionId: _rule, ...line }) => ({
          ...line,
          vatRate: 10,
        })),
      })),
    };
    // Removed and picked again at the same 289 Kč and quantity: priced as a new line, at today's 12 %.
    const edited = yield* editOf(older, [{ ...existingLine, offeredUnitPriceMinor: 28_900 }], 'edit-same-words');
    const [line] = edited.state.orders[0]?.lines ?? [];
    expect([line?.unitPriceMinor, line?.vatRate, line?.taxClassificationCode]).toEqual([28_900, 12, 'cz.vat.reduced']);
    expect(edited.state.orders[0]?.history?.at(-1)?.after).toContain('DPH 12 %');
  }),
);
