"use client";
import { useRef, useState } from "react";
import StoreLink from "@/components/store-link";
import { useRouter } from "next/navigation";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { Link } from "@techsio/ui-kit/atoms/link";
import { useCart } from "@/features/cart/cart-provider";
import { useCheckout } from "./checkout-provider";
import { CartItemsTable } from "./cart-items-table";
import { AddressText } from "./address-fields";
import {
  getCheckoutTotals,
  getDelivery,
  getDeliveryAddress,
  getDeliveryLocation,
} from "@/features/checkout/checkout-state";
import { formatPrice } from "@/lib/format";
import { useCartQuote } from "@/ontos/cart-revalidation";
import { useServerTotals } from "./server-totals";
import { cs } from "@/i18n/cs";

export function ReviewStep() {
  const { cart } = useCart();
  const { draft, methods, accountEmail, completeOrder, submitted, storageError } = useCheckout();
  const router = useRouter();
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const server = useServerTotals(getCheckoutTotals(cart, draft, methods));
  const totals = server.totals;
  const quote = useCartQuote();
  const blocked = quote ? !quote.canContinue : false;
  return (
    <form
      data-akros-checkout-review
      onSubmit={async (event) => {
        event.preventDefault();
        // A ref locks synchronously: a fast double/triple click never sends a second request.
        if (sendingRef.current) return;
        sendingRef.current = true;
        setSending(true);
        try {
          const order = await completeOrder();
          if (order)
            router.push(`/potvrzeni-objednavky?order=${encodeURIComponent(order.orderId)}`);
        } finally {
          sendingRef.current = false;
          setSending(false);
        }
      }}
    >
      <section className="rounded-sm bg-(--color-base) p-4 md:p-6" aria-labelledby="review-title">
        <h1
          id="review-title"
          className="mb-4 text-(length:--akros-checkout-heading-size) leading-(--akros-checkout-heading-leading) font-medium"
        >
          Shrnutí objednávky
        </h1>
        <CartItemsTable showHeader />
        <dl className="divide-y divide-(--color-border-primary) border-b border-(--color-border-primary) text-sm">
          <div className="flex justify-between gap-4 py-4">
            <dt className="grid gap-2">
              <span>Způsob dopravy – {getDelivery(draft, methods)?.title}</span>
              <span>{getDeliveryLocation(draft)}</span>
              <Link as={StoreLink} href="/kosik/doprava-platba" className="w-fit">
                Změnit dopravu
              </Link>
            </dt>
            <dd className="whitespace-nowrap">
              {totals.shipping === 0 ? "Zdarma" : formatPrice(totals.shipping ?? 0)}
            </dd>
          </div>
          <div className="flex justify-between gap-4 py-4">
            <dt>Platba</dt>
            <dd>Objednávka bez online platby</dd>
          </div>
          <div className="flex justify-between gap-4 py-4">
            <dt>Cena bez DPH</dt>
            <dd>
              {totals.net !== null ? formatPrice(totals.net) : "Spočítá OntOS po ověření košíku"}
            </dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-4 py-4">
            <dt>Celková cena s DPH</dt>
            <dd
              className="text-(length:--akros-checkout-body-size) font-extrabold"
              aria-live="polite"
            >
              {formatPrice(totals.total)}
            </dd>
          </div>
        </dl>
        <div className="grid gap-6 py-6 sm:grid-cols-2">
          <section aria-labelledby="billing-review-title">
            <h2
              id="billing-review-title"
              className="mb-4 text-(length:--akros-checkout-heading-size) leading-(--akros-checkout-heading-leading) font-medium"
            >
              Fakturační údaje
            </h2>
            <AddressText address={draft.billing} />
            <div className="text-sm leading-(--akros-checkout-body-leading)">
              <p>{draft.email}</p>
              <p>{draft.company}</p>
              {draft.companyId && <p>IČ: {draft.companyId}</p>}
              {draft.vatId && <p>DIČ: {draft.vatId}</p>}
            </div>
          </section>
          <section aria-labelledby="delivery-review-title">
            <h2
              id="delivery-review-title"
              className="mb-4 text-(length:--akros-checkout-heading-size) leading-(--akros-checkout-heading-leading) font-medium"
            >
              Dodací údaje
            </h2>
            <AddressText address={getDeliveryAddress(draft)} />
            <p className="text-sm">{draft.email}</p>
          </section>
        </div>
      </section>
      <div className="mt-6 flex flex-wrap items-start justify-between gap-4">
        <LinkButton
          as={StoreLink}
          href="/kosik/dodaci-udaje"
          data-akros-checkout-action
          className="leading-(--akros-checkout-heading-leading)"
          variant="secondary"
          size="sm"
          uppercase
        >
          Zpět k dodacím údajům
        </LinkButton>
        <div className="grid w-full gap-(--dimension-12) sm:max-w-(--akros-checkout-continue-width)">
          {!accountEmail && (
            <StoreLink className="underline" href="/prihlaseni">
              Před objednáním se přihlaste
            </StoreLink>
          )}
          <Button
            type="submit"
            data-akros-checkout-action
            className="leading-(--akros-checkout-heading-leading)"
            variant="primary"
            size="sm"
            uppercase
            disabled={sending || submitted || !cart.lines.length || blocked || !accountEmail}
            aria-describedby={`review-order-information${blocked ? " review-blocked" : ""}${storageError ? " review-submit-error" : ""}`}
          >
            {sending ? "Odesílám do OntOS…" : "Odeslat objednávku"}
          </Button>
          {storageError && (
            <p id="review-submit-error" role="alert" className="text-sm text-(--color-danger)">
              {storageError}
            </p>
          )}
          {blocked && (
            <p id="review-blocked" className="text-center text-xs text-(--color-fg-secondary)">
              {quote?.blockedReason}
            </p>
          )}
          <div
            id="review-order-information"
            className="grid gap-(--dimension-4) text-center text-xs text-(--color-fg-secondary)"
          >
            <p>{cs.checkout.noOnlinePayment}</p>
            <p>{cs.checkout.orderTrackingInformation}</p>
          </div>
        </div>
      </div>
    </form>
  );
}
