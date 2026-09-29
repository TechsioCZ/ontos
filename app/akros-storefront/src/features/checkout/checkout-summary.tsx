"use client";
import { useCart } from "@/features/cart/cart-provider";
import { useCheckout } from "./checkout-provider";
import { getCheckoutTotals } from "@/mock-storefront/checkout";
import { formatPrice } from "@/lib/format";

export function CheckoutSummary() {
  const { cart } = useCart();
  const { draft } = useCheckout();
  const totals = getCheckoutTotals(cart, draft);
  return (
    <aside className="rounded-sm bg-(--color-base) p-6" aria-labelledby="checkout-summary-title">
      <h2 id="checkout-summary-title" className="mb-6 text-md font-medium">
        Shrnutí
      </h2>
      <dl className="grid gap-4 text-sm">
        <div className="grid gap-1 border-b border-(--color-border-primary) pb-4">
          <div className="flex justify-between gap-3">
            <dt>Cena zboží</dt>
            <dd>{formatPrice(totals.subtotal)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>Doprava a platba</dt>
            <dd>
              {totals.shipping === null
                ? "Bude vybráno"
                : formatPrice(totals.shipping + totals.payment)}
            </dd>
          </div>
        </div>
        <div className="grid gap-1 border-b border-(--color-border-primary) pb-4">
          <div className="flex justify-between gap-3">
            <dt>DPH</dt>
            <dd>{totals.vat === null ? "—" : formatPrice(totals.vat)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>Celkem bez DPH</dt>
            <dd>{totals.net === null ? "—" : formatPrice(totals.net)}</dd>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <dt>Celkem s DPH</dt>
          <dd className="text-lg font-extrabold" aria-live="polite">
            {formatPrice(totals.total)}
          </dd>
        </div>
      </dl>
      {totals.net === null && (
        <p className="mt-3 text-xs text-(--color-fg-secondary)">
          U dříve uložených položek není dostupná cena bez DPH.
        </p>
      )}
    </aside>
  );
}
