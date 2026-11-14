// The price below the first quantity break is decided once (`shared/domain/unit-price.ts`): the record the storefront
// shows and the owner checkout use the same function, so a shopper is charged exactly the price shown, or the unit is
// shown and refused as having no price. Each tier pricing runs on a product without variants and on a variant.
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { MerchandiseCommandSchema } from '../../shared/actions/apply-command.ts';
import type { MerchandiseState } from '../../shared/apis/records.ts';
import type { Product, ProductVariant } from '../../shared/domain/merchandise-model.ts';
import { baseGrossOf, grossForQuantity, shownGrossOf } from '../../shared/domain/unit-price.ts';
import { evolveMerchandiseState } from '../../src/services/persistence.service.ts';
import type { CommandTax } from '../../src/services/persistence.service.ts';
import { stockLevelsOf, toProductRecord } from '../../src/services/stock-levels.ts';
import { TEST_TAX } from '../support/tax-fixtures.ts';

const actor = {
  principalId: '20000000-0000-4000-8000-000000000002',
  tenantId: '20000000-0000-4000-8000-000000000001',
};
const t0 = DateTime.makeUnsafe('2026-11-14T10:00:00Z');
const decodeCommand = Schema.decodeUnknownSync(MerchandiseCommandSchema);
type CommandInput = typeof MerchandiseCommandSchema.Encoded;

const apply = (state: MerchandiseState, command: CommandInput, resourceId: string, tax: CommandTax = TEST_TAX) =>
  evolveMerchandiseState(state, decodeCommand(command), { actor, now: t0, resourceId, tax });

type Tiers = NonNullable<Product['priceTiers']>;

/** Net 1000 at 21 % is 1210; a discount break at net 900 is 1089; a surcharge at net 1100 is 1331. */
const BASE = { minimumQuantity: 1, priceExcludingVatMinor: 1000, priceMinor: 1210 };
const DISCOUNT = { minimumQuantity: 10, priceExcludingVatMinor: 900, priceMinor: 1089 };
const SURCHARGE = { minimumQuantity: 1, priceExcludingVatMinor: 1100, priceMinor: 1331 };

interface Pricing {
  /** A gross entered with the net price, when the unit has one. */
  readonly gross?: number;
  readonly minimum: number;
  readonly name: string;
  readonly tiers: Tiers;
}

const PRICINGS: readonly Pricing[] = [
  { minimum: 0.5, name: 'AKROS base tier only', tiers: [BASE] },
  { minimum: 0.5, name: 'base tier and a real discount', tiers: [BASE, DISCOUNT] },
  { gross: 1210, minimum: 1, name: 'stored base and a discount first tier', tiers: [DISCOUNT] },
  { minimum: 1, name: 'discount only, no base', tiers: [DISCOUNT] },
  { minimum: 0.5, name: 'surcharge first tier', tiers: [SURCHARGE] },
  {
    minimum: 0.5,
    name: 'tier at the net price that is not the lowest',
    tiers: [SURCHARGE, { ...BASE, minimumQuantity: 10 }],
  },
  { minimum: 0.5, name: 'tiers stored out of order', tiers: [DISCOUNT, BASE] },
];

/** The unit priced as `pricing` says: its own gross (if any), minimum and tiers on top of the stored unit. */
const priced = <Unit extends { readonly grossPriceMinor?: number }>(
  { grossPriceMinor: _entered, ...unit }: Unit,
  pricing: Pricing,
): Omit<Unit, 'grossPriceMinor'> & Pick<Product, 'minimumQuantity' | 'priceTiers'> & { grossPriceMinor?: number } => {
  void _entered;
  const tiered = { ...unit, minimumQuantity: pricing.minimum, priceTiers: pricing.tiers };
  return pricing.gross === undefined ? tiered : { ...tiered, grossPriceMinor: pricing.gross };
};

