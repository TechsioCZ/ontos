"use client";
import StoreLink from "@/components/store-link";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { useRouter } from "next/navigation";
import { useDictionary, useStoreHref, useStorePathname } from "@/ontos/market-context";
import { Steps, useSteps } from "@techsio/ui-kit/molecules/steps";
import { ProductGrid, type ProductGridItem } from "@/components/product-grid";
import { useCart } from "@/features/cart/cart-provider";
import { CartNavigation } from "@/features/cart/cart-content";
import { CartSelector } from "@/features/cart/cart-selector";
import { checkoutSteps, getReachableStep } from "@/features/checkout/checkout-state";
import { useCheckout } from "./checkout-provider";
import { useCartQuote } from "@/ontos/cart-revalidation";
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
    methodsError,
    navigationMethods,
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
  // Steps follow the last verified list; a deep link past delivery waits (null) for the first one.
  const navigable = navigationMethods ?? [];
  const reachable =
    !canCheckout || cart.lines.length === 0
      ? 0
      : navigationMethods === null && step > 1
        ? null
        : getReachableStep(step, cart, draft, navigable);
  const steps = useSteps({
    count: 4,
    step,
    onStepChange: ({ step: next }) => {
      router.push(
        storeHref(
          checkoutSteps[canCheckout ? getReachableStep(next, cart, draft, navigable) : 0].href,
        ),
      );
    },
  });
  useEffect(() => {
    if (
      ready &&
      accountReady &&
      reachable !== null &&
      !submitted &&
      !hasUnconfirmedOrder &&
      reachable !== step
    )
      router.replace(storeHref(checkoutSteps[reachable].href));
  }, [ready, accountReady, reachable, router, step, submitted, hasUnconfirmedOrder, storeHref]);
  return (
    <div
      data-sf-checkout
      className="bg-(--color-fill-surface) px-(--sf-checkout-page-gutter) pt-(--sf-checkout-padding-top) pb-(--sf-checkout-padding-bottom) font-medium leading-(--sf-checkout-body-leading) text-(--sf-checkout-ink)"
    >
      <Steps.RootProvider value={steps} size="md" variant="subtle">
        <div
          data-sf-checkout-body
          className="mx-auto grid w-full max-w-(--sf-checkout-content-width) items-start gap-(--dimension-24) 2xl:grid-cols-[minmax(0,1fr)_var(--sf-checkout-sidebar-width)]"
        >
          <div className="contents min-w-0 2xl:block">
            <Steps.List aria-label={cs.checkout.stepsLabel} data-sf-checkout-steps>
              {checkoutSteps.map((item, index) => (
                <Steps.Item key={item.href} index={index}>
                  <Steps.Trigger
                    disabled={
                      !ready ||
                      (!canCheckout && index > 0) ||
                      getReachableStep(index, cart, draft, navigable) !== index
                    }
                  >
                    <Steps.Indicator>
                      <Steps.Number />
                    </Steps.Indicator>
                    <Steps.Title data-sf-checkout-step-title>
                      {cs.checkout.steps[item.key]}
                    </Steps.Title>
                  </Steps.Trigger>
                  <Steps.Separator />
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
              <output className="block py-12 text-center">
                {(reachable === null && methodsError) || cs.cart.loading}
              </output>
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
                  <div className="sf-checkout-actions">
                    <LinkButton
                      as={StoreLink}
                      href="/"
                      className="sf-checkout-back"
                      data-sf-checkout-action
                      size="sm"
                      uppercase
                      variant="secondary"
                    >
                      {cs.cart.backToShop}
                    </LinkButton>
                    <div className="sf-checkout-next">
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        data-sf-checkout-action
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
                      <div data-sf-checkout-account-links>
                        <StoreLink href="/prihlaseni?returnTo=%2Fkosik">
                          {cs.checkout.chooser.signIn}
                        </StoreLink>
                        <StoreLink href="/registrace?returnTo=%2Fkosik">
                          {cs.checkout.chooser.createAccount}
                        </StoreLink>
                      </div>
                    </div>
                  </div>
                  {cartBlocked && (
                    <p id="checkout-choice-blocked" className="text-xs text-(--color-fg-secondary)">
                      {quote?.blockedReason}
                    </p>
                  )}
                </section>
              ))}
            {ready && !hasUnconfirmedOrder && cart.lines.length > 0 && step < 3 && (
              <section
                data-sf-checkout-recommendations={checkoutSteps[step].key}
                className="sf-checkout-recommendations"
                aria-labelledby="checkout-recommendations"
              >
                <h2
                  id="checkout-recommendations"
                  className={step === 1 ? "sr-only" : "sf-checkout-recommendations-heading"}
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
