import type { ReactNode } from "react";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { CheckoutLayout } from "@/features/checkout/checkout-layout";
import { CheckoutProvider } from "@/features/checkout/checkout-provider";
import { getHomepageFeaturedProducts, toProductSummary } from "@/mock-storefront/catalog";

export default function CartLayout({ children }: { children: ReactNode }) {
  const recommendations = getHomepageFeaturedProducts().slice(0, 3).map(toProductSummary);
  return (
    <div className="min-h-screen bg-(--color-base)">
      <SiteHeader />
      <main>
        <CheckoutProvider>
          <CheckoutLayout recommendations={recommendations}>{children}</CheckoutLayout>
        </CheckoutProvider>
      </main>
      <SiteFooter />
    </div>
  );
}
