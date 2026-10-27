"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { useCart } from "@/features/cart/cart-provider";
import { useCheckoutDeliveryId } from "@/features/checkout/checkout-provider";
import {
  getCartSubtotal,
  getLineTotal,
  formatQuantity,
  type CartState,
} from "@/features/cart/cart-state";
import { formatPrice } from "@/lib/format";

const cartLabel = "Aktuální ceny a dostupnost z OntOS";

interface QuoteLineIssue {
  productId: string;
  variantId?: string;
  code: string;
  message: string;
}
interface QuoteTotals {
  totalMinor: number;
  totalVatMinor: number;
  netMinor: number;
  shippingMinor: number | null;
}
export interface Quote {
  cart: CartState;
  priceChanged: boolean;
  issues: string[];
  lineIssues?: QuoteLineIssue[];
  canCheckout: boolean;
  totals?: QuoteTotals | null;
}

export interface CartQuoteState {
  /** false until the cart is loaded and for an empty cart: nothing to verify, nothing blocked. */
  enabled: boolean;
  status: "checking" | "ready" | "error";
  quote: Quote | null;
  error: string;
  retry: () => void;
  /** true only when OntOS confirmed the exact cart (price, availability, quantities and totals). */
  canContinue: boolean;
  /** Short reason shown next to a disabled continue action. */
  blockedReason: string;
  lineIssues: (productId: string, variantId?: string) => QuoteLineIssue[];
}

const CartQuoteContext = createContext<CartQuoteState | null>(null);

const quoteFailure = "Ověření košíku v OntOS se nepodařilo. Košík zůstává zachovaný.";

/** One shared OntOS cart verification for every checkout step: the cart, steps and summary read it. */
export function CartQuoteProvider({ children }: { children: ReactNode }) {
  const { cart, ready, dispatch } = useCart();
  const [verified, setVerified] = useState<{
    quote: Quote;
    startedAt: number;
    fingerprint: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const enabled = ready && cart.lines.length > 0;
  const deliveryId = useCheckoutDeliveryId();
  const fingerprint = JSON.stringify({ cart, deliveryId });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let busy = false;
    const load = async () => {
      if (busy || document.visibilityState === "hidden") return;
      busy = true;
      const startedAt = Date.now();
      try {
        const response = await fetch("/api/ontos/cart", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cart, deliveryId }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]),
          cache: "no-store",
        });
        const body = await response.json();
        if (
          !response.ok ||
          typeof body?.canCheckout !== "boolean" ||
          !body.cart ||
          !Array.isArray(body.issues)
        )
          throw new Error(quoteFailure);
        if (controller.signal.aborted) return;
        setVerified({
          quote: body,
          startedAt,
          fingerprint: body.canCheckout
            ? JSON.stringify({ cart: body.cart, deliveryId })
            : fingerprint,
        });
        setError("");
        if (body.canCheckout && JSON.stringify(body.cart) !== JSON.stringify(cart))
          dispatch({ type: "revalidate", cart: body.cart });
      } catch {
        if (!controller.signal.aborted) setError(quoteFailure);
      } finally {
        busy = false;
      }
    };
    const timer = window.setTimeout(load, 100);
    // Refresh ahead of expiry without clearing the still-fresh quote (no blinking prices).
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
      window.clearTimeout(timer);
      window.clearInterval(refresh);
      window.clearInterval(clock);
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [cart, enabled, deliveryId, fingerprint, attempt, dispatch]);
  const quote =
    verified?.fingerprint === fingerprint && now - verified.startedAt < 9_750
      ? verified.quote
      : null;
  const status: CartQuoteState["status"] = quote ? "ready" : error ? "error" : "checking";
  const canContinue = !enabled || (status === "ready" && quote!.canCheckout);
  const value: CartQuoteState = {
    enabled,
    status,
    quote,
    error,
    retry: () => setAttempt((n) => n + 1),
    canContinue,
    blockedReason: canContinue
      ? ""
      : status === "checking"
        ? "Počkejte, ověřuji košík v OntOS…"
        : status === "error"
          ? "Pokračovat lze až po úspěšném ověření košíku."
          : quote?.priceChanged
            ? "Nejprve potvrďte nové ceny."
            : "Nejprve vyřešte položky, které nelze objednat.",
    lineIssues: (productId, variantId) =>
      (quote?.lineIssues ?? []).filter(
        (issue) =>
          issue.productId === productId &&
          (issue.variantId ?? undefined) === (variantId ?? undefined),
      ),
  };
  return <CartQuoteContext.Provider value={value}>{children}</CartQuoteContext.Provider>;
}

