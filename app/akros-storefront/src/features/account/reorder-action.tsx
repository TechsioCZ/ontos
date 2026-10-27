"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import StoreLink from "@/components/store-link";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { useCart } from "@/features/cart/cart-provider";
import type { CartItemSnapshot } from "@/features/cart/cart-state";
import type { CatalogPriceTier } from "@/ontos/catalog-types";

export function ReorderAction({ orderId, children }: { orderId: string; children?: ReactNode }) {
  const { addItem, adding, activeCartId } = useCart();
  const activeCart = useRef<string | null>(activeCartId);
  useEffect(() => {
    activeCart.current = activeCartId;
    return () => {
      activeCart.current = null;
    };
  }, [activeCartId]);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [added, setAdded] = useState(false);
  async function reorder() {
    if (pending || adding) return;
    setPending(true);
    setMessage("");
    setAdded(false);
    try {
      const response = await fetch(
        `/api/ontos/orders/reorder?${new URLSearchParams({ order: orderId })}`,
        { cache: "no-store" },
      );
      const result = (await response.json()) as {
        items?: { item: CartItemSnapshot; quantity: number; priceTiers: CatalogPriceTier[] }[];
        skipped?: number;
        adjusted?: number;
        message?: string;
      };
      if (!response.ok || !Array.isArray(result.items)) {
        setMessage(result.message ?? "Položky se nepodařilo ověřit.");
        return;
      }
      let count = 0;
      for (const entry of result.items) {
        if (activeCart.current !== activeCartId) break;
        // A rejected quote can also mean the user switched carts. Stop this batch
        // rather than applying its remaining items to a different active cart.
        if (!(await addItem(entry.item, entry.quantity, entry.priceTiers))) break;
        count++;
      }
      setAdded(count > 0);
      const skipped = (result.skipped ?? 0) + result.items.length - count;
      setMessage(
        `Přidáno položek: ${count}.${skipped ? ` Nepřidáno: ${skipped}.` : ""}${result.adjusted ? ` Množství upraveno podle dostupnosti a balení u ${result.adjusted} položek.` : ""}`,
      );
    } catch {
      setMessage("Objednávku se nepodařilo zopakovat.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="grid min-w-0 justify-items-start gap-(--dimension-8)">
      <div className="akros-order-actions">
        <Button
          size="sm"
          type="button"
          variant="primary"
          disabled={pending || adding}
          onClick={reorder}
        >
          {pending ? "Ověřuji položky…" : "Objednat znovu"}
        </Button>
        {added && (
          <LinkButton as={StoreLink} href="/kosik" size="sm" theme="borderless" variant="secondary">
            Přejít do košíku
          </LinkButton>
        )}
        {children}
      </div>
      {message && <output className="max-w-(--dimension-320) text-sm">{message}</output>}
    </div>
  );
}
