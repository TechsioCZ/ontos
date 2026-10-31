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
  useRef,
  useState,
} from "react";

import {
  type CartAction,
  type CartState,
  type CartLine,
  type CartItemSnapshot,
  cartReducer,
  createEmptyCart,
  getCartItemCount,
} from "@/features/cart/cart-state";

import { parseStoredCart } from "@/features/cart/cart-storage";
import type { CatalogPriceTier } from "@/ontos/catalog-types";
import {
  type CartCollection,
  createCartCollection,
  parseCartCollection,
  snapshotCartCollection,
  cartCollectionStorageKey,
} from "@/features/cart/cart-collection";

const isError = (value: unknown): value is Error =>
  value !== null && value !== undefined && Error.prototype.isPrototypeOf(value);

const storageKey = "akros-demo-cart-v3";

interface CartContextValue {
  addItem: (
    item: CartItemSnapshot,
    quantity: number,
    priceTiers?: readonly CatalogPriceTier[],
  ) => Promise<boolean>;
  adding: boolean;
  purchaseError: string;
  carts: CartCollection["carts"];
  activeCartId: string;
  selectCart: (id: string) => void;
  addCart: (name: string) => void;
  removeCart: (id: string) => void;
  clearCart: (id: string) => void;
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

interface CartProviderState extends CartCollection {
  cart: CartState;
  ready: boolean;
  feedback: CartFeedback | null;
  removedItem: RemovedCartItem | null;
  sequence: number;
}

type CartProviderAction =
  | CartAction
  | { type: "verified-add"; cart: CartState; item: CartItemSnapshot; quantity: number }
  | { type: "hydrate"; collection: CartCollection }
  | { type: "select-cart"; id: string }
  | { type: "add-cart"; id: string; name: string }
  | { type: "remove-cart"; id: string }
  | { type: "clear-cart"; id: string }
  | { type: "undo-remove"; id: number }
  | { type: "dismiss-remove"; id: number };

const providerReducer = (
  state: CartProviderState,
  action: CartProviderAction,
): CartProviderState => {
  if (action.type === "verified-add") {
    const line = action.cart.lines.find(
      (entry) =>
        entry.productId === action.item.productId && entry.variantId === action.item.variantId,
    );
    const previous = state.cart.lines.find(
      (entry) =>
        entry.productId === action.item.productId && entry.variantId === action.item.variantId,
    );
    if (!line) return state;
    return {
      ...state,
      cart: action.cart,
      sequence: state.sequence + 1,
      feedback: {
        id: state.sequence + 1,
        kind: "added",
        line,
        quantity: getAddedQuantity(line, previous),
        limited: false,
      },
    };
  }
  if (action.type === "hydrate")
    return {
      ...state,
      ...action.collection,
      cart: action.collection.carts.find((entry) => entry.id === action.collection.activeCartId)!
        .cart,
      ready: true,
    };
  if (
    action.type === "select-cart" ||
    action.type === "add-cart" ||
    action.type === "remove-cart"
  ) {
    if (!state.ready) return state;
    let collection = snapshotCartCollection(state, state.cart);
    if (action.type === "select-cart") {
      if (
        !collection.carts.some((entry) => entry.id === action.id) ||
        action.id === state.activeCartId
      )
        return state;
      collection.activeCartId = action.id;
    } else if (action.type === "add-cart") {
      const name = action.name.trim();
      if (
        !name ||
        collection.carts.some(
          (entry) =>
            entry.id === action.id ||
            entry.name.toLocaleLowerCase("cs-CZ") === name.toLocaleLowerCase("cs-CZ"),
        )
      )
        return state;
      collection.carts = [...collection.carts, { id: action.id, name, cart: createEmptyCart() }];
      collection.activeCartId = action.id;
    } else {
      if (collection.carts.length < 2 || !collection.carts.some((entry) => entry.id === action.id))
        return state;
      collection.carts = collection.carts.filter((entry) => entry.id !== action.id);
      if (collection.activeCartId === action.id) collection.activeCartId = collection.carts[0].id;
    }
    return {
      ...state,
      ...collection,
      cart: collection.carts.find((entry) => entry.id === collection.activeCartId)!.cart,
      feedback: null,
      removedItem: null,
    };
  }
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
  if (action.type === "clear-cart" && action.id !== state.activeCartId) {
    return {
      ...state,
      carts: state.carts.map((entry) =>
        entry.id === action.id ? { ...entry, cart: createEmptyCart() } : entry,
      ),
    };
  }
  if (action.type === "clear" || action.type === "clear-cart") {
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

export function CartProvider({
  children,
  storage,
}: {
  children: ReactNode;
  storage?: Storage | null;
}) {
  const [state, providerDispatch] = useReducer(providerReducer, {
    ...createCartCollection(),
    cart: createEmptyCart(),
    ready: false,
    feedback: null,
    removedItem: null,
    sequence: 0,
  });
  const { cart, ready, feedback, removedItem, activeCartId } = state;
  const [adding, setAdding] = useState(false);
  const [purchaseError, setPurchaseError] = useState("");
  const stateRef = useRef(state);
  stateRef.current = state;
  const addBusy = useRef(false);
  const addItem = useCallback(
    async (
      item: CartItemSnapshot,
      quantity: number,
      priceTiers: readonly CatalogPriceTier[] = [],
    ): Promise<boolean> => {
      if (addBusy.current) return false;
      addBusy.current = true;
      setAdding(true);
      setPurchaseError("");
      const current = stateRef.current;
      try {
        if (!current.ready || !Number.isFinite(quantity) || quantity <= 0)
          throw new Error("Košík není připravený.");
        const previous = current.cart.lines.find(
          (line) => line.productId === item.productId && line.variantId === item.variantId,
        );
        const cumulativeQuantity = (previous?.quantity ?? 0) + quantity;
        const tier = [...priceTiers]
          .filter((entry) => entry.minimumQuantity <= cumulativeQuantity)
          .sort((left, right) => right.minimumQuantity - left.minimumQuantity)[0];
        const proposed = {
          version: 3,
          lines: [
            ...current.cart.lines.filter((line) => line !== previous),
            {
              ...item,
              quantity: cumulativeQuantity,
              priceMinor: tier?.priceMinor ?? item.priceMinor,
              priceExcludingVatMinor: tier?.priceExcludingVatMinor ?? item.priceExcludingVatMinor,
            },
          ],
        };
        const response = await fetch("/api/ontos/cart", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cart: proposed }),
          cache: "no-store",
          signal: AbortSignal.timeout(8_000),
        });
        const quote = await response.json();
        if (!response.ok)
          throw new Error("Cenu a sklad nyní nelze ověřit v OntOS. Zboží nebylo přidáno.");
        if (quote.priceChanged)
          throw new Error(
            "Cena se změnila. Obnovte stránku nebo ověřte stávající košík a přidejte zboží za aktuální cenu.",
          );
        if (!quote.canCheckout || !Array.isArray(quote.cart?.lines))
          throw new Error(
            Array.isArray(quote.issues) && quote.issues.length
              ? quote.issues.join(" ")
              : "OntOS nepotvrdil dostupnost zboží. Zboží nebylo přidáno.",
          );
        if (
          stateRef.current.cart !== current.cart ||
          stateRef.current.activeCartId !== current.activeCartId
        )
          throw new Error("Košík se během ověření změnil. Přidejte položku znovu.");
        providerDispatch({ type: "verified-add", cart: quote.cart, item, quantity });
        return true;
      } catch (error) {
        setPurchaseError(
          isError(error) && error.name !== "TypeError"
            ? error.message
            : "Cenu a sklad nyní nelze ověřit v OntOS. Zboží nebylo přidáno.",
        );
        return false;
      } finally {
        addBusy.current = false;
        setAdding(false);
      }
    },
    [],
  );