/** One unit (net 1000, standard rate) with 100 in stock, priced by `pricing`, as a product or as its only variant. */
const unitState = (pricing: Pricing, variant: boolean) =>
  Effect.gen(function* unitOf() {
    const created = yield* apply(
      { movements: [], orders: [], products: [] },
      {
        _tag: 'CreateProduct',
        active: true,
        category: 'Šrouby',
        lowStockThreshold: 0,
        name: 'Šroub',
        priceMinor: 1000,
        sku: 'SROUB',
        taxClassificationCode: 'cz.vat.standard',
        unit: 'ks',
      },
      'unit',
    );
    const withVariant = variant
      ? yield* apply(
          created.state,
          {
            _tag: 'UpdateProduct',
            id: 'unit',
            patch: { variants: [{ attributes: '', name: 'M8', priceMinor: 1000, sku: 'SROUB-M8' }] },
          },
          'variants',
        )
      : created;
    const receipt = { _tag: 'RecordStockMovement', delta: 100, productId: 'unit', reason: 'RECEIPT' } as const;
    const stocked = yield* apply(
      withVariant.state,
      variant ? { ...receipt, variantId: 'variants-v1' } : receipt,
      'receipt',
    );
    const applyPricing = (product: Product): Product =>
      variant
        ? { ...product, variants: (product.variants ?? []).map((entry): ProductVariant => priced(entry, pricing)) }
        : priced(product, pricing);
    return { ...stocked.state, products: stocked.state.products.map(applyPricing) };
  });

/** What the unit's record shows, as the storefront reads it. */
const shownOf = (state: MerchandiseState, variant: boolean, tax: CommandTax = TEST_TAX) => {
  const [product] = state.products;
  if (product === undefined) {
    return null;
  }
  const record = toProductRecord(product, stockLevelsOf(state.movements, product.id), tax.rates, tax.held);
  return (variant ? record.variantRecords?.[0]?.grossPriceMinor : record.grossPriceMinor) ?? null;
};

/** A storefront order of `quantity` at the price the shopper was shown; its outcome and the price charged. */
const checkout = (
  state: MerchandiseState,
  variant: boolean,
  quantity: number,
  expected: number,
  tax: CommandTax = TEST_TAX,
) =>
  apply(
    state,
    {
      _tag: 'PlaceStorefrontOrder',
      clientRequestId: `parity-${String(quantity)}`,
      contact: { email: 'tereza@example.cz', name: 'Tereza Ukázková' },
      deliveryAddress: { city: 'Brno', postalCode: '602 00', street: 'Ukázková 12' },
      lines: [
        variant
          ? { expectedUnitPriceMinor: expected, productId: 'unit', quantity, variantId: 'variants-v1' }
          : { expectedUnitPriceMinor: expected, productId: 'unit', quantity },
      ],
      partyId: 'test-customer-party',
      shippingMethod: 'ZASILKOVNA',
    },
    `order-${String(quantity)}`,
    tax,
  ).pipe(
    Effect.map((result) => ({
      charged: result.state.orders[0]?.lines[0]?.unitPriceMinor ?? null,
      issue: result.storefrontOrder?.issues[0]?.code ?? null,
      outcome: result.storefrontOrder?.outcome ?? null,
    })),
  );

it.effect('the record shows exactly what checkout charges at the minimum, or neither has a price', () =>
  Effect.gen(function* parity() {
    for (const pricing of PRICINGS) {
      for (const variant of [false, true]) {
        const state = yield* unitState(pricing, variant);
        const shown = shownOf(state, variant);
        const placed = yield* checkout(state, variant, pricing.minimum, shown ?? 1);
        const label = `${pricing.name} (${variant ? 'variant' : 'product'})`;
        expect([label, placed]).toEqual([
          label,
          shown === null
            ? { charged: null, issue: 'PRICE_UNAVAILABLE', outcome: 'REJECTED' }
            : { charged: shown, issue: null, outcome: 'PLACED' },
        ]);
      }
    }
  }),
);

