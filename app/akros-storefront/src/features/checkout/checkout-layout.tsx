"use client";
import { type ReactNode, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Steps, useSteps } from "@techsio/ui-kit/molecules/steps";
import { ProductGrid, type ProductGridItem } from "@/components/product-grid";
import { useCart } from "@/features/cart/cart-provider";
import { CartNavigation } from "@/features/cart/cart-content";
import { CartSelector } from "@/features/cart/cart-selector";
import { checkoutSteps, getReachableStep } from "@/features/checkout/checkout-state";
import { useCheckout } from "./checkout-provider";
import { useCartQuote } from "@/ontos/cart-revalidation";
import { CheckoutSummary } from "./checkout-summary";

export function CheckoutLayout({
  children,
  recommendations,
}: {
  children: ReactNode;
  recommendations: ProductGridItem[];
}) {
  const quote = useCartQuote();
  const pricesVisible = !quote?.enabled || (quote.status === "ready" && !quote.quote?.priceChanged);
  const pathname = usePathname();
  const router = useRouter();
  const { cart } = useCart();
  const { draft, methods, ready, storageError, submitted } = useCheckout();
  const step = Math.max(
    0,
    checkoutSteps.findIndex((item) => item.href === pathname),
  );
  const reachable = getReachableStep(step, cart, draft, methods);
  const steps = useSteps({
    count: 4,
    step,
    onStepChange: ({ step: next }) => {
      router.push(checkoutSteps[getReachableStep(next, cart, draft, methods)].href);
    },
  });
  useEffect(() => {
    if (ready && !submitted && reachable !== step) router.replace(checkoutSteps[reachable].href);
  }, [ready, reachable, router, step, submitted]);
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
              aria-label="Kroky objednávky"
              className="mb-(--dimension-60) order-0 min-w-0 pt-(--dimension-24)"
            >
              {checkoutSteps.map((item, index) => (
                <Steps.Item key={item.href} index={index} className="block min-w-0">
                  <Steps.Trigger
                    disabled={!ready || getReachableStep(index, cart, draft, methods) !== index}
                    className="relative z-1 w-full flex-col justify-center text-center"
                  >
                    <Steps.Indicator>
                      <Steps.Number className="leading-(--akros-checkout-body-leading)" />
                    </Steps.Indicator>
                    <Steps.Title className="w-full overflow-visible text-center wrap-break-word whitespace-normal">
                      {item.title}
                    </Steps.Title>
                  </Steps.Trigger>
                  <Steps.Separator className="absolute top-5 left-[calc(50%+1.5rem)] w-[calc(100%-3rem)]" />
                </Steps.Item>
              ))}
            </Steps.List>
            {storageError && step !== 3 && (
              <p role="alert" className="mb-4 text-sm text-(--color-danger)">
                {storageError}
              </p>
            )}
            {!ready || reachable !== step ? (
              <output className="block py-12 text-center">Načítám košík…</output>
            ) : (
              <Steps.Content index={step} className="order-1 min-w-0">
                {pricesVisible ? (
                  children
                ) : (
                  <p role="status">
                    Ceny a dostupnost nejsou aktuálně ověřené. Po úspěšném ověření se obsah košíku
                    znovu zobrazí.
                  </p>
                )}
              </Steps.Content>
            )}
            {ready && cart.lines.length > 0 && step === 0 && <CartNavigation />}
            {ready && cart.lines.length > 0 && step < 3 && (
              <section
                className="order-4 mt-(--dimension-60) min-w-0"
                aria-labelledby="checkout-recommendations"
              >
                <h2
                  id="checkout-recommendations"
                  className="mt-4 mb-6 text-(length:--akros-checkout-recommendation-size) leading-(--akros-checkout-heading-leading) font-extrabold text-(--akros-checkout-recommendation-color)"
                >
                  Mohlo by se Vám líbit
                </h2>
                <ProductGrid products={recommendations} action="detail" columns="checkout" />
              </section>
            )}
          </div>
          {ready && (
            <div className="order-2 grid min-w-0 gap-(--dimension-16) 2xl:order-none">
              <CartSelector />
              {pricesVisible && cart.lines.length > 0 && step < 3 && <CheckoutSummary />}
            </div>
          )}
        </div>
      </Steps.RootProvider>
    </div>
  );
}
