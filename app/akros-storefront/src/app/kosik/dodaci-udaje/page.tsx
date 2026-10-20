import type { Metadata } from "next";
import { AddressStep } from "@/features/checkout/address-step";
export const metadata: Metadata = { title: "Dodací údaje" };
export default function AddressPage() {
  return <AddressStep />;
}
