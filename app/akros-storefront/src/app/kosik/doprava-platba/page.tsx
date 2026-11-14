import type { Metadata } from "next";
import { getDictionary } from "@/ontos/active-market";
import { DeliveryPaymentStep } from "@/features/checkout/delivery-payment-step";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getDictionary()).checkout.steps.delivery };
}
export default function DeliveryPaymentPage() {
  return <DeliveryPaymentStep />;
}
