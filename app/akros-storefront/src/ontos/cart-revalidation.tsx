"use client";
import { useEffect, useState } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { useCart } from "@/features/cart/cart-provider";
import { useDataSource } from "./catalog-provider";
import type { CartState } from "@/mock-storefront/cart";
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
                Aktuální ceny budou přeneseny z OntOS do tohoto košíku. Objednávka se zatím
                neodeslala.
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
