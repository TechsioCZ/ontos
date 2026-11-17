import { describe, expect, it } from "@rstest/core";
import {
  cartIssueText,
  cartEntryWithStock,
  globalCartIssues,
  hasInvalidCartDraft,
  issuesForCartEntry,
  quantityDraftForEntry,
  reconcileQuantityDrafts,
  removeQuantityDraft,
  validCartQuantity,
} from "../src/features/cart-validation";
import type { QuantityDrafts } from "../src/features/cart-validation";
import { cartLineKey, cartQuantityMaximum, cartQuantityStep } from "../src/features/cart-state";

const entry = {
  expectedUnitPriceMinor: 12_100,
  image: null,
  name: "Product",
  productId: "product",
  quantity: 2,
  sku: "SKU",
  slug: "product",
  unit: "ks",
  variantId: "large",
  variantName: "Large",
};
const blankDraft = (): QuantityDrafts => ({
  [cartLineKey(entry)]: { quantity: 2, saveError: false, value: "" },
});

describe("cart quantity draft lifecycle", () => {
  it("gates both saved overstock and manual overflow against current per-variant stock", () => {
    const stocks = [{ productId: entry.productId, stockQuantity: 2, variantId: entry.variantId }];
    const selected = cartEntryWithStock(entry, stocks);
    expect(hasInvalidCartDraft({}, [selected])).toBe(false);
    expect(hasInvalidCartDraft({}, [{ ...selected, quantity: 3 }])).toBe(true);
    expect(
      hasInvalidCartDraft({ [cartLineKey(entry)]: { quantity: 2, saveError: false, value: "9" } }, [
        selected,
      ]),
    ).toBe(true);
    expect(cartEntryWithStock({ ...entry, variantId: "other" }, stocks)).not.toHaveProperty(
      "stockQuantity",
    );
    expect(
      cartEntryWithStock({ ...entry, stockQuantity: 2 }, [{ ...stocks[0], stockQuantity: null }])
        .stockQuantity,
    ).toBeNull();
  });
  it("keeps stock bounds aligned to native packages without rounding the customer's quantity", () => {
    expect(cartQuantityMaximum(10, 3)).toBe(9);
    expect(cartQuantityMaximum(0.3, 0.1)).toBe(0.3);
    expect(cartQuantityMaximum(2, 3)).toBe(0);
    expect(cartQuantityMaximum(null)).toBe(1_000_000);
    expect(validCartQuantity(11, 1, null, cartQuantityMaximum(10))).toBe(false);
    expect(validCartQuantity(9, 1, 3, cartQuantityMaximum(10, 3))).toBe(true);
  });
  it("does not increase a fresher catalog bound from a retained pending quote", () => {
    const selected = { ...entry, stockQuantity: 2 };
    const previous = [
      { productId: entry.productId, stockQuantity: 10, variantId: entry.variantId },
    ];
    expect(cartEntryWithStock(selected, previous, false).stockQuantity).toBe(2);
    expect(cartEntryWithStock(selected, previous, true).stockQuantity).toBe(10);
    expect(
      cartEntryWithStock(selected, [{ ...previous[0], stockQuantity: null }], false).stockQuantity,
    ).toBe(2);
    expect(cartEntryWithStock(entry, previous, false).stockQuantity).toBe(10);
  });
  it.each([undefined, null, 0, -2, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "keeps steppers usable without a positive finite owner package: %s",
    (packageQuantity) => {
      expect(cartQuantityStep(packageQuantity)).toBe(1);
    },
  );
  it.each([2, 0.1, 6.21])("steps between valid owner packages of %s", (packageQuantity) => {
    const quantity = packageQuantity * 2;
    const step = cartQuantityStep(packageQuantity);
    expect(step).toBe(packageQuantity);
    expect(validCartQuantity(quantity + step, packageQuantity, packageQuantity)).toBe(true);
    expect(validCartQuantity(quantity - step, packageQuantity, packageQuantity)).toBe(true);
  });
  it("checks native zero-based package multiples separately from the minimum", () => {
    expect(validCartQuantity(3, 3, 2)).toBe(false);
    expect(validCartQuantity(4, 3, 2)).toBe(true);
    expect(validCartQuantity(5, 3, 2)).toBe(false);
    expect(validCartQuantity(6, 3, 2)).toBe(true);
    expect(validCartQuantity(0.3, 0.1, 0.1)).toBe(true);
    expect(validCartQuantity(0.35, 0.1, 0.1)).toBe(false);
    expect(validCartQuantity(0.375, 0.25, 0)).toBe(true);
    const selected = { ...entry, minimumQuantity: 3, packageQuantity: 2, quantity: 4 };
    const drafts = { [cartLineKey(selected)]: { quantity: 4, saveError: false, value: "5" } };
    expect(hasInvalidCartDraft(drafts, [selected])).toBe(true);
  });
  it("gates quantities below the selected minimum without forcing whole units", () => {
    expect(validCartQuantity(0.001, 1)).toBe(false);
    expect(validCartQuantity(1, 1)).toBe(true);
    expect(validCartQuantity(0.25, 0.25)).toBe(true);
    expect(validCartQuantity(0.375, 0.25)).toBe(true);
    expect(validCartQuantity(0.001)).toBe(true);
    const drafts = { [cartLineKey(entry)]: { quantity: 2, saveError: false, value: "0.5" } };
    expect(hasInvalidCartDraft(drafts, [{ ...entry, minimumQuantity: 1 }])).toBe(true);
    expect(hasInvalidCartDraft(drafts, [{ ...entry, minimumQuantity: 0.25 }])).toBe(false);
    expect(hasInvalidCartDraft(drafts, [entry])).toBe(false);
  });
  it("discards an invalid input and its gate together after an external quantity change", () => {
    const drafts = blankDraft();
    expect(hasInvalidCartDraft(drafts, [entry])).toBe(true);
    const external = { ...entry, quantity: 3 };
    expect(quantityDraftForEntry(drafts, external)).toBeUndefined();
    expect(hasInvalidCartDraft(drafts, [external])).toBe(false);
    const reconciled = reconcileQuantityDrafts(drafts, [external]);
    expect(reconciled).toEqual({});
    expect(quantityDraftForEntry(reconciled, entry)).toBeUndefined();
  });
  it("keeps invalid input and gate when only the external price changes", () => {
    const drafts = blankDraft();
    const external = { ...entry, expectedUnitPriceMinor: 14_000 };
    expect(quantityDraftForEntry(drafts, external)?.value).toBe("");
    expect(reconcileQuantityDrafts(drafts, [external])).toBe(drafts);
    expect(hasInvalidCartDraft(drafts, [external])).toBe(true);
  });
  it("clears removed selections before local or observed external re-addition", () => {
    const local = removeQuantityDraft(blankDraft(), entry);
    const external = reconcileQuantityDrafts(blankDraft(), []);
    for (const drafts of [local, external]) {
      expect(quantityDraftForEntry(drafts, entry)).toBeUndefined();
      expect(hasInvalidCartDraft(drafts, [entry])).toBe(false);
    }
  });
  it("retains failed saves and isolates other variant drafts", () => {
    const drafts = { [cartLineKey(entry)]: { quantity: 2, saveError: true, value: "3" } };
    expect(hasInvalidCartDraft(drafts, [entry])).toBe(true);
    expect(hasInvalidCartDraft(drafts, [{ ...entry, variantId: "small" }])).toBe(false);
  });
});
describe("cart owner issue visibility", () => {
  it("retains fieldless MARKET_UNAVAILABLE and unknown codes for localized global output", () => {
    const issues = [{ code: "MARKET_UNAVAILABLE" }, { code: "FUTURE_OWNER_CODE" }];
    expect(globalCartIssues(issues)).toEqual(issues);
    expect(
      cartIssueText("MARKET_UNAVAILABLE", { MARKET_UNAVAILABLE: "Trh není dostupný" }, "Odmítnuto"),
    ).toBe("Trh není dostupný");
    expect(cartIssueText("FUTURE_OWNER_CODE", {}, "Odmítnuto")).toBe("Odmítnuto");
  });
  it("shows product-wide issues on its variants and keeps variant-specific issues isolated", () => {
    const productIssue = { code: "NOT_AVAILABLE", productId: entry.productId };
    const variantIssue = { code: "PRICE_CHANGED", productId: entry.productId, variantId: "large" };
    const foreign = { code: "OUT_OF_STOCK", productId: "other" };
    const issues = [productIssue, variantIssue, foreign];
    expect(issuesForCartEntry(issues, entry)).toEqual([productIssue, variantIssue]);
    expect(issuesForCartEntry(issues, { ...entry, variantId: "small" })).toEqual([productIssue]);
    expect(globalCartIssues(issues)).toEqual([]);
  });
});
