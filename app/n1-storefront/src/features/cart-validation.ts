import type { CartQuote } from "@/ontos/cart-quote";
import { cartLineKey, cartQuantityMaximum, validCartQuantity } from "./cart-state";
import type { CartEntry } from "./cart-state";

export { validCartQuantity } from "./cart-state";

/** Current scoped owner stock overrides a saved display hint, including an explicit unknown. */
export const cartEntryWithStock = (
  entry: CartEntry,
  stocks: CartQuote["stocks"],
  current = true,
) => {
  const stock = stocks?.find((item) => cartLineKey(item) === cartLineKey(entry));
  if (stock === undefined || (!current && stock.stockQuantity === null)) {
    return entry;
  }
  const stockQuantity =
    !current &&
    entry.stockQuantity !== undefined &&
    entry.stockQuantity !== null &&
    stock.stockQuantity !== null
      ? Math.min(entry.stockQuantity, stock.stockQuantity)
      : stock.stockQuantity;
  return { ...entry, stockQuantity };
};

export interface QuantityDraft {
  quantity: number;
  saveError: boolean;
  value: string;
}
export type QuantityDrafts = Readonly<Record<string, QuantityDraft>>;
export const quantityDraftForEntry = (drafts: QuantityDrafts, entry: CartEntry) => {
  const draft = drafts[cartLineKey(entry)];
  return draft?.quantity === entry.quantity ? draft : undefined;
};
export const hasInvalidCartDraft = (drafts: QuantityDrafts, entries: readonly CartEntry[]) =>
  entries.some((entry) => {
    const draft = quantityDraftForEntry(drafts, entry);
    return (
      draft?.saveError === true ||
      !validCartQuantity(
        draft === undefined ? entry.quantity : Number(draft.value),
        entry.minimumQuantity,
        entry.packageQuantity,
        cartQuantityMaximum(entry.stockQuantity, entry.packageQuantity),
      )
    );
  });
export const removeQuantityDraft = (drafts: QuantityDrafts, entry: CartEntry): QuantityDrafts => {
  const key = cartLineKey(entry);
  return Object.fromEntries(Object.entries(drafts).filter(([candidate]) => candidate !== key));
};
export const reconcileQuantityDrafts = (
  drafts: QuantityDrafts,
  entries: readonly CartEntry[],
): QuantityDrafts => {
  const retained = Object.entries(drafts).filter(([key, draft]) =>
    entries.some((entry) => cartLineKey(entry) === key && entry.quantity === draft.quantity),
  );
  return retained.length === Object.keys(drafts).length ? drafts : Object.fromEntries(retained);
};
export const globalCartIssues = (issues: CartQuote["issues"]) =>
  issues.filter((issue) => issue.productId === undefined);
export const issuesForCartEntry = (issues: CartQuote["issues"], entry: CartEntry) =>
  issues.filter(
    (issue) =>
      issue.productId === entry.productId &&
      (issue.variantId === undefined || issue.variantId === entry.variantId),
  );
export const cartIssueText = (
  code: string,
  messages: Readonly<Record<string, string>>,
  fallback: string,
) => Object.entries(messages).find(([key]) => key === code)?.[1] ?? fallback;
