"use client";
import { useDataSource } from "@/ontos/catalog-provider";
import { useCart } from "@/features/cart/cart-provider";
import { useCheckout } from "./checkout-provider";
import { getCheckoutTotals } from "@/mock-storefront/checkout";
import { formatCheckoutPrice } from "./checkout-format";

export function CheckoutSummary() {
  const ontos = useDataSource() === "ontos";
  const { cart } = useCart();
  const { draft } = useCheckout();
  const totals = getCheckoutTotals(cart, draft, ontos);
  return (
    <aside
      className="rounded-sm bg-(--color-base) px-(--dimension-32) py-(--dimension-24)"
      aria-labelledby="checkout-summary-title"
    >
      <h2
        id="checkout-summary-title"
        className="mb-(--dimension-32) text-(length:--akros-checkout-heading-size) leading-(--akros-checkout-heading-leading) font-medium"
      >
        Shrnutí
      </h2>
      <dl className="grid gap-(--dimension-24) text-(length:--dimension-16) font-medium">
        <div className="grid gap-1 border-b border-(--color-border-primary) pb-4">
          <div className="flex justify-between gap-3">
            <dt>Cena celkem</dt>
            <dd className="text-right">{formatCheckoutPrice(totals.subtotal)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>Doprava a platba</dt>
            <dd className="text-right">
              {totals.shipping === null
                ? "Bude vybráno"
                : formatCheckoutPrice(totals.shipping + totals.payment)}
            </dd>
          </div>
          {totals.extendedReturn > 0 && (
            <div className="flex justify-between gap-3">
              <dt>Prodloužená doba vrácení</dt>
              <dd className="text-right">{formatCheckoutPrice(totals.extendedReturn)}</dd>
            </div>
          )}
        </div>
        <div className="grid gap-1 border-b border-(--color-border-primary) pb-4">
          <div className="flex justify-between gap-3">
            <dt>DPH</dt>
            <dd className="text-right">
              {totals.vat === null ? "—" : formatCheckoutPrice(totals.vat)}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>Celkem bez daně</dt>
            <dd className="text-right">
              {totals.net === null ? "—" : formatCheckoutPrice(totals.net)}
            </dd>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <dt className="text-(length:--dimension-20)">Celkem s DPH</dt>
          <dd
            className="text-(length:--akros-checkout-total-size) leading-(--akros-checkout-heading-leading) font-extrabold"
            aria-live="polite"
          >
            {formatCheckoutPrice(totals.total)}
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
