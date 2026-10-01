"use client";
import { type ReactNode, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Steps, useSteps } from "@techsio/ui-kit/molecules/steps";
import { ProductGrid, type ProductGridItem } from "@/components/product-grid";
import { useCart } from "@/features/cart/cart-provider";
import { CartNavigation } from "@/features/cart/cart-content";
import { checkoutSteps, getReachableStep } from "@/mock-storefront/checkout";
import { useCheckout } from "./checkout-provider";
import { CheckoutSummary } from "./checkout-summary";

export function CheckoutLayout({
  children,
  recommendations,
}: {
  children: ReactNode;
  recommendations: ProductGridItem[];
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { cart } = useCart();
  const { draft, ready, storageError, submitted } = useCheckout();
  const step = Math.max(
    0,
    checkoutSteps.findIndex((item) => item.href === pathname),
  );
  const reachable = getReachableStep(step, cart, draft);
  const steps = useSteps({
    count: 4,
    step,
    onStepChange: ({ step: next }) => {
      router.push(checkoutSteps[getReachableStep(next, cart, draft)].href);
    },
  });
  useEffect(() => {
    if (ready && !submitted && reachable !== step) router.replace(checkoutSteps[reachable].href);
  }, [ready, reachable, router, step, submitted]);
  return (
    <div
      data-akros-checkout
      className="bg-(--color-fill-surface) px-4 py-8 md:px-8 lg:px-16 lg:py-10"
    >
      <Steps.RootProvider value={steps} size="md" variant="subtle">
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="min-w-0">
            <Steps.List aria-label="Kroky objednávky" className="mb-8 gap-0 md:mb-12">
              {checkoutSteps.map((item, index) => (
                <Steps.Item key={item.href} index={index} className="block min-w-0">
                  <Steps.Trigger
                    disabled={!ready || getReachableStep(index, cart, draft) !== index}
                    className="relative z-1 w-full flex-col justify-center gap-2 text-center"
                  >
                    <Steps.Indicator>
                      <Steps.Number />
                    </Steps.Indicator>
                    <Steps.Title className="overflow-visible whitespace-normal text-center max-sm:text-xs">
                      {item.title}
                    </Steps.Title>
                  </Steps.Trigger>
                  <Steps.Separator className="absolute top-5 left-[calc(50%+1.5rem)] w-[calc(100%-3rem)]" />
                </Steps.Item>
              ))}
            </Steps.List>
            {storageError && (
              <p role="alert" className="mb-4 text-sm text-(--color-danger)">
                {storageError}
              </p>
            )}
            {!ready || reachable !== step ? (
              <output className="block py-12 text-center">Načítám košík…</output>
            ) : (
              <Steps.Content index={step}>{children}</Steps.Content>
            )}
          </div>
          {ready && cart.lines.length > 0 && step < 3 && <CheckoutSummary />}
          {ready && cart.lines.length > 0 && step === 0 && <CartNavigation />}
          {ready && cart.lines.length > 0 && step < 3 && (
            <section className="min-w-0 xl:col-start-1" aria-labelledby="checkout-recommendations">
              <h2 id="checkout-recommendations" className="mt-4 mb-6 text-lg font-bold">
                Mohlo by se Vám líbit
              </h2>
              <ProductGrid products={recommendations} action="detail" columns="checkout" />
            </section>
          )}
        </div>
      </Steps.RootProvider>
    </div>
  );
}
