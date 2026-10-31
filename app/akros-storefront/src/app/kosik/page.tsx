import type { Metadata } from "next";
import { CartContent } from "@/features/cart/cart-content";
export const metadata: Metadata = { title: "Nákupní košík" };
export default function CartPage() {
  return <CartContent />;
}
