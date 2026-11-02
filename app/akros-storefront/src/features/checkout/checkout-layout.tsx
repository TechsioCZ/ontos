"use client";
import StoreLink from "@/components/store-link";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { useRouter } from "next/navigation";
import { useDictionary, useStoreHref, useStorePathname } from "@/ontos/market-context";
import { Steps, useSteps } from "@techsio/ui-kit/molecules/steps";
import { ProductGrid, type ProductGridItem } from "@/components/product-grid";
import { useCart } from "@/features/cart/cart-provider";
import { CartNavigation } from "@/features/cart/cart-content";
import { CartRevalidation, useCartQuote } from "@/ontos/cart-revalidation";
import { CartSelector } from "@/features/cart/cart-selector";
import { checkoutSteps, getReachableStep } from "@/features/checkout/checkout-state";
import { useCheckout } from "./checkout-provider";
import { CheckoutSummary } from "./checkout-summary";

function UnconfirmedOrder() {
  const cs = useDictionary();
  const { completeOrder, storageError } = useCheckout();
  const router = useRouter();
  const storeHref = useStoreHref();
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  return (
    <section
      className="order-1 grid gap-4 rounded-sm bg-(--color-base) p-6"
      aria-label={cs.checkout.unconfirmed.label}
    >
      <h1 className="font-bold">{cs.checkout.unconfirmed.title}</h1>
      <p>{cs.checkout.unconfirmed.description}</p>
      {storageError && (
        <p role="alert" className="text-sm text-(--color-danger)">
          {storageError}
        </p>
      )}
      <Button
        type="button"
        disabled={sending}
        onClick={async () => {
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
        {sending ? cs.checkout.unconfirmed.checking : cs.checkout.unconfirmed.confirm}
      </Button>
    </section>
  );
}

export function CheckoutLayout({
  children,
  recommendations,
}: {
  children: ReactNode;
  recommendations: ProductGridItem[];
}) {
  const cs = useDictionary();
  const quote = useCartQuote();
  const pricesVisible = !quote?.enabled || (quote.status === "ready" && !quote.quote?.priceChanged);
  const pathname = useStorePathname();
  const router = useRouter();
  const storeHref = useStoreHref();
  const { cart } = useCart();
  const {
    draft,
    methods,
    ready,
    storageError,
    submitted,
    accountEmail,
    accountReady,
    guestCheckout,
    chooseGuestCheckout,
    hasUnconfirmedOrder,
  } = useCheckout();
  const canCheckout = accountEmail !== null || guestCheckout;
  const cartBlocked = quote ? !quote.canContinue : false;
  const step = Math.max(
    0,
    checkoutSteps.findIndex((item) => item.href === pathname),
  );
  const reachable = canCheckout ? getReachableStep(step, cart, draft, methods) : 0;
  const steps = useSteps({
    count: 4,
    step,
    onStepChange: ({ step: next }) => {
      router.push(
        storeHref(
          checkoutSteps[canCheckout ? getReachableStep(next, cart, draft, methods) : 0].href,
        ),
      );
    },
  });
  useEffect(() => {
    if (ready && accountReady && !submitted && !hasUnconfirmedOrder && reachable !== step)
      router.replace(storeHref(checkoutSteps[reachable].href));
  }, [ready, accountReady, reachable, router, step, submitted, hasUnconfirmedOrder, storeHref]);
  return (
    <div
      data-akros-checkout
      className="bg-(--color-fill-surface) px-(--akros-checkout-page-gutter) pt-(--akros-checkout-padding-top) pb-(--akros-checkout-padding-bottom) font-medium leading-(--akros-checkout-body-leading) text-(--akros-checkout-ink)"
    >
      <Steps.RootProvider value={steps} size="md" variant="subtle">
        <div
          data-akros-checkout-body
          className="mx-auto grid w-full max-w-(--akros-checkout-content-width) items-start gap-(--dimension-24) 2xl:grid-cols-[minmax(0,1fr)_var(--akros-checkout-sidebar-width)]"
        >
          <div className="contents min-w-0 2xl:block">
            <Steps.List
              aria-label={cs.checkout.stepsLabel}
              className="mb-(--dimension-60) order-0 min-w-0 pt-(--dimension-24)"
            >
              {checkoutSteps.map((item, index) => (
                <Steps.Item key={item.href} index={index} className="block min-w-0">
                  <Steps.Trigger
                    disabled={
                      !ready ||
                      (!canCheckout && index > 0) ||
                      getReachableStep(index, cart, draft, methods) !== index
                    }
                    className="relative z-1 w-full flex-col justify-center text-center"
                  >
                    <Steps.Indicator>
                      <Steps.Number className="leading-(--akros-checkout-body-leading)" />
                    </Steps.Indicator>
                    <Steps.Title className="w-full overflow-visible text-center wrap-break-word whitespace-normal">
                      {cs.checkout.steps[item.key]}
                    </Steps.Title>
                  </Steps.Trigger>
                  <Steps.Separator className="absolute top-5 left-[calc(50%+1.5rem)] w-[calc(100%-3rem)]" />
                </Steps.Item>
              ))}
            </Steps.List>
            {storageError && step !== 3 && !hasUnconfirmedOrder && (
              <p role="alert" className="mb-4 text-sm text-(--color-danger)">
                {storageError}
              </p>
            )}
            {ready && hasUnconfirmedOrder && <UnconfirmedOrder />}
            {hasUnconfirmedOrder && step === 3 ? null : !ready || reachable !== step ? (
              <output className="block py-12 text-center">{cs.cart.loading}</output>
            ) : (
              <Steps.Content index={step} className="order-1 min-w-0">
                {pricesVisible ? children : <output>{cs.checkout.pricesNotVerified}</output>}
              </Steps.Content>
            )}
            {ready &&
              cart.lines.length > 0 &&
              !hasUnconfirmedOrder &&
              step === 0 &&
              (!accountReady ? (
                <output>{cs.checkout.verifyingLogin}</output>
              ) : canCheckout ? (
                <CartNavigation />
              ) : (
                <section
                  className="order-3 mt-6 grid gap-3 rounded-sm bg-(--color-base) p-6"
                  aria-labelledby="checkout-choice"
                >
                  <h2 id="checkout-choice" className="font-bold">
                    {cs.checkout.chooser.title}
                  </h2>
                  <p>{cs.checkout.chooser.description}</p>
                  <div className="flex flex-wrap items-center gap-4">
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      uppercase
                      disabled={cartBlocked}
                      aria-describedby={cartBlocked ? "checkout-choice-blocked" : undefined}
                      onClick={() => {
                        chooseGuestCheckout();
                        router.push(storeHref(checkoutSteps[1].href));
                      }}
                    >
                      {cs.checkout.chooser.withoutAccount}
                    </Button>
                    <StoreLink href="/prihlaseni?returnTo=%2Fkosik" className="underline">
                      {cs.checkout.chooser.signIn}
                    </StoreLink>
                    <StoreLink href="/registrace?returnTo=%2Fkosik" className="underline">
                      {cs.checkout.chooser.createAccount}
                    </StoreLink>
                  </div>
                  {cartBlocked && (
                    <p id="checkout-choice-blocked" className="text-xs text-(--color-fg-secondary)">
                      {quote?.blockedReason}
                    </p>
                  )}
                </section>
              ))}
            {ready && !hasUnconfirmedOrder && <CartRevalidation />}
            {ready && !hasUnconfirmedOrder && cart.lines.length > 0 && step < 3 && (
              <section
                className="order-4 mt-(--dimension-60) min-w-0"
                aria-labelledby="checkout-recommendations"
              >
                <h2
                  id="checkout-recommendations"
                  className="mt-4 mb-6 text-(length:--akros-checkout-recommendation-size) leading-(--akros-checkout-heading-leading) font-extrabold text-(--akros-checkout-recommendation-color)"
                >
                  {cs.checkout.recommendationsTitle}
                </h2>
                <ProductGrid products={recommendations} action="detail" columns="checkout" />
              </section>
            )}
          </div>
          {ready && (
            <div className="order-2 grid min-w-0 gap-(--dimension-16) 2xl:order-none">
              <CartSelector />
              {!hasUnconfirmedOrder && pricesVisible && cart.lines.length > 0 && step < 3 && (
                <CheckoutSummary />
              )}
            </div>
          )}
        </div>
      </Steps.RootProvider>
    </div>
  );
}
