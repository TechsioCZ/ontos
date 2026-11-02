import type { Metadata } from "next";
import { CartContent } from "@/features/cart/cart-content";
import { getDictionary } from "@/ontos/active-market";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getDictionary()).cart.title };
}

export default function CartPage() {
  return <CartContent />;
}
