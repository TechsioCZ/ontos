"use client";

import {
  createContext,
  useCallback,
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
  type CartLine,
  cartReducer,
  createEmptyCart,
  getCartItemCount,
  normalizeOrderQuantity,
} from "@/mock-storefront/cart";

const storageKey = "akros-demo-cart-v3";

interface CartContextValue {
  cart: CartState;
  dispatch: Dispatch<CartAction>;
  itemCount: number;
  ready: boolean;
  feedback: CartFeedback | null;
  removedItem: RemovedCartItem | null;
  undoRemove: (id: number) => void;
  dismissRemove: (id: number) => void;
}

interface CartFeedback {
  id: number;
  kind: "added" | "restored" | "limited";
  line: CartLine;
  quantity: number;
  limited: boolean;
}

interface RemovedCartItem {
  id: number;
  line: CartLine;
  index: number;
}

const CartContext = createContext<CartContextValue | null>(null);

// Cart quantities support six decimal places; ignore subtraction's floating-point noise.
const getAddedQuantity = (line: CartLine, previous?: CartLine) =>
  Math.round((line.quantity - (previous?.quantity ?? 0)) * 1_000_000) / 1_000_000;

interface CartProviderState {
  cart: CartState;
  ready: boolean;
  feedback: CartFeedback | null;
  removedItem: RemovedCartItem | null;
  sequence: number;
}

type CartProviderAction =
  | CartAction
  | { type: "hydrate"; cart: CartState }
  | { type: "undo-remove"; id: number }
  | { type: "dismiss-remove"; id: number };

const providerReducer = (
  state: CartProviderState,
  action: CartProviderAction,
): CartProviderState => {
  if (action.type === "hydrate") return { ...state, cart: action.cart, ready: true };
  if (action.type === "dismiss-remove") {
    return state.removedItem?.id === action.id ? { ...state, removedItem: null } : state;
  }
  if (action.type === "undo-remove") {
    const removed = state.removedItem;
    if (!removed || removed.id !== action.id) return state;
    const matches = (line: CartLine) =>
      line.productId === removed.line.productId && line.variantId === removed.line.variantId;
    const previous = state.cart.lines.find(matches);
    let cart = cartReducer(state.cart, {
      type: "add",
      item: removed.line,
      quantity: removed.line.quantity,
    });
    const line = cart.lines.find(matches);
    if (!line) return { ...state, removedItem: null };
    if (!previous) {
      const lines = cart.lines.filter((item) => !matches(item));
      lines.splice(Math.min(removed.index, lines.length), 0, line);
      cart = { ...cart, lines };
    }
    const quantity = getAddedQuantity(line, previous);
    const id = state.sequence + 1;
    return {
      ...state,
      cart,
      removedItem: null,
      sequence: id,
      feedback: {
        id,
        kind: quantity > 0 ? "restored" : "limited",
        line,
        quantity,
        limited: quantity < removed.line.quantity,
      },
    };
  }
  if (action.type === "clear") {
    return { ...state, cart: createEmptyCart(), feedback: null, removedItem: null };
  }
  if (action.type === "remove") {
    const index = state.cart.lines.findIndex(
      (line) => line.productId === action.productId && line.variantId === action.variantId,
    );
    if (index < 0) return state;
    const id = state.sequence + 1;
    return {
      ...state,
      cart: cartReducer(state.cart, action),
      sequence: id,
      feedback: null,
      removedItem: { id, index, line: state.cart.lines[index] },
    };
  }
  if (action.type === "add") {
    const matches = (line: CartLine) =>
      line.productId === action.item.productId && line.variantId === action.item.variantId;
    const previous = state.cart.lines.find(matches);
    const cart = cartReducer(state.cart, action);
    const line = cart.lines.find(matches) ?? { ...action.item, quantity: 0 };
    const quantity = getAddedQuantity(line, previous);
    const id = state.sequence + 1;
    return {
      ...state,
      cart,
      sequence: id,
      feedback: {
        id,
        kind: quantity > 0 ? "added" : "limited",
        line,
        quantity,
        limited: quantity < action.quantity,
      },
    };
  }

  return { ...state, cart: cartReducer(state.cart, action) };
};

const parseStoredCart = (value: string | null): CartState => {
  if (!value) return createEmptyCart();

  try {
    const parsed = JSON.parse(value) as Partial<CartState>;
    if (parsed.version !== 3 || !Array.isArray(parsed.lines)) return createEmptyCart();

    return {
      version: 3,
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
          typeof line.minimumQuantity !== "number" ||
          !Number.isSafeInteger(line.priceMinor) ||
          line.priceMinor < 0 ||
          !Number.isFinite(line.stockCount) ||
          line.stockCount < 0 ||
          !Number.isFinite(line.minimumQuantity) ||
          line.minimumQuantity <= 0 ||
          !Number.isFinite(line.quantity) ||
          line.quantity <= 0
        ) {
          return [];
        }

        const item = {
          productId: line.productId,
          ...(typeof line.variantId === "string" ? { variantId: line.variantId } : {}),
          slug: line.slug,
          name: line.name,
          sku: line.sku,
          imageSrc: line.imageSrc,
          imageAlt: line.imageAlt,
          unit: line.unit,
          minimumQuantity: line.minimumQuantity,
          priceMinor: line.priceMinor,
          ...(Number.isSafeInteger(line.priceExcludingVatMinor) &&
          (line.priceExcludingVatMinor ?? -1) >= 0 &&
          (line.priceExcludingVatMinor ?? Infinity) <= line.priceMinor
            ? { priceExcludingVatMinor: line.priceExcludingVatMinor }
            : {}),
          stockCount: line.stockCount,
          ...(typeof line.variantLabel === "string" ? { variantLabel: line.variantLabel } : {}),
        };
        const quantity = normalizeOrderQuantity(item, line.quantity);

        return quantity > 0 ? [{ ...item, quantity }] : [];
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
  const [{ cart, ready, feedback, removedItem }, providerDispatch] = useReducer(providerReducer, {
    cart: createEmptyCart(),
    ready: false,
    feedback: null,
    removedItem: null,
    sequence: 0,
  });
  const dispatch: Dispatch<CartAction> = providerDispatch;
  const undoRemove = useCallback((id: number) => providerDispatch({ type: "undo-remove", id }), []);
  const dismissRemove = useCallback(
    (id: number) => providerDispatch({ type: "dismiss-remove", id }),
    [],
  );
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
    () => ({
      cart,
      dispatch,
      itemCount: getCartItemCount(cart),
      ready,
      feedback,
      removedItem,
      undoRemove,
      dismissRemove,
    }),
    [cart, dispatch, ready, feedback, removedItem, undoRemove, dismissRemove],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export const useCart = () => {
  const context = useContext(CartContext);
  if (!context) throw new Error("useCart must be used inside CartProvider");
  return context;
};
