import type { CartQuoteRequest, CartScope } from "@/ontos/cart-quote";
import type { CartEntry } from "./cart-state";

interface CartQuoteDraft {
  readonly entries: readonly CartEntry[];
  readonly error: boolean;
  readonly loaded: boolean;
  readonly scope: CartScope | null;
}

export const requestForCart = (
  cart: CartQuoteDraft | null,
  locale: string,
  invalid: boolean,
): CartQuoteRequest | null => {
  if (
    cart === null ||
    cart.scope === null ||
    !cart.loaded ||
    cart.error ||
    cart.entries.length === 0 ||
    invalid
  ) {
    return null;
  }
  return {
    lines: cart.entries.map((entry) => {
      const line = {
        expectedUnitPriceMinor: entry.expectedUnitPriceMinor,
        productId: entry.productId,
        quantity: entry.quantity,
      };
      return entry.variantId === undefined ? line : { ...line, variantId: entry.variantId };
    }),
    locale: locale === "en" ? "en" : "cs",
    scope: cart.scope,
  };
};
