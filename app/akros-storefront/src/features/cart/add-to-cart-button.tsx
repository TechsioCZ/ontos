"use client";

import { ProductCard } from "@techsio/ui-kit/molecules/product-card";

import { useCart } from "./cart-provider";
import { cs } from "@/i18n/cs";
import type { CartItemSnapshot } from "@/mock-storefront/cart";

export function AddToCartButton({
  item,
  label = cs.actions.addToCart,
  quantity = 1,
}: {
  item: CartItemSnapshot;
  label?: string;
  quantity?: number;
}) {
  const { dispatch } = useCart();

  return (
    <ProductCard.Button
      aria-label={`${label}: ${item.variantLabel ?? item.name}`}
      buttonVariant="cart"
      onClick={() => dispatch({ type: "add", item, quantity })}
    >
      {label}
    </ProductCard.Button>
  );
}
