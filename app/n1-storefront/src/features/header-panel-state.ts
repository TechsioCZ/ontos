import type { CartScope } from "@/ontos/cart-quote";
import type { CartEntry } from "./cart-state";

export type HeaderPanel = "cart" | "login" | "navigation" | null;
export const changeHeaderPanel = (
  current: HeaderPanel,
  panel: Exclude<HeaderPanel, null>,
  open: boolean,
): HeaderPanel => {
  if (open) {
    return panel;
  }
  return current === panel ? null : current;
};
export interface MiniCartSnapshot {
  entries: readonly CartEntry[];
  error: boolean;
  loaded: boolean;
  scope: CartScope | null;
}
export const miniCartState = (cart: MiniCartSnapshot | null) => {
  if (cart === null || cart.scope === null) {
    return "unavailable" as const;
  }
  if (!cart.loaded) {
    return "loading" as const;
  }
  if (cart.error) {
    return "error" as const;
  }
  return cart.entries.length === 0 ? ("empty" as const) : ("filled" as const);
};
