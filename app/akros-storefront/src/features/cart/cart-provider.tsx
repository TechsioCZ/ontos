"use client";

import {
  createContext,
  type Dispatch,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useReducer,
} from "react";

import {
  type CartAction,
  type CartState,
  cartReducer,
  createEmptyCart,
  getCartItemCount,
} from "@/mock-storefront/cart";

const storageKey = "akros-demo-cart-v2";

interface CartContextValue {
  cart: CartState;
  dispatch: Dispatch<CartAction>;
  itemCount: number;
  ready: boolean;
}

const CartContext = createContext<CartContextValue | null>(null);

interface CartProviderState {
  cart: CartState;
  ready: boolean;
}

type CartProviderAction = CartAction | { type: "hydrate"; cart: CartState };

const providerReducer = (
  state: CartProviderState,
  action: CartProviderAction,
): CartProviderState => {
  if (action.type === "hydrate") return { cart: action.cart, ready: true };

  return { ...state, cart: cartReducer(state.cart, action) };
};

const parseStoredCart = (value: string | null): CartState => {
  if (!value) return createEmptyCart();

  try {
    const parsed = JSON.parse(value) as Partial<CartState>;
    if (parsed.version !== 2 || !Array.isArray(parsed.lines)) return createEmptyCart();

    return {
      version: 2,
      lines: parsed.lines.flatMap((line) => {
        if (
          typeof line?.productId !== "string" ||
          typeof line.slug !== "string" ||
          typeof line.name !== "string" ||
          typeof line.sku !== "string" ||
          typeof line.imageSrc !== "string" ||
          typeof line.imageAlt !== "string" ||
          typeof line.unit !== "string" ||
          typeof line.priceMinor !== "number" ||
          typeof line.stockCount !== "number" ||
          !Number.isInteger(line.quantity) ||
          line.quantity <= 0
        ) {
          return [];
        }

        return [
          {
            productId: line.productId,
            ...(typeof line.variantId === "string" ? { variantId: line.variantId } : {}),
            slug: line.slug,
            name: line.name,
            sku: line.sku,
            imageSrc: line.imageSrc,
            imageAlt: line.imageAlt,
            unit: line.unit,
            priceMinor: line.priceMinor,
            stockCount: line.stockCount,
            ...(typeof line.variantLabel === "string" ? { variantLabel: line.variantLabel } : {}),
            quantity: line.quantity,
          },
        ];
      }),
    };
  } catch {
    return createEmptyCart();
  }
};

export function CartProvider({
  children,
  storage,
}: {
  children: ReactNode;
  storage?: Storage | null;
}) {
  const [{ cart, ready }, providerDispatch] = useReducer(providerReducer, {
    cart: createEmptyCart(),
    ready: false,
  });
  const dispatch: Dispatch<CartAction> = providerDispatch;
  const resolvedStorage =
    storage === undefined && typeof window !== "undefined" ? window.localStorage : storage;

  useEffect(() => {
    if (resolvedStorage) {
      const restored = parseStoredCart(resolvedStorage.getItem(storageKey));
      providerDispatch({ type: "hydrate", cart: restored });
    } else {
      providerDispatch({ type: "hydrate", cart: createEmptyCart() });
    }
  }, [resolvedStorage]);

  useEffect(() => {
    if (ready && resolvedStorage) {
      resolvedStorage.setItem(storageKey, JSON.stringify(cart));
    }
  }, [cart, ready, resolvedStorage]);

  const value = useMemo(
    () => ({ cart, dispatch, itemCount: getCartItemCount(cart), ready }),
    [cart, dispatch, ready],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export const useCart = () => {
  const context = useContext(CartContext);
  if (!context) throw new Error("useCart must be used inside CartProvider");
  return context;
};
