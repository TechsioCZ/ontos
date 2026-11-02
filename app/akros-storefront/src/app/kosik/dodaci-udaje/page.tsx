import type { Metadata } from "next";
import { getDictionary } from "@/ontos/active-market";
import { AddressStep } from "@/features/checkout/address-step";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getDictionary()).checkout.steps.address };
}
export default function AddressPage() {
  return <AddressStep />;
}
