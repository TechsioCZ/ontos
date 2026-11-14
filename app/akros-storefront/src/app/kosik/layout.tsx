import { CartQuoteProvider, CartRevalidation } from "@/ontos/cart-revalidation";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { CheckoutLayout } from "@/features/checkout/checkout-layout";
import { CheckoutProvider } from "@/features/checkout/checkout-provider";
import { getCatalog } from "@/ontos/catalog-server";

export default async function CartLayout({ children }: { children: ReactNode }) {
  const { getHomepageFeaturedProducts, toProductSummary } = await getCatalog();
  const recommendations = getHomepageFeaturedProducts().slice(0, 3).map(toProductSummary);
  return (
    <div className="min-h-screen bg-(--color-base)">
      <SiteHeader />
      <main>
        <CheckoutProvider>
          <CartQuoteProvider>
            <CartRevalidation />
            <CheckoutLayout recommendations={recommendations}>{children}</CheckoutLayout>
          </CartQuoteProvider>
        </CheckoutProvider>
      </main>
      <SiteFooter />
    </div>
  );
}
