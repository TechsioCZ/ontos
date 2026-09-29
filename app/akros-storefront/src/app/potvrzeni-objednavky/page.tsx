import type { Metadata } from "next";
import { StorefrontWideShell } from "@/components/storefront-shell";
import { OrderConfirmation } from "@/features/checkout/order-confirmation";
export const metadata: Metadata = { title: "Potvrzení objednávky" };
export default function OrderConfirmationPage() {
  return (
    <StorefrontWideShell>
      <OrderConfirmation />
    </StorefrontWideShell>
  );
}
