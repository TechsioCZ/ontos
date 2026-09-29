import type { ReactNode } from "react";
import { StorefrontWideShell } from "@/components/storefront-shell";
import { CheckoutLayout } from "@/features/checkout/checkout-layout";
import { CheckoutProvider } from "@/features/checkout/checkout-provider";
import { getHomepageFeaturedProducts, toProductSummary } from "@/mock-storefront/catalog";

export default function CartLayout({ children }: { children: ReactNode }) {
  const recommendations = getHomepageFeaturedProducts().slice(0, 3).map(toProductSummary);
  return (
    <StorefrontWideShell fullBleed>
      <CheckoutProvider>
        <CheckoutLayout recommendations={recommendations}>{children}</CheckoutLayout>
      </CheckoutProvider>
    </StorefrontWideShell>
  );
}
