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
  it.effect("clears a stale package only after a fresh owner absence snapshot", () =>
    Effect.gen(function* removedPackageRule() {
      const previous = { ...entry, packageQuantity: 2 };
      const fresh = { ...entry, minimumQuantity: 1, packageQuantity: null, quantity: 1 };
      const entries = yield* addCartEntry([previous], fresh);
      expect(entries[0]).toMatchObject({ packageQuantity: null, quantity: 3 });
      const restored = yield* decodeStoredCart(
        JSON.stringify({ entries, scope, version: 1 }),
        scope,
      );
      expect(restored.entries[0]?.packageQuantity).toBeNull();
      const updated = yield* replaceCartQuantity(restored.entries, fresh, 5);
      expect(updated[0]?.quantity).toBe(5);
    }),
  );
  it.effect("preserves package rules through persistence, updates and legacy additions", () =>
    Effect.gen(function* packageSnapshot() {
      const selected = { ...entry, minimumQuantity: 3, packageQuantity: 2, quantity: 4 };
      const entries = yield* addCartEntry([], selected);
      expect(entries[0]).toEqual(selected);
      const restored = yield* decodeStoredCart(
        JSON.stringify({ entries, scope, version: 1 }),
        scope,
      );
      expect(restored.entries[0]).toEqual(selected);
      const failure = yield* Effect.flip(replaceCartQuantity(restored.entries, selected, 5));
      expect(failure).toBeInstanceOf(CartDraftInvalid);
      const updated = yield* replaceCartQuantity(restored.entries, selected, 6);
      expect(updated[0]?.quantity).toBe(6);
      const legacyAddition = yield* addCartEntry(updated, entry);
      expect(legacyAddition[0]).toMatchObject({ packageQuantity: 2, quantity: 8 });
      expect(updated[0]?.quantity).toBe(6);
    }),
  );
  it.effect("rejects an aggregate that violates the latest package without rounding", () =>
    Effect.gen(function* changedPackage() {
      const previous = { ...entry, quantity: 3 };
      const failure = yield* Effect.flip(
        addCartEntry([previous], { ...entry, packageQuantity: 2 }),
      );
      expect(failure).toBeInstanceOf(CartDraftInvalid);
      expect(previous.quantity).toBe(3);
    }),
  );
  it.effect(
    "rejects malformed or invalid stored package snapshots without guessing a replacement",
    () =>
      Effect.gen(function* invalidPackageSnapshot() {
        for (const packageQuantity of ["2", 3]) {
          const failure = yield* Effect.flip(
            decodeStoredCart(
              JSON.stringify({ entries: [{ ...entry, packageQuantity }], scope, version: 1 }),
              scope,
            ),
          );
          expect(failure).toBeInstanceOf(CartDraftInvalid);
        }
        for (const packageQuantity of [Number.NaN, Number.POSITIVE_INFINITY]) {
          const failure = yield* Effect.flip(addCartEntry([], { ...entry, packageQuantity }));
          expect(failure).toBeInstanceOf(CartDraftInvalid);
        }
        const legacy = yield* decodeStoredCart(
          JSON.stringify({ entries: [entry], scope, version: 1 }),
          scope,
        );
        expect(legacy.entries[0]).not.toHaveProperty("packageQuantity");
      }),
  );
  it.effect("retains the selected minimum through persistence and rejects smaller quantities", () =>
    Effect.gen(function* minimumSnapshot() {
      const selected = { ...entry, minimumQuantity: 1, quantity: 1 };
      const entries = yield* addCartEntry([], selected);
      const restored = yield* decodeStoredCart(
        JSON.stringify({ entries, scope, version: 1 }),
        scope,
      );
      expect(restored.entries).toEqual([selected]);
      const failure = yield* Effect.flip(replaceCartQuantity(restored.entries, selected, 0.001));
      expect(failure).toBeInstanceOf(CartDraftInvalid);
      expect(restored.entries[0]?.quantity).toBe(1);
      const invalidAddition = yield* Effect.flip(
        addCartEntry(entries, { ...selected, quantity: 0.001 }),
      );
      expect(invalidAddition).toBeInstanceOf(CartDraftInvalid);
      const invalidStored = yield* Effect.flip(
        decodeStoredCart(
          JSON.stringify({ entries: [{ ...selected, quantity: 0.001 }], scope, version: 1 }),
          scope,
        ),
      );
      expect(invalidStored).toBeInstanceOf(CartDraftInvalid);
    }),
  );
  it.effect("allows fractional owner minima and keeps legacy drafts without guessed minima", () =>
    Effect.gen(function* fractionalMinimum() {
      const selected = { ...entry, minimumQuantity: 0.25, quantity: 0.5 };
      const entries = yield* addCartEntry([], selected);
      const updated = yield* replaceCartQuantity(entries, selected, 0.25);
      expect(updated[0]?.quantity).toBe(0.25);
      expect(updated[0]?.minimumQuantity).toBe(0.25);
      const legacy = yield* decodeStoredCart(
        JSON.stringify({ entries: [{ ...entry, quantity: 0.001 }], scope, version: 1 }),
        scope,
      );
      expect(legacy.entries[0]?.quantity).toBe(0.001);
      expect(legacy.entries[0]).not.toHaveProperty("minimumQuantity");
    }),
  );
  it.effect("rejects malformed minimum snapshots instead of silently dropping them", () =>
    Effect.gen(function* invalidMinimum() {
      for (const minimumQuantity of [0, -1, 1_000_001, "1", null]) {
        const failure = yield* Effect.flip(
          decodeStoredCart(
            JSON.stringify({ entries: [{ ...entry, minimumQuantity }], scope, version: 1 }),
            scope,
          ),
        );
        expect(failure).toBeInstanceOf(CartDraftInvalid);
      }
      for (const minimumQuantity of [Number.NaN, Number.POSITIVE_INFINITY]) {
        const failure = yield* Effect.flip(addCartEntry([], { ...entry, minimumQuantity }));
        expect(failure).toBeInstanceOf(CartDraftInvalid);
      }
    }),
  );
  it.effect("uses the latest exact selection minimum and preserves unrelated variants", () =>
    Effect.gen(function* latestMinimum() {
      const selected = { ...entry, minimumQuantity: 1 };
      const other = { ...entry, minimumQuantity: 0.25, quantity: 0.5, variantId: "v2" };
      const entries = yield* addCartEntry([selected, other], {
        ...selected,
        minimumQuantity: 3,
        quantity: 3,
      });
      expect(entries[0]?.minimumQuantity).toBe(3);
      expect(entries[0]?.quantity).toBe(5);
      expect(entries[1]).toEqual(other);
      const failure = yield* Effect.flip(replaceCartQuantity(entries, selected, 2));
      expect(failure).toBeInstanceOf(CartDraftInvalid);
      const legacyAddition = yield* addCartEntry(entries, entry);
      expect(legacyAddition[0]?.minimumQuantity).toBe(3);
      expect(legacyAddition[0]?.quantity).toBe(7);
    }),
  );
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
