"use client";
import { useRef, useState } from "react";
import StoreLink from "@/components/store-link";
import { useRouter } from "next/navigation";
import { useDictionary, useMoney, useStoreHref } from "@/ontos/market-context";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { Link } from "@techsio/ui-kit/atoms/link";
import { StatusText } from "@techsio/ui-kit/atoms/status-text";
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
  const cs = useDictionary();
  const { checkout } = cs;
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
      <section
        className="sf-checkout-panel sf-checkout-review-panel"
        aria-labelledby="review-title"
      >
        <h1 id="review-title" className="sf-checkout-section-heading">
          {checkout.steps.summary}
        </h1>
        <CartItemsTable showHeader />
        <dl className="sf-checkout-compact-copy divide-y divide-(--color-border-primary) border-b border-(--color-border-primary)">
          <div className="sf-checkout-review-detail">
            <dt className="grid gap-2">
              <span>{copy.deliveryMethod(getDelivery(draft, methods)?.title ?? "")}</span>
              <span>{getDeliveryLocation(draft)}</span>
              <Link as={StoreLink} href="/kosik/doprava-platba" className="w-fit" size="current">
                {copy.changeDelivery}
              </Link>
            </dt>
            <dd className="whitespace-nowrap">
              {totals.shipping === 0
                ? checkout.delivery.free
                : formatPrice(totals.shipping ?? 0, money)}
            </dd>
          </div>
          <div className="sf-checkout-review-detail">
            <dt>{checkout.delivery.paymentTitle}</dt>
            <dd>{checkout.delivery.noOnlinePayment}</dd>
          </div>
          <div className="sf-checkout-review-detail">
            <dt>{copy.netPrice}</dt>
            <dd>{totals.net !== null ? formatPrice(totals.net, money) : copy.netPending}</dd>
          </div>
          <div className="sf-checkout-review-detail flex-wrap">
            <dt>{copy.totalWithVat}</dt>
            <dd className="text-(length:--sf-checkout-body-size) font-extrabold" aria-live="polite">
              {formatPrice(totals.total, money)}
            </dd>
          </div>
        </dl>
        <div className="sf-checkout-review-addresses sf-checkout-compact-copy wrap-anywhere">
          <section aria-labelledby="billing-review-title">
            <h2
              id="billing-review-title"
              className="mb-4 text-(length:--sf-checkout-heading-size) leading-(--sf-checkout-heading-leading) font-medium"
            >
              {copy.billingTitle}
            </h2>
            <AddressText address={draft.billing} />
            <div>
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
            <p>{draft.email}</p>
          </section>
        </div>
      </section>
      <div className="sf-checkout-actions">
        <LinkButton
          as={StoreLink}
          href="/kosik/dodaci-udaje"
          data-sf-checkout-action
          className="sf-checkout-back"
          variant="secondary"
          size="sm"
          uppercase
        >
          {copy.back}
        </LinkButton>
        <div className="sf-checkout-next sf-checkout-compact-copy">
          {storageError && (
            <StatusText role="alert" size="sm" status="error">
              {storageError}
            </StatusText>
          )}
          <Button
            type="submit"
            data-sf-checkout-action
            variant="primary"
            size="sm"
            uppercase
            disabled={sending || submitted || !cart.lines.length || blocked}
            aria-describedby={blocked ? "review-blocked" : undefined}
          >
            {sending ? copy.sending : copy.submit}
          </Button>
          {blocked && (
            <StatusText id="review-blocked" size="sm" status="error">
              {quote?.blockedReason}
            </StatusText>
          )}
          <div className="sf-checkout-review-guidance">
            <StatusText role="note" size="sm">
              {copy.ontosNote}
            </StatusText>
            <StatusText size="sm">
              {accountEmail ? copy.accountNote : copy.guestNote(draft.email)}
            </StatusText>
            <Link as={StoreLink} href="/obchodni-podminky" size="current">
              {cs.header.terms}
            </Link>
          </div>
        </div>
      </div>
    </form>
  );
}
