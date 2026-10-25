import { expect, it } from 'effect-rstest';
import { Effect, Exit } from 'effect';
import { verifySnapshot } from '../../scripts/verify-db-schema.mts';

const empty = { categories: [], heads: [], movements: [], orders: [], products: [], tiers: [], variants: [] };
const catalog = { ...empty, heads: [{ revision: 0 }], products: [{ id: 'product-1' }] };
it.effect('accepts empty migration readiness but requires products for explicit seeded acceptance', () =>
  Effect.gen(function* verifyPredicate() {
    expect(Exit.isSuccess(yield* Effect.exit(verifySnapshot(empty, false)))).toBe(true);
    expect(Exit.isFailure(yield* Effect.exit(verifySnapshot(empty, true)))).toBe(true);
    expect(Exit.isSuccess(yield* Effect.exit(verifySnapshot(catalog, true)))).toBe(true);
    expect(Exit.isSuccess(yield* Effect.exit(verifySnapshot({ ...empty, heads: [{ revision: 0 }] }, false)))).toBe(
      true,
    );
    expect(Exit.isFailure(yield* Effect.exit(verifySnapshot({ ...empty, heads: [{ revision: 0 }] }, true)))).toBe(true);
  }),
);
it.effect('rejects existing rows without a head, duplicate heads and negative revisions', () =>
  Effect.gen(function* verifyPredicate() {
    for (const invalid of [
      { ...catalog, heads: [] },
      { ...catalog, heads: [{ revision: 0 }, { revision: 1 }] },
      { ...catalog, heads: [{ revision: -1 }] },
      { ...empty, categories: [{ id: 'orphan-category' }] },
    ]) {
      expect(Exit.isFailure(yield* Effect.exit(verifySnapshot(invalid, false)))).toBe(true);
    }
  }),
);
it.effect('validates product references even when seed presence is optional', () =>
  Effect.gen(function* verifyPredicate() {
    const movement = { productId: 'product-1' };
    expect(Exit.isSuccess(yield* Effect.exit(verifySnapshot({ ...catalog, movements: [movement] }, false)))).toBe(true);
    for (const relation of ['movements', 'variants', 'tiers'] as const) {
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            verifySnapshot(
              {
                ...catalog,
                [relation]: [{ productId: 'missing-product' }],
              },
              false,
            ),
          ),
        ),
      ).toBe(true);
    }
  }),
);
it.effect('does not silently accept malformed existing orders', () =>
  Effect.gen(function* verifyPredicate() {
    expect(Exit.isFailure(yield* Effect.exit(verifySnapshot({ ...catalog, orders: [{ document: {} }] }, false)))).toBe(
      true,
    );
  }),
);

it.effect('retains order-line product validation for valid persisted documents', () =>
  Effect.gen(function* verifyOrderReferences() {
    const line = {
      productId: 'product-1',
      productName: 'Product',
      quantity: 1,
      sku: 'SKU-1',
      unitPriceMinor: 100,
      vatRate: 21,
    };
    const document = {
      createdAt: '2026-10-20T08:00:00.000Z',
      id: 'order-1',
      lines: [line],
      number: 'ORDER-1',
      partyId: 'party-1',
      status: 'NEW',
      totalMinor: 121,
      totalVatMinor: 21,
      updatedAt: '2026-10-20T08:00:00.000Z',
    };
    expect(Exit.isSuccess(yield* Effect.exit(verifySnapshot({ ...catalog, orders: [{ document }] }, false)))).toBe(
      true,
    );
    const danglingOrder = { document: { ...document, lines: [{ ...line, productId: 'missing-product' }] } };
    expect(Exit.isFailure(yield* Effect.exit(verifySnapshot({ ...catalog, orders: [danglingOrder] }, false)))).toBe(
      true,
    );
  }),
);
