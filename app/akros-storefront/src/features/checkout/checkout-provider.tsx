"use client";

import { createContext, type ReactNode, useContext, useEffect, useReducer, useRef } from "react";
import { useCart } from "@/features/cart/cart-provider";
import {
  type CheckoutDraft,
  createCheckoutDraft,
  getCheckoutTotals,
  getDelivery,
  getPayment,
  getReachableStep,
  parseCheckoutDraft,
} from "@/mock-storefront/checkout";
import { type LocalOrder, orderStorageKey } from "@/mock-storefront/local-order";

const draftStorageKey = "akros-demo-checkout-v1";
type DraftUpdate = (draft: CheckoutDraft) => CheckoutDraft;
type CheckoutStorage = Pick<Storage, "getItem" | "setItem">;

interface CheckoutContextValue {
  draft: CheckoutDraft;
  ready: boolean;
  storageError: string;
  submitted: boolean;
  updateDraft: (update: DraftUpdate) => void;
  completeOrder: () => LocalOrder | null;
}

const CheckoutContext = createContext<CheckoutContextValue | null>(null);

interface CheckoutState {
  draft: CheckoutDraft;
  hydrated: boolean;
  storageError: string;
  submitted: boolean;
}
type CheckoutAction =
  | { type: "hydrate"; draft: CheckoutDraft; error: string }
  | { type: "update"; update: DraftUpdate }
  | { type: "storage-result"; error: string }
  | { type: "submitted" };

function checkoutReducer(state: CheckoutState, action: CheckoutAction): CheckoutState {
  switch (action.type) {
    case "hydrate":
      return { ...state, draft: action.draft, hydrated: true, storageError: action.error };
    case "update":
      return { ...state, draft: action.update(state.draft) };
    case "storage-result":
      return state.storageError === action.error ? state : { ...state, storageError: action.error };
    case "submitted":
      return { ...state, draft: createCheckoutDraft(), submitted: true, storageError: "" };
  }
}

export function CheckoutProvider({
  children,
  storage,
}: {
  children: ReactNode;
  storage?: CheckoutStorage;
}) {
  const { cart, dispatch, ready: cartReady } = useCart();
  const [{ draft, hydrated, storageError, submitted }, checkoutDispatch] = useReducer(
    checkoutReducer,
    undefined,
    () => ({ draft: createCheckoutDraft(), hydrated: false, storageError: "", submitted: false }),
  );
  const storageRef = useRef<CheckoutStorage | null>(null);
  const completed = useRef<LocalOrder | null>(null);

  useEffect(() => {
    try {
      storageRef.current = storage ?? window.sessionStorage;
      checkoutDispatch({
        type: "hydrate",
        draft: parseCheckoutDraft(storageRef.current.getItem(draftStorageKey)),
        error: "",
      });
    } catch {
      checkoutDispatch({
        type: "hydrate",
        draft: createCheckoutDraft(),
        error: "Rozpracované údaje nelze uložit v prohlížeči. Povolte úložiště pro tento web.",
      });
    }
  }, [storage]);

  useEffect(() => {
    if (!hydrated || !storageRef.current) return;
    try {
      storageRef.current.setItem(draftStorageKey, JSON.stringify({ version: 1, draft }));
      checkoutDispatch({ type: "storage-result", error: "" });
    } catch {
      checkoutDispatch({
        type: "storage-result",
        error: "Rozpracované údaje nelze uložit v prohlížeči. Povolte úložiště pro tento web.",
      });
    }
  }, [draft, hydrated]);

  function completeOrder(): LocalOrder | null {
    if (completed.current) return completed.current;
    if (!hydrated || !cartReady || getReachableStep(3, cart, draft) !== 3) return null;
    const delivery = getDelivery(draft);
    const payment = getPayment(draft);
    if (!delivery || !payment) return null;

    const order: LocalOrder = {
      version: 1,
      id: `DEMO-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      createdAt: new Date().toISOString(),
      cart: structuredClone(cart),
      draft: structuredClone(draft),
      deliveryTitle: delivery.title,
      paymentTitle: payment.title,
      paymentStatus: "not-processed",
      totals: getCheckoutTotals(cart, draft),
    };
    try {
      if (!storageRef.current) throw new Error("Session storage unavailable");
      storageRef.current.setItem(orderStorageKey, JSON.stringify(order));
    } catch {
      checkoutDispatch({
        type: "storage-result",
        error:
          "Objednávku se nepodařilo uložit. Košík zůstává zachovaný; povolte úložiště a zkuste to znovu.",
      });
      return null;
    }
    completed.current = order;
    checkoutDispatch({ type: "submitted" });
    dispatch({ type: "clear" });
    return order;
  }

  return (
    <CheckoutContext.Provider
      value={{
        draft,
        ready: hydrated && cartReady,
        submitted,
        storageError,
        updateDraft: (update) => checkoutDispatch({ type: "update", update }),
        completeOrder,
      }}
    >
      {children}
    </CheckoutContext.Provider>
  );
}

export function useCheckout() {
  const value = useContext(CheckoutContext);
  if (!value) throw new Error("useCheckout must be used inside CheckoutProvider");
  return value;
}
