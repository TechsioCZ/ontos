// The one stock rule, decided by the owner: a unit is in stock only when its stock covers its first orderable quantity
// (its minimum rounded up to whole packages). Stock below that is held, not sold (OUT_OF_STOCK, which the storefront
// words „Skladem 6 ks, prodej po 10 ks“); untracked stock is UNKNOWN; a variant group is as available as its best
// sellable variant, never by adding variants' partial packages together.
import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { MerchandiseStateSchema } from '../../shared/apis/records.ts';
import { firstOrderableQuantity } from '../../shared/domain/order-quantity.ts';
import { availabilityOf, stockLevelsOf, toProductRecord } from '../../src/services/stock-levels.ts';
import { TEST_RATES } from '../support/tax-fixtures.ts';

const at = '2026-11-27T08:00:00.000Z';
const decodeState = Schema.decodeUnknownSync(MerchandiseStateSchema);

interface Unit {
  readonly minimumQuantity?: number;
  readonly packageQuantity?: number;
}
interface SimpleUnit extends Unit {
  readonly lowStockThreshold?: number;
  readonly stockTracked?: boolean;
}
interface VariantCase extends Unit {
  readonly active?: boolean;
  readonly id: string;
  readonly stock: number;
}
interface ProductExtra extends SimpleUnit {
  readonly variants?: readonly (Unit & {
    readonly active: boolean;
    readonly attributes: string;
    readonly id: string;
    readonly name: string;
    readonly priceMinor: number;
    readonly sku: string;
  })[];
}

const receipt = (delta: number, variantId?: string) => {
  const movement = {
    at,
    delta,
    id: `receipt-${variantId ?? 'product'}`,
    productId: 'desticky',
    reason: 'RECEIPT' as const,
  };
  return variantId === undefined ? movement : { ...movement, variantId };
};

const product = (extra: ProductExtra) => ({
  active: true,
  category: 'Spojovací materiál',
  createdAt: at,
  currentPriceMinor: 4959,
  id: 'desticky',
  lowStockThreshold: 0,
  name: 'Destičky kulaté s okem',
  priceHistory: [],
  sku: '10835300',
  taxClassificationCode: 'cz.vat.standard' as const,
  unit: 'ks' as const,
  updatedAt: at,
  ...extra,
});

/** The derived record of the one product of `state`, as the store keeps it. */
const recordOf = (state: typeof MerchandiseStateSchema.Encoded) => {
  const decoded = decodeState(state);
  const [only] = decoded.products;
  if (only === undefined) {
    return expect.unreachable('The product fixture must decode');
  }
  return toProductRecord(only, stockLevelsOf(decoded.movements, only.id), TEST_RATES, {});
};

/** One product without variants holding `stock`. */
const simpleRecord = (stock: number, unit: SimpleUnit) =>
  recordOf({ movements: stock === 0 ? [] : [receipt(stock)], orders: [], products: [product(unit)] });

/** One variant group, each variant holding its own stock. */
const groupRecord = (variants: readonly VariantCase[]) =>
  recordOf({
    movements: variants.filter(({ stock }) => stock !== 0).map(({ id, stock }) => receipt(stock, id)),
    orders: [],
    products: [
      product({
        variants: variants.map(({ active, stock: _stock, ...unit }) => ({
          active: active ?? true,
          attributes: '',
          name: unit.id,
          priceMinor: 4959,
          sku: `10835300-${unit.id}`,
          ...unit,
        })),
      }),
    ],
  });

it('rounds the first order up to whole packages: minimum 1 or 3 in packages of 10 is 10, no package is the minimum', () => {
  expect(firstOrderableQuantity({ minimumQuantity: 1, packageQuantity: 10 })).toBe(10);
  expect(firstOrderableQuantity({ minimumQuantity: 3, packageQuantity: 10 })).toBe(10);
  expect(firstOrderableQuantity({ minimumQuantity: 12, packageQuantity: 10 })).toBe(20);
  expect(firstOrderableQuantity({})).toBe(1);
  expect(firstOrderableQuantity({ minimumQuantity: 0.5 })).toBe(0.5);
  // A cleared package (stored 0) is no package.
  expect(firstOrderableQuantity({ minimumQuantity: 3, packageQuantity: 0 })).toBe(3);
});