it.effect('below, at and just under a break each quantity is charged as the price function says', () =>
  Effect.gen(function* breaks() {
    const cases: readonly (readonly [Pricing | undefined, number, number | null])[] = [
      [PRICINGS[0], 0.5, 1210],
      [PRICINGS[0], 1, 1210],
      [PRICINGS[1], 0.5, 1210],
      [PRICINGS[1], 9.99, 1210],
      [PRICINGS[1], 10, 1089],
      [PRICINGS[2], 1, 1210],
      [PRICINGS[2], 9.99, 1210],
      [PRICINGS[2], 10, 1089],
      // No base gross and a real discount: nothing below the break, the discount from it.
      [PRICINGS[3], 9.99, null],
      [PRICINGS[3], 10, 1089],
      [PRICINGS[4], 0.5, null],
      [PRICINGS[5], 0.5, null],
      [PRICINGS[6], 0.5, 1210],
      [PRICINGS[6], 10, 1089],
    ];
    for (const [pricing, quantity, price] of cases) {
      if (pricing === undefined) {
        return yield* Effect.die('Every case names a pricing');
      }
      for (const variant of [false, true]) {
        const state = yield* unitState(pricing, variant);
        const placed = yield* checkout(state, variant, quantity, price ?? 1);
        const label = `${pricing.name} × ${String(quantity)} (${variant ? 'variant' : 'product'})`;
        expect([label, placed.charged ?? placed.issue]).toEqual([label, price ?? 'PRICE_UNAVAILABLE']);
      }
    }
    return yield* Effect.void;
  }),
);

it("a base tier is accepted only at the unit's own net and the rate it sells at, and never at a net of 0", () => {
  const akros = { minimumQuantity: 0.5, priceTiers: [BASE] };
  expect(baseGrossOf(akros, 1000, 21)).toBe(1210);
  // Sold at 12 % (or held at 10 %), a tier gross that embeds 21 % is no base price.
  expect(baseGrossOf(akros, 1000, 12)).toBeUndefined();
  expect(baseGrossOf({ priceTiers: [{ ...BASE, priceMinor: 1100 }] }, 1000, 10)).toBe(1100);
  expect(baseGrossOf({ priceTiers: [{ ...BASE, priceExcludingVatMinor: 0, priceMinor: 0 }] }, 0, 21)).toBeUndefined();
  // A classification Tax has no rule for has no rate: no base price either.
  expect(baseGrossOf(akros, 1000, new Map<string, number>().get('cz.vat.none'))).toBeUndefined();
  // A tier 1 haléř off the rounding is never a base below it, yet a minimum at that tier is simply charged the tier.
  const offByOne = {
    minimumQuantity: 10,
    priceTiers: [{ minimumQuantity: 1, priceExcludingVatMinor: 15, priceMinor: 19 }],
  };
  expect(baseGrossOf(offByOne, 15, 21)).toBeUndefined();
  expect(shownGrossOf(offByOne, 15, 21)).toBe(19);
  expect(grossForQuantity(offByOne, 15, 21, 10)).toBe(19);
});

it.effect('a held reduced unit takes its tier as base only when the tier is at the held rate', () =>
  Effect.gen(function* heldBase() {
    const held: CommandTax = { ...TEST_TAX, held: { unit: 10 } };
    for (const [gross, price] of [
      [1100, 1100],
      [1210, null],
    ] as const) {
      const pricing: Pricing = { minimum: 0.5, name: 'held', tiers: [{ ...BASE, priceMinor: gross }] };
      const state = yield* unitState(pricing, false);
      const reduced = {
        ...state,
        products: state.products.map((product): Product => ({ ...product, taxClassificationCode: 'cz.vat.reduced' })),
      };
      expect(shownOf(reduced, false, held)).toBe(price);
      const placed = yield* checkout(reduced, false, 0.5, price ?? 1, held);
      expect(placed.charged ?? placed.issue).toBe(price ?? 'PRICE_UNAVAILABLE');
    }
  }),
);

it.effect('a price change keeps a base-tier unit sellable at 0,5 at the new base price', () =>
  Effect.gen(function* repricedBaseTier() {
    for (const variant of [false, true]) {
      const state = yield* unitState({ minimum: 0.5, name: 'AKROS', tiers: [BASE] }, variant);
      const change = { _tag: 'ChangePrice', id: 'unit', priceMinor: 2000 } as const;
      const repriced = yield* apply(state, variant ? { ...change, variantId: 'variants-v1' } : change, 'reprice');
      expect(shownOf(repriced.state, variant)).toBe(2420);
      const placed = yield* checkout(repriced.state, variant, 0.5, 2420);
      expect(placed).toEqual({ charged: 2420, issue: null, outcome: 'PLACED' });
    }
  }),
);
