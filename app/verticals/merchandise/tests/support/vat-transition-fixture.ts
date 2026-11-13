// What the VAT transition fixture (`../fixtures/vat-transition-pre-migration.json`) is compared on: the storefront
// requests its answers were recorded for by the release before classifications
// (`scripts/integration/tests/vat-fixture.old-release.mts`), and the checks every consumer runs on the answers.
import { Schema } from 'effect';
import { expect } from 'effect-rstest';

import type { RecordsRequestEncoded } from '../../shared/apis/records.ts';

const MARKET_ID = '5f2d6c1e-7a3b-4c8d-9e0f-1a2b3c4d5e6f';
const STOREFRONT = { storefront: true } as const;

/** Every storefront request the fixture's `before` and `after` answers were recorded for. */
export const VAT_TRANSITION_VIEWS = {
  cards: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'card' } } },
  cart: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'full', productIds: ['book-it', 'p-reduced', 'p2'] } } },
  category: { view: { ...STOREFRONT, storefrontCatalog: { categorySlug: 'metricke', fields: 'card' } } },
  detailBookIt: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'full', slug: 'book-it' } } },
  detailInformational: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'full', slug: 'tricko-barvy' } } },
  detailJacket: {
    view: { ...STOREFRONT, storefrontCatalog: { fields: 'full', slug: 'panska-bunda-spyder-vyper-jacket-cerna' } },
  },
  detailOddVariant: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'full', slug: 'odd-variant' } } },
  detailReduced: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'full', slug: 'kava-zrnkova' } } },
  featured: { view: { ...STOREFRONT, storefrontCatalog: { featured: true, fields: 'card' } } },
  legacyList: { view: { ...STOREFRONT, limit: 250, summary: true } },
  marketCards: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'card', marketId: MARKET_ID } } },
  marketDetail: {
    view: { ...STOREFRONT, storefrontCatalog: { fields: 'full', marketId: MARKET_ID, slug: 'book-it' } },
  },
  priceAscending: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'card', sort: 'price-asc' } } },
  priceBounds: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'card', maxMinor: 60_000, minMinor: 100 } } },
  search: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'card', q: 'sroub' } } },
  searchJacket: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'card', q: 'spyder' } } },
} satisfies Readonly<Record<string, RecordsRequestEncoded>>;

const JsonRecordSchema = Schema.Record(Schema.String, Schema.Json);

/** A response with BOOK-IT at the rate Tax gives the reduced classification; every price stays as it was. */
export const withBookItAt = (value: Schema.Json, vatRate: number): Schema.Json => {
  if (Array.isArray(value)) {
    return value.map((item: Schema.Json) => withBookItAt(item, vatRate));
  }
  if (!Schema.is(JsonRecordSchema)(value)) {
    return value;
  }
  const mapped = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withBookItAt(item, vatRate)]));
  return mapped.id === 'book-it' && 'vatRate' in mapped ? { ...mapped, vatRate } : mapped;
};

/**
 * N1's jacket 38SA073510-BLK as stage holds it: a mistyped product net (18 780,00 Kč, which plus 21 % would be
 * 22 723,80) and five real untiered variants at 8 780,00 / 10 623,80 Kč. Both releases sell it at its variants' price.
 */
export const JACKET_GROSS = 1_062_380;
/** The product with stage's two informational variants (no id, no price) sells at its own price, 412,40 + 21 %. */
export const INFORMATIONAL_GROSS = 49_900;

const grossesOf = (value: Schema.Json, key = ''): readonly number[] => {
  if (Schema.is(Schema.Finite)(value)) {
    return /gross/iu.test(key) ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item: Schema.Json) => grossesOf(item, key));
  }
  return Schema.is(JsonRecordSchema)(value)
    ? Object.entries(value).flatMap(([name, item]) => grossesOf(item, name))
    : [];
};

/**
 * No gross price in any answer is the jacket's mistyped net or its recomputation ("from 22 723,80" or 18 780), every
 * gross price its detail and its search row show is 10 623,80, and the product with informational variants shows its
 * own price.
 */
export const expectJacketAtVariantPrice = (responses: Readonly<Record<string, Schema.Json>>) => {
  const everyGross = Object.values(responses).flatMap((response) => grossesOf(response));
  expect(everyGross.filter((gross) => gross === 1_878_000 || gross === 2_272_380)).toEqual([]);
  for (const [view, gross] of [
    ['detailJacket', JACKET_GROSS],
    ['searchJacket', JACKET_GROSS],
    ['detailInformational', INFORMATIONAL_GROSS],
  ] as const) {
    const shown = grossesOf(responses[view] ?? null);
    expect([view, shown.length > 0, shown.filter((entry) => entry !== gross)]).toEqual([view, true, []]);
  }
};
