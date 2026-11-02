import { type CartState, createEmptyCart } from "./cart-state";
import { parseStoredCart } from "./cart-storage";

export const cartCollectionStorageKey = "akros-demo-carts-v1";
/** Names of the two cart slots a new shopper starts with, in the market's language. */
export interface DefaultCartNames {
  readonly default: string;
  readonly commission: string;
}

/** Czech names: every surface outside a market, and any stored collection that is already named. */
export const CZECH_DEFAULT_CART_NAMES: DefaultCartNames = {
  default: "Výchozí košík",
  commission: "Komisní košík",
};
export interface NamedCart {
  id: string;
  name: string;
  cart: CartState;
}
export interface CartCollection {
  carts: NamedCart[];
  activeCartId: string;
}

export function createCartCollection(
  cart = createEmptyCart(),
  names: DefaultCartNames = CZECH_DEFAULT_CART_NAMES,
): CartCollection {
  return {
    activeCartId: "default",
    carts: [
      { id: "default", name: names.default, cart },
      { id: "commission", name: names.commission, cart: createEmptyCart() },
    ],
  };
}

export function parseCartCollection(
  value: string | null,
  fallback: CartState,
  names: DefaultCartNames = CZECH_DEFAULT_CART_NAMES,
): CartCollection {
  if (value) {
    try {
      const parsed = JSON.parse(value);
      if (parsed.version === 1 && Array.isArray(parsed.carts) && parsed.carts.length) {
        const ids = new Set<string>();
        const carts: NamedCart[] = [];
        for (const entry of parsed.carts) {
          if (
            !entry ||
            typeof entry.id !== "string" ||
            !entry.id ||
            ids.has(entry.id) ||
            typeof entry.name !== "string" ||
            !entry.name.trim()
          )
            return createCartCollection(fallback, names);
          ids.add(entry.id);
          carts.push({
            id: entry.id,
            name: entry.name.trim(),
            cart: parseStoredCart(JSON.stringify(entry.cart)),
          });
        }
        const activeCartId = ids.has(parsed.activeCartId) ? parsed.activeCartId : carts[0].id;
        return { carts, activeCartId };
      }
    } catch {
      // Preserve the existing v3 cart when the collection is missing or corrupt.
    }
  }
  return createCartCollection(fallback, names);
}

export function snapshotCartCollection(
  collection: CartCollection,
  cart: CartState,
): CartCollection {
  return {
    ...collection,
    carts: collection.carts.map((entry) =>
      entry.id === collection.activeCartId ? { ...entry, cart } : entry,
    ),
  };
}
