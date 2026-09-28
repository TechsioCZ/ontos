"use client";

import { ProductCard } from "@techsio/ui-kit/molecules/product-card";

import { useCart } from "./cart-provider";
import { cs } from "@/i18n/cs";
import type { CartItemSnapshot } from "@/mock-storefront/cart";

export function AddToCartButton({ item }: { item: CartItemSnapshot }) {
  const { dispatch } = useCart();

  return (
    <ProductCard.Button
      aria-label={cs.actions.addToCart}
      buttonVariant="cart"
      onClick={() => dispatch({ type: "add", item, quantity: 1 })}
    >
      {cs.actions.addToCart}
    </ProductCard.Button>
  );
}
