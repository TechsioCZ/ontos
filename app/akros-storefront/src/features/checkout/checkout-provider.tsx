"use client";
import { useDataSource } from "@/ontos/catalog-provider";
import { demoPayment } from "@/ontos/demo-checkout";
import { checkoutSaveError, readCheckoutQuote, readOrderResponse } from "@/ontos/checkout-response";

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
  const ontos = useDataSource() === "ontos";
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
        draft: {
          ...parseCheckoutDraft(storageRef.current.getItem(draftStorageKey)),
          ...(ontos ? { paymentId: demoPayment.id } : {}),
        },
        error: "",
      });
    } catch {
      checkoutDispatch({
        type: "hydrate",
        draft: { ...createCheckoutDraft(), ...(ontos ? { paymentId: demoPayment.id } : {}) },
        error: "Rozpracované údaje nelze uložit v prohlížeči. Povolte úložiště pro tento web.",
      });
    }
  }, [storage, draftStorageKey, ontos]);

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
    const payment = getPayment(draft);
    if (!delivery || !payment) return null;

    let orderNumber: string | undefined;
    let serverTotals: { totalMinor?: number; totalVatMinor?: number } | undefined;
    if (ontos) {
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
            body: JSON.stringify({ cart }),
          });
          const check = await readCheckoutQuote(checkResponse);
          if (!check.canCheckout)
            throw new Error(
              check.priceChanged
                ? "Cena se změnila – přijmout novou cenu v ověření košíku a zkusit znovu."
                : "Košík nyní nelze ověřit. Vraťte se do košíku a zkontrolujte dostupnost a množství.",
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
        orderNumber = result.orderNumber;
        serverTotals = result;
      } catch (error) {
        checkoutDispatch({
          type: "submit-error",
          error:
            error instanceof Error &&
            (error.message.startsWith("Cena se změnila") ||
              error.message.startsWith("Košík nyní nelze ověřit"))
              ? error.message
              : checkoutSaveError,
        });
        return null;
      }
    }
    const totals = getCheckoutTotals(cart, draft, ontos);
    if (serverTotals?.totalMinor !== undefined) {
      totals.total = serverTotals.totalMinor;
      if (serverTotals.totalVatMinor !== undefined) {
        totals.vat = serverTotals.totalVatMinor;
        totals.net = totals.total - totals.vat;
      }
    }
    const order: LocalOrder = {
      version: 1,
      id: orderNumber ?? `DEMO-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      createdAt: new Date().toISOString(),
      cart: structuredClone(cart),
      draft: structuredClone(draft),
      deliveryTitle: delivery.title,
      paymentTitle: payment.title,
      paymentStatus: "not-processed",
      totals,
      ...(orderNumber ? { source: "ontos" as const } : {}),
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
        storageError: submitError || storageError,
        updateDraft: (update) =>
          checkoutDispatch({
            type: "update",
            update: (current) => ({
              ...update(current),
              ...(ontos ? { paymentId: demoPayment.id } : {}),
            }),
          }),
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

export function useCheckout() {
  const value = useContext(CheckoutContext);
  if (!value) throw new Error("useCheckout must be used inside CheckoutProvider");
  return value;
}