for (const { availability, name, stock, unit } of [
  {
    availability: 'OUT_OF_STOCK',
    name: 'package 10 with stock 6 is held, not sold',
    stock: 6,
    unit: { packageQuantity: 10 },
  },
  {
    availability: 'IN_STOCK',
    name: 'package 10 with stock 10 covers one first order',
    stock: 10,
    unit: { packageQuantity: 10 },
  },
  { availability: 'IN_STOCK', name: 'package 10 with stock 16 is in stock', stock: 16, unit: { packageQuantity: 10 } },
  {
    availability: 'OUT_OF_STOCK',
    name: 'minimum 3 in packages of 10 with stock 6 is held, not sold',
    stock: 6,
    unit: { minimumQuantity: 3, packageQuantity: 10 },
  },
  {
    availability: 'IN_STOCK',
    name: 'no package, minimum 1, stock 1 is in stock',
    stock: 1,
    unit: { minimumQuantity: 1 },
  },
  { availability: 'OUT_OF_STOCK', name: 'no package, stock 0.5 is below one piece', stock: 0.5, unit: {} },
  { availability: 'OUT_OF_STOCK', name: 'no stock is not in stock', stock: 0, unit: { packageQuantity: 10 } },
] as const) {
  it(`a product without variants: ${name}`, () => {
    const record = simpleRecord(stock, unit);
    expect(record.availability).toBe(availability);
    expect(record.stockOnHand).toBe(stock);
  });
}

it('stock 10 in packages of 10 is LOW_STOCK at a low-stock threshold of 10, IN_STOCK above it', () => {
  expect(simpleRecord(10, { lowStockThreshold: 10, packageQuantity: 10 }).availability).toBe('LOW_STOCK');
  expect(simpleRecord(16, { lowStockThreshold: 10, packageQuantity: 10 }).availability).toBe('IN_STOCK');
  expect(simpleRecord(6, { lowStockThreshold: 10, packageQuantity: 10 }).availability).toBe('OUT_OF_STOCK');
});

it('untracked stock is UNKNOWN whatever is held, and an inactive unit is never sold', () => {
  expect(simpleRecord(16, { packageQuantity: 10, stockTracked: false }).availability).toBe('UNKNOWN');
  expect(simpleRecord(0, { stockTracked: false }).availability).toBe('UNKNOWN');
  expect(availabilityOf({ active: false, firstOrderable: 1, stock: 16, stockTracked: true, threshold: 0 })).toBe(
    'OUT_OF_STOCK',
  );
});

it('judges each variant by its own first order; the group is in stock when one sellable variant is', () => {
  const mixed = groupRecord([
    { id: 'a', packageQuantity: 10, stock: 6 },
    { id: 'b', packageQuantity: 1, stock: 5 },
  ]);
  expect(mixed.variantRecords?.map(({ availability, id }) => [id, availability])).toEqual([
    ['a', 'OUT_OF_STOCK'],
    ['b', 'IN_STOCK'],
  ]);
  expect(mixed.availability).toBe('IN_STOCK');
  expect(groupRecord([{ id: 'a', packageQuantity: 10, stock: 6 }]).availability).toBe('OUT_OF_STOCK');
});

it('never adds partial packages of several variants together, and an inactive variant does not sell the group', () => {
  const twoBelow = groupRecord([
    { id: 'a', packageQuantity: 10, stock: 6 },
    { id: 'c', packageQuantity: 10, stock: 6 },
  ]);
  expect(twoBelow.stockOnHand).toBe(12);
  expect(twoBelow.availability).toBe('OUT_OF_STOCK');
  const inactive = groupRecord([
    { id: 'a', packageQuantity: 10, stock: 6 },
    { active: false, id: 'd', packageQuantity: 1, stock: 50 },
  ]);
  expect(inactive.availability).toBe('OUT_OF_STOCK');
});
