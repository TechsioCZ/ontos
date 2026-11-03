import { Effect } from "effect";
import { describe, expect, it } from "effect-rstest";
import {
  addCartEntry,
  CartDraftInvalid,
  cartStorageKey,
  decodeStoredCart,
  replaceCartQuantity,
} from "../src/features/cart-state";

const scope = {
  currency: "CZK" as const,
  legalEntityId: "71000000-0000-4000-8000-000000000002",
  marketId: "n1-cz",
  tenantId: "71000000-0000-4000-8000-000000000001",
};
const entry = {
  expectedUnitPriceMinor: 12_100,
  image: null,
  name: "Product",
  productId: "p1",
  quantity: 2,
  sku: "SKU1",
  slug: "product",
  unit: "ks",
  variantId: "v1",
  variantName: "Large",
};
describe("N1 scoped local cart", () => {
  it.effect("rejects two individually valid additions that exceed the owner aggregate limit", () =>
    Effect.gen(function* aggregateLimit() {
      const failure = yield* Effect.flip(
        addCartEntry([{ ...entry, quantity: 1_000_000 }], { ...entry, quantity: 1_000_000 }),
      );
      expect(failure).toBeInstanceOf(CartDraftInvalid);
    }),
  );
  it("separates sellers, tenants, markets and currencies", () => {
    const keys = [
      scope,
      { ...scope, tenantId: "other" },
      { ...scope, legalEntityId: "other" },
      { ...scope, marketId: "other" },
      { ...scope, currency: "EUR" as const },
    ].map(cartStorageKey);
    expect(new Set(keys).size).toBe(5);
  });
  it.effect("restores the matching draft without confirming its prices", () =>
    Effect.gen(function* restoreDraft() {
      const cart = yield* decodeStoredCart(
        JSON.stringify({ entries: [entry], scope, version: 1 }),
        scope,
      );
      expect(cart.entries).toEqual([entry]);
      expect(cart).not.toHaveProperty("quote");
      expect(cart).not.toHaveProperty("totals");
    }),
  );
  it.effect("rejects foreign market storage and duplicated variant pairs", () =>
    Effect.gen(function* foreignStorage() {
      for (const value of [
        { entries: [entry], scope: { ...scope, marketId: "other" }, version: 1 },
        { entries: [entry, entry], scope, version: 1 },
        { entries: [{ ...entry, quantity: 0 }], scope, version: 1 },
        { entries: [{ ...entry, expectedUnitPriceMinor: 0 }], scope, version: 1 },
      ]) {
        const failure = yield* Effect.flip(decodeStoredCart(JSON.stringify(value), scope));
        expect(failure).toBeInstanceOf(CartDraftInvalid);
      }
    }),
  );
  it.effect("does not treat malformed saved data as an empty cart", () =>
    Effect.gen(function* malformedStorage() {
      const failure = yield* Effect.flip(decodeStoredCart("not json", scope));
      expect(failure).toBeInstanceOf(CartDraftInvalid);
    }),
  );
  it.effect(
    "merges only the same product and variant with the latest displayed expected price",
    () =>
      Effect.gen(function* mergeEntry() {
        const entries = yield* addCartEntry([entry], {
          ...entry,
          expectedUnitPriceMinor: 13_000,
          quantity: 3,
        });
        expect(entries[0]?.quantity).toBe(5);
        expect(entries[0]?.expectedUnitPriceMinor).toBe(13_000);
        const different = yield* addCartEntry(entries, { ...entry, variantId: "v2" });
        expect(different).toHaveLength(2);
      }),
  );
  it.effect(
    "rejects overflowing or invalid additions and quantities without mutating the original",
    () =>
      Effect.gen(function* invalidQuantity() {
        const failure = yield* Effect.flip(
          addCartEntry([{ ...entry, quantity: 1_000_000_000 }], entry),
        );
        expect(failure).toBeInstanceOf(CartDraftInvalid);
        const invalid = yield* Effect.flip(replaceCartQuantity([entry], entry, Number.NaN));
        expect(invalid).toBeInstanceOf(CartDraftInvalid);
        expect(entry.quantity).toBe(2);
      }),
  );
  it.effect("updates one exact selection and retains unrelated variants", () =>
    Effect.gen(function* updateQuantity() {
      const entries = [entry, { ...entry, variantId: "v2" }];
      const updated = yield* replaceCartQuantity(entries, entry, 4);
      expect(updated.map((line) => line.quantity)).toEqual([4, 2]);
    }),
  );
});