  const carts = useMemo(() => snapshotCartCollection(state, cart).carts, [state, cart]);
  const selectCart = useCallback((id: string) => providerDispatch({ type: "select-cart", id }), []);
  const addCart = useCallback(
    (name: string) => providerDispatch({ type: "add-cart", id: crypto.randomUUID(), name }),
    [],
  );
  const removeCart = useCallback((id: string) => providerDispatch({ type: "remove-cart", id }), []);
  const clearCart = useCallback((id: string) => providerDispatch({ type: "clear-cart", id }), []);
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
      providerDispatch({
        type: "hydrate",
        collection: parseCartCollection(
          resolvedStorage.getItem(cartCollectionStorageKey),
          restored,
        ),
      });
    } else {
      providerDispatch({ type: "hydrate", collection: createCartCollection() });
    }
  }, [resolvedStorage]);

  useEffect(() => {
    if (ready && resolvedStorage) {
      resolvedStorage.setItem(storageKey, JSON.stringify(cart));
      resolvedStorage.setItem(
        cartCollectionStorageKey,
        JSON.stringify({ version: 1, carts, activeCartId }),
      );
    }
  }, [cart, carts, activeCartId, ready, resolvedStorage]);

  const value = useMemo(
    () => ({
      cart,
      carts,
      activeCartId,
      addItem,
      adding,
      purchaseError,
      selectCart,
      addCart,
      removeCart,
      clearCart,
      dispatch,
      itemCount: getCartItemCount(cart),
      ready,
      feedback,
      removedItem,
      undoRemove,
      dismissRemove,
    }),
    [
      cart,
      addItem,
      adding,
      purchaseError,
      carts,
      activeCartId,
      selectCart,
      addCart,
      removeCart,
      clearCart,
      dispatch,
      ready,
      feedback,
      removedItem,
      undoRemove,
      dismissRemove,
    ],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export const useCart = () => {
  const context = useContext(CartContext);
  if (!context) throw new Error("useCart must be used inside CartProvider");
  return context;
};