/** null outside the checkout (or in tests without a provider): callers behave as before. */
export function useCartQuote(): CartQuoteState | null {
  return useContext(CartQuoteContext);
}

export function CartRevalidation() {
  const { cart, dispatch } = useCart();
  const state = useCartQuote();
  if (!cart.lines.length || !state) return null;
  const { quote, error, status, retry } = state;
  return (
    <section
      aria-live="polite"
      className="mb-(--dimension-16) grid gap-2 rounded-sm bg-(--color-base) p-4 text-sm"
      aria-label="Ověření košíku v OntOS"
      data-akros-cart-quote={status}
    >
      <p className="font-bold" data-akros-cart-label>
        {cartLabel}
      </p>
      {status === "error" ? (
        <div role="alert" className="grid gap-3 border-l-4 border-(--color-danger) pl-3">
          <p className="font-bold">Ceny a dostupnost se teď nepodařilo ověřit.</p>
          <p>{error} Pokračovat k dopravě a platbě lze až po úspěšném ověření.</p>
          <Button type="button" size="sm" variant="primary" className="w-fit" onClick={retry}>
            Zkusit znovu
          </Button>
        </div>
      ) : status === "checking" ? (
        <p>Ověřuji aktuální cenu a dostupnost v OntOS…</p>
      ) : (
        <>
          {quote!.issues.length > 0 && (
            <div role="alert" className="grid gap-2 border-l-4 border-(--color-danger) pl-3">
              <p className="font-bold">Objednávku teď nelze dokončit</p>
              <ul className="grid gap-1">
                {quote!.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
              <p>
                Upravte množství nebo blokované položky z košíku odeberte. Pokračovat lze, až OntOS
                potvrdí celý košík.
              </p>
            </div>
          )}
          {quote!.priceChanged ? (
            <div role="alert">
              <p className="font-bold">Cena se změnila – přijmout novou cenu</p>
              <p>
                Ceny s DPH. Nové ceny použijeme až po vašem souhlasu; objednávka se zatím
                neodeslala.
              </p>
              <ul className="my-4 grid gap-4">
                {quote!.cart.lines.map((next) => {
                  const previous = cart.lines.find(
                    (line) =>
                      line.productId === next.productId && line.variantId === next.variantId,
                  );
                  if (!previous || previous.priceMinor === next.priceMinor) return null;
                  return (
                    <li
                      key={`${next.productId}:${next.variantId ?? ""}`}
                      className="min-w-0 wrap-anywhere"
                    >
                      <p className="font-bold">
                        {next.name}
                        {next.variantLabel ? ` – ${next.variantLabel}` : ""}
                      </p>
                      <p>
                        Za {next.unit}: {formatPrice(previous.priceMinor)} →{" "}
                        <strong>{formatPrice(next.priceMinor)}</strong>
                      </p>
                      <p>
                        Za {formatQuantity(next.quantity)} {next.unit}:{" "}
                        {formatPrice(getLineTotal(previous))} →{" "}
                        <strong>{formatPrice(getLineTotal(next))}</strong>
                      </p>
                    </li>
                  );
                })}
              </ul>
              <p className="mb-4 font-bold">
                Celkem za zboží: {formatPrice(getCartSubtotal(cart))} →{" "}
                {formatPrice(getCartSubtotal(quote!.cart))}
              </p>
              <Button
                type="button"
                size="sm"
                onClick={() => dispatch({ type: "revalidate", cart: quote!.cart })}
              >
                Přijmout nové ceny
              </Button>
            </div>
          ) : quote!.canCheckout ? (
            <p>Ceny, množství a dostupnost byly ověřeny v OntOS.</p>
          ) : !quote!.issues.length ? (
            <div role="alert" className="grid gap-3">
              <p>OntOS košík nepotvrdil. {quoteFailure}</p>
              <Button type="button" size="sm" variant="primary" className="w-fit" onClick={retry}>
                Zkusit znovu
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
