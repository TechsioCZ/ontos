"use client";
import { useEffect, useState } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { useCart } from "@/features/cart/cart-provider";
import { useDataSource } from "./catalog-provider";
import {
  getCartSubtotal,
  getLineTotal,
  formatQuantity,
  type CartState,
} from "@/mock-storefront/cart";
import { formatPrice } from "@/lib/format";
interface Quote {
  cart: CartState;
  priceChanged: boolean;
  issues: string[];
  canCheckout: boolean;
}
export function CartRevalidation() {
  const mode = useDataSource();
  const { cart, ready, dispatch } = useCart();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (mode !== "ontos" || !ready || !cart.lines.length) return;
    const controller = new AbortController();
    setQuote(null);
    const timer = setTimeout(() => {
      fetch("/api/ontos/cart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cart }),
        signal: controller.signal,
      })
        .then(async (r) => {
          const body = await r.json();
          if (!r.ok) throw new Error(body.message);
          if (controller.signal.aborted) return;
          setQuote(body);
          if (body.canCheckout && JSON.stringify(body.cart) !== JSON.stringify(cart))
            dispatch({ type: "revalidate", cart: body.cart });
          setError("");
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message || "Dostupnost nelze ověřit.");
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [cart, ready, mode]);
  if (mode !== "ontos" || !cart.lines.length) return null;
  return (
    <section aria-live="polite" className="p-4 text-sm" aria-label="Ověření košíku v OntOS">
      {error ? (
        <p role="alert">{error}</p>
      ) : !quote ? (
        <p>Ověřuji aktuální cenu a dostupnost v OntOS…</p>
      ) : (
        <>
          {quote.issues.map((issue) => (
            <p role="alert" key={issue}>
              {issue}
            </p>
          ))}
          {quote.priceChanged ? (
            <div role="alert">
              <p className="font-bold">Cena se změnila – přijmout novou cenu</p>
              <p>
                Ceny s DPH. Nové ceny použijeme až po vašem souhlasu; objednávka se zatím
                neodeslala.
              </p>
              <ul className="my-4 grid gap-4">
                {quote.cart.lines.map((next) => {
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
                {formatPrice(getCartSubtotal(quote.cart))}
              </p>
              <Button
                type="button"
                size="sm"
                onClick={() => dispatch({ type: "revalidate", cart: quote.cart })}
              >
                Přijmout nové ceny
              </Button>
            </div>
          ) : !quote.issues.length ? (
            <p>Ceny, množství a dostupnost byly ověřeny v OntOS.</p>
          ) : null}
        </>
      )}
    </section>
  );
}
