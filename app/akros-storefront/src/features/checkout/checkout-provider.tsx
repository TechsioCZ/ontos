"use client";
import {
  CheckoutStockError,
  CheckoutPriceError,
  checkoutSaveError,
  readCheckoutQuote,
  readOrderResponse,
} from "@/ontos/checkout-response";

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { useCart } from "@/features/cart/cart-provider";
import {
  type CheckoutDraft,
  type DeliveryMethod,
  createCheckoutDraft,
  getReachableStep,
  parseCheckoutDraft,
} from "@/features/checkout/checkout-state";

const isError = (value: unknown): value is Error =>
  value !== null && value !== undefined && Error.prototype.isPrototypeOf(value);
const isCheckoutStockError = (value: unknown): value is CheckoutStockError =>
  value !== null && value !== undefined && CheckoutStockError.prototype.isPrototypeOf(value);
const isCheckoutPriceError = (value: unknown): value is CheckoutPriceError =>
  value !== null && value !== undefined && CheckoutPriceError.prototype.isPrototypeOf(value);

export interface PlacedOrder {
  id: string;
  orderId: string;
}

const draftKey = "akros-checkout-v2";
type DraftUpdate = (draft: CheckoutDraft) => CheckoutDraft;
type CheckoutStorage = Pick<Storage, "getItem" | "setItem">;

interface CheckoutContextValue {
  draft: CheckoutDraft;
  methods: DeliveryMethod[];
  methodsError: string;
  accountEmail: string | null;
  accountReady: boolean;
  ready: boolean;
  storageError: string;
  submitted: boolean;
  updateDraft: (update: DraftUpdate) => void;
  completeOrder: () => Promise<PlacedOrder | null>;
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
  const draftStorageKey = activeCartId === "default" ? draftKey : `${draftKey}:${activeCartId}`;
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
  const [options, setOptions] = useState<{ methods: DeliveryMethod[]; loadedAt: number }>({
    methods: [],
    loadedAt: 0,
  });
  const [methodsError, setMethodsError] = useState("");
  const [now, setNow] = useState(Date.now);
  const [accountReady, setAccountReady] = useState(false);
  const [accountEmail, setAccountEmail] = useState<string | null>(null);
  const methods = now - options.loadedAt < 9_750 ? options.methods : [];
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    const load = async () => {
      if (busy || document.visibilityState === "hidden") return;
      busy = true;
      const started = Date.now();
      try {
        const response = await fetch("/api/ontos/checkout", {
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]),
        });
        const body = await response.json();
        if (!response.ok || !Array.isArray(body.shippingMethods))
          throw new Error("Možnosti dopravy nyní nelze ověřit v OntOS.");
        if (!controller.signal.aborted) {
          setOptions({ methods: body.shippingMethods, loadedAt: started });
          setMethodsError("");
        }
      } catch {
        if (!controller.signal.aborted)
          setMethodsError("Možnosti dopravy nyní nelze ověřit v OntOS.");
      } finally {
        busy = false;
      }
    };
    void load();
    const refresh = window.setInterval(load, 7_000);
    const clock = window.setInterval(() => setNow(Date.now()), 250);
    const visible = () => {
      setNow(Date.now());
      void load();
    };
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller.abort();
      window.clearInterval(refresh);
      window.clearInterval(clock);
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/ontos/account", {
      cache: "no-store",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]),
    })
      .then(async (response) => {
        if (!response.ok) return;
        const { account } = await response.json();
        if (controller.signal.aborted || !account?.email) return;
        setAccountEmail(account.email);
        checkoutDispatch({
          type: "update",
          update: (current) => ({ ...current, email: account.email }),
        });
      })
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setAccountReady(true);
      });
    return () => controller.abort();
  }, []);
  const storageRef = useRef<CheckoutStorage | null>(null);
  const completed = useRef<PlacedOrder | null>(null);

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

  async function completeOrder(): Promise<PlacedOrder | null> {
    if (completed.current) return completed.current;
    checkoutDispatch({ type: "submit-error", error: "" });
    if (!hydrated || !cartReady || getReachableStep(3, cart, draft, methods) !== 3) return null;
    if (!accountEmail) {
      checkoutDispatch({
        type: "submit-error",
        error: "Před objednáním se přihlaste ke svému účtu.",
      });
      return null;
    }

    let order: PlacedOrder;
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
      order = { id: result.orderNumber, orderId: result.orderId };
    } catch (error) {
      checkoutDispatch({
        type: "submit-error",
        error:
          isCheckoutStockError(error) ||
          isCheckoutPriceError(error) ||
          (isError(error) &&
            (error.message.startsWith("Cena se změnila") ||
              error.message.startsWith("Košík nyní nelze ověřit")))
            ? error.message
            : checkoutSaveError,
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
        methods,
        methodsError,
        accountEmail,
        accountReady,
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
