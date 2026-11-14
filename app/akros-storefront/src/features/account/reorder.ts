import { addCartItems, type CartLine, type CartState } from "@/features/cart/cart-state";
import type { Dictionary } from "@/i18n";
import type { ReorderResolution, ReorderSkipReason } from "@/ontos/reorder";

export interface ReorderResult {
  addedLines: number;
  notices: string[];
}

const skipNotice = (cs: Dictionary, sku: string, reason: ReorderSkipReason) =>
  reason === "price-unavailable"
    ? cs.account.reorder.priceUnavailable(sku)
    : reason === "availability-unknown"
      ? cs.account.reorder.availabilityUnknown(sku)
      : cs.account.reorder.notOffered(sku);

const isReason = (value: unknown): value is ReorderSkipReason =>
  value === "not-offered" || value === "price-unavailable" || value === "availability-unknown";

/** The `/api/ontos/account/reorder` body, or null when it is not a resolution. */
export function parseReorderResolution(value: unknown): ReorderResolution | null {
  if (!value || typeof value !== "object") return null;
  const { items, skipped } = value as Partial<ReorderResolution>;
  if (!Array.isArray(items) || !Array.isArray(skipped)) return null;
  const validItem = (item: CartLine) =>
    !!item &&
    typeof item.productId === "string" &&
    typeof item.sku === "string" &&
    typeof item.unit === "string" &&
    Number.isFinite(item.quantity) &&
    Number.isSafeInteger(item.priceMinor);
  if (!items.every(validItem)) return null;
  if (!skipped.every((entry) => entry && typeof entry.sku === "string" && isReason(entry.reason)))
    return null;
  return { items, skipped };
}

/**
 * Adds the resolved order lines to `cart` the way the cart provider's `reorder` action does (merging matching
 * variants, never reducing existing quantities, limited by stock and order quantities) and words the outcome.
 */
export function prepareReorder(cart: CartState, resolution: ReorderResolution, cs: Dictionary) {
  const { addedLines, notices } = addCartItems(cart, resolution.items);
  return {
    items: resolution.items,
    result: {
      addedLines,
      notices: [
        ...resolution.skipped.map((entry) => skipNotice(cs, entry.sku, entry.reason)),
        ...notices.map((notice) =>
          notice.kind === "unorderable"
            ? cs.account.reorder.unorderable(notice.sku)
            : cs.account.reorder.limited(notice.added, notice.requested, notice.unit, notice.sku),
        ),
      ],
    } satisfies ReorderResult,
  };
}
