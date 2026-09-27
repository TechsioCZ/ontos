"use client";

import { ProductCard } from "@techsio/ui-kit/molecules/product-card";

import { useCart } from "./cart-provider";
import { cs } from "@/i18n/cs";

export function AddToCartButton({ productId }: { productId: string }) {
  const { dispatch } = useCart();

  return (
    <ProductCard.Button
      aria-label={cs.actions.addToCart}
      buttonVariant="cart"
      onClick={() => dispatch({ type: "add", productId, quantity: 1 })}
    >
      {cs.actions.addToCart}
    </ProductCard.Button>
  );
}
