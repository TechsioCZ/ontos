"use client";
import {
  CheckoutStockError,
  checkoutSaveError,
  readCheckoutQuote,
  readOrderResponse,
} from "@/ontos/checkout-response";

import { createContext, type ReactNode, useContext, useEffect, useReducer, useRef } from "react";
import { useCart } from "@/features/cart/cart-provider";
import {
  type CheckoutDraft,
  createCheckoutDraft,
  getCheckoutTotals,
  getDelivery,
  getReachableStep,
  parseCheckoutDraft,
} from "@/mock-storefront/checkout";
import { type LocalOrder, orderStorageKey } from "@/mock-storefront/local-order";

const legacyDraftStorageKey = "akros-demo-checkout-v1";
type DraftUpdate = (draft: CheckoutDraft) => CheckoutDraft;
type CheckoutStorage = Pick<Storage, "getItem" | "setItem">;

interface CheckoutContextValue {
  draft: CheckoutDraft;
  ready: boolean;
  storageError: string;
  submitted: boolean;
  updateDraft: (update: DraftUpdate) => void;
  completeOrder: () => Promise<LocalOrder | null>;
}

const CheckoutContext = createContext<CheckoutContextValue | null>(null);

interface CheckoutState {
  draft: CheckoutDraft;
  hydrated: boolean;
  storageError: string;
  submitError?: string;
  submitted: boolean;
}
type CheckoutAction =
  | { type: "hydrate"; draft: CheckoutDraft; error: string }
  | { type: "update"; update: DraftUpdate }
  | { type: "storage-result"; error: string }
  | { type: "submit-error"; error: string }
  | { type: "submitted" };

function checkoutReducer(state: CheckoutState, action: CheckoutAction): CheckoutState {
  switch (action.type) {
    case "hydrate":
      return { ...state, draft: action.draft, hydrated: true, storageError: action.error };
    case "update":
      return { ...state, draft: action.update(state.draft) };
    case "submit-error":
      return { ...state, submitError: action.error };
    case "storage-result":
      return state.storageError === action.error ? state : { ...state, storageError: action.error };
    case "submitted":
      return { ...state, draft: createCheckoutDraft(), submitted: true, storageError: "" };
  }
}

function CheckoutCartProvider({
  children,
  storage,
}: {
  children: ReactNode;
  storage?: CheckoutStorage;
}) {
  const { cart, dispatch, ready: cartReady, activeCartId } = useCart();
  const draftStorageKey =
    activeCartId === "default" ? legacyDraftStorageKey : `${legacyDraftStorageKey}:${activeCartId}`;
  const [{ draft, hydrated, storageError, submitError, submitted }, checkoutDispatch] = useReducer(
    checkoutReducer,
    undefined,
    () => ({
      draft: createCheckoutDraft(),
      hydrated: false,
      storageError: "",
      submitError: "",
      submitted: false,
    }),
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
  }, [storage, draftStorageKey]);

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
  }, [draft, hydrated, draftStorageKey]);

  async function completeOrder(): Promise<LocalOrder | null> {
    if (completed.current) return completed.current;
    checkoutDispatch({ type: "submit-error", error: "" });
    if (!hydrated || !cartReady || getReachableStep(3, cart, draft) !== 3) return null;
    const delivery = getDelivery(draft);
    if (!delivery) return null;

    let order: LocalOrder;
    try {
      if (!storageRef.current) throw new Error("Povolte úložiště pro tento web.");
      // Store the exact request BEFORE sending. Retries, double-submit and refresh reuse it verbatim.
      const key = `akros-ontos-pending:${activeCartId}`;
      const signature = JSON.stringify({ cart, draft });
      const previous = JSON.parse(storageRef.current.getItem(key) ?? "null");
      const pending =
        previous?.signature === signature
          ? previous
          : { signature, clientRequestId: `akros-${crypto.randomUUID()}` };
      storageRef.current.setItem(key, JSON.stringify(pending));
      if (!pending.sent) {
        const checkResponse = await fetch("/api/ontos/cart", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cart, deliveryId: draft.deliveryId }),
        });
        const check = await readCheckoutQuote(checkResponse);
        if (!check.canCheckout)
          throw new Error(
            check.priceChanged
              ? "Cena se změnila – přijmout novou cenu v ověření košíku a zkusit znovu."
              : `Košík nyní nelze ověřit. ${check.issues.join(" ")} Vraťte se do košíku a zkontrolujte dostupnost a množství.`.replace(
                  /\s+/g,
                  " ",
                ),
          );
      }
      pending.sent = true;
      storageRef.current.setItem(key, JSON.stringify(pending));
      const response = await fetch("/api/ontos/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cart, draft, clientRequestId: pending.clientRequestId }),
      });
      const result = await readOrderResponse(response);
      order = {
        version: 1,
        id: result.orderNumber,
        ...(result.orderId ? { orderId: result.orderId } : {}),
        clientRequestId: pending.clientRequestId,
        createdAt: new Date().toISOString(),
        cart: structuredClone(cart),
        draft: structuredClone(draft),
        deliveryTitle: delivery.title,
        paymentStatus: "not-processed",
        totals: {
          ...getCheckoutTotals(cart, draft),
          total: result.totalMinor,
          vat: result.totalVatMinor,
          net: result.totalMinor - result.totalVatMinor,
        },
      };
    } catch (error) {
      checkoutDispatch({
        type: "submit-error",
        error:
          error instanceof CheckoutStockError ||
          (error instanceof Error &&
            (error.message.startsWith("Cena se změnila") ||
              error.message.startsWith("Košík nyní nelze ověřit")))
            ? error.message
            : checkoutSaveError,
      });
      return null;
    }
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
        storageError: submitError || storageError,
        updateDraft: (update) => checkoutDispatch({ type: "update", update }),
        completeOrder,
      }}
    >
      {children}
    </CheckoutContext.Provider>
  );
}

export function CheckoutProvider(props: { children: ReactNode; storage?: CheckoutStorage }) {
  const { activeCartId } = useCart();
  return <CheckoutCartProvider key={activeCartId} {...props} />;
}

/** Chosen delivery id, or "" outside the checkout (the cart quote also runs in isolated tests). */
export function useCheckoutDeliveryId(): string {
  return useContext(CheckoutContext)?.draft.deliveryId ?? "";
}

export function useCheckout() {
  const value = useContext(CheckoutContext);
  if (!value) throw new Error("useCheckout must be used inside CheckoutProvider");
  return value;
}
