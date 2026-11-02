"use client";
import { useRef, useState } from "react";
import StoreLink from "@/components/store-link";
import { useRouter } from "next/navigation";
import { useDictionary, useMoney, useStoreHref } from "@/ontos/market-context";
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

export function ReviewStep() {
  const money = useMoney();
  const { checkout } = useDictionary();
  const copy = checkout.review;
  const { cart } = useCart();
  const { draft, methods, accountEmail, completeOrder, submitted, storageError } = useCheckout();
  const router = useRouter();
  const storeHref = useStoreHref();
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const server = useServerTotals(getCheckoutTotals(cart, draft, methods));
  const totals = server.totals;
  const quote = useCartQuote();
  const blocked = quote ? !quote.canContinue : false;
  return (
    <form
      data-sf-checkout-review
      onSubmit={async (event) => {
        event.preventDefault();
        // A ref locks synchronously: a fast double/triple click never sends a second request.
        if (sendingRef.current) return;
        sendingRef.current = true;
        setSending(true);
        try {
          const order = await completeOrder();
          if (order)
            router.push(
              storeHref(`/potvrzeni-objednavky?order=${encodeURIComponent(order.orderId)}`),
            );
        } finally {
          sendingRef.current = false;
          setSending(false);
        }
      }}
    >
      <section className="rounded-sm bg-(--color-base) p-4 md:p-6" aria-labelledby="review-title">
        <h1
          id="review-title"
          className="mb-4 text-(length:--sf-checkout-heading-size) leading-(--sf-checkout-heading-leading) font-medium"
        >
          {checkout.steps.summary}
        </h1>
        <CartItemsTable showHeader />
        <dl className="divide-y divide-(--color-border-primary) border-b border-(--color-border-primary) text-sm">
          <div className="flex justify-between gap-4 py-4">
            <dt className="grid gap-2">
              <span>{copy.deliveryMethod(getDelivery(draft, methods)?.title ?? "")}</span>
              <span>{getDeliveryLocation(draft)}</span>
              <Link as={StoreLink} href="/kosik/doprava-platba" className="w-fit">
                {copy.changeDelivery}
              </Link>
            </dt>
            <dd className="whitespace-nowrap">
              {totals.shipping === 0
                ? checkout.delivery.free
                : formatPrice(totals.shipping ?? 0, money)}
            </dd>
          </div>
          <div className="flex justify-between gap-4 py-4">
            <dt>{checkout.delivery.paymentTitle}</dt>
            <dd>{checkout.delivery.noOnlinePayment}</dd>
          </div>
          <div className="flex justify-between gap-4 py-4">
            <dt>{copy.netPrice}</dt>
            <dd>{totals.net !== null ? formatPrice(totals.net, money) : copy.netPending}</dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-4 py-4">
            <dt>{copy.totalWithVat}</dt>
            <dd className="text-(length:--sf-checkout-body-size) font-extrabold" aria-live="polite">
              {formatPrice(totals.total, money)}
            </dd>
          </div>
        </dl>
        <div className="grid gap-6 py-6 sm:grid-cols-2">
          <section aria-labelledby="billing-review-title">
            <h2
              id="billing-review-title"
              className="mb-4 text-(length:--sf-checkout-heading-size) leading-(--sf-checkout-heading-leading) font-medium"
            >
              {copy.billingTitle}
            </h2>
            <AddressText address={draft.billing} />
            <div className="text-sm leading-(--sf-checkout-body-leading)">
              <p>{draft.email}</p>
              <p>{draft.company}</p>
              {draft.companyId && <p>{checkout.address.companyIdValue(draft.companyId)}</p>}
              {draft.vatId && <p>{checkout.address.vatIdValue(draft.vatId)}</p>}
            </div>
          </section>
          <section aria-labelledby="delivery-review-title">
            <h2
              id="delivery-review-title"
              className="mb-4 text-(length:--sf-checkout-heading-size) leading-(--sf-checkout-heading-leading) font-medium"
            >
              {checkout.steps.address}
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
          data-sf-checkout-action
          className="leading-(--sf-checkout-heading-leading)"
          variant="secondary"
          size="sm"
          uppercase
        >
          {copy.back}
        </LinkButton>
        <div className="grid max-w-sm gap-3">
          {storageError && (
            <p
              role="alert"
              className="rounded-sm border border-(--color-danger) p-4 text-sm text-(--color-danger)"
            >
              {storageError}
            </p>
          )}
          <p
            role="note"
            className="rounded-sm border border-(--color-border-primary) bg-(--color-base) p-4 text-sm font-bold"
          >
            {copy.ontosNote}
          </p>
          <Button
            type="submit"
            data-sf-checkout-action
            className="leading-(--sf-checkout-heading-leading)"
            variant="primary"
            size="sm"
            uppercase
            disabled={sending || submitted || !cart.lines.length || blocked}
            aria-describedby={blocked ? "review-blocked" : undefined}
          >
            {sending ? copy.sending : copy.submit}
          </Button>
          {blocked && (
            <p id="review-blocked" className="text-center text-xs text-(--color-fg-secondary)">
              {quote?.blockedReason}
            </p>
          )}
          <p className="text-center text-xs text-(--color-fg-secondary)">
            {accountEmail ? copy.accountNote : copy.guestNote(draft.email)}
          </p>
        </div>
      </div>
    </form>
  );
}
