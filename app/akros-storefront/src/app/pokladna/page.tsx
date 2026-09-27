import type { Metadata } from "next";

import { StorefrontWideShell } from "@/components/storefront-shell";
import { MockCheckout } from "@/features/checkout/mock-checkout";

export const metadata: Metadata = { title: "Pokladna" };

export default function CheckoutPage() {
  return (
    <StorefrontWideShell>
      <MockCheckout />
    </StorefrontWideShell>
  );
}
