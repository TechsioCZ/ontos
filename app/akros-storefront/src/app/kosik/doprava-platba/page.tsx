import type { Metadata } from "next";
import { DeliveryPaymentStep } from "@/features/checkout/delivery-payment-step";
export const metadata: Metadata = { title: "Doprava a platba" };
export default function DeliveryPaymentPage() {
  return <DeliveryPaymentStep />;
}
