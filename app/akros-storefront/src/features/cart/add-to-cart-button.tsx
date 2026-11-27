"use client";

import { ProductCard } from "@techsio/ui-kit/molecules/product-card";

import { useCart } from "./cart-provider";
import { useDictionary } from "@/ontos/market-context";
import type { CartItemSnapshot } from "@/features/cart/cart-state";

export function AddToCartButton({
  item,
  label,
  quantity = 1,
}: {
  item: CartItemSnapshot;
  label?: string;
  quantity?: number;
}) {
  const { addItem, adding } = useCart();
  const dictionary = useDictionary();
  const text = label ?? dictionary.actions.addToCart;

  return (
    <ProductCard.Button
      aria-label={`${text}: ${item.variantLabel ?? item.name}`}
      buttonVariant="cart"
      aria-disabled={adding}
      onClick={() => {
        void addItem(item, quantity);
      }}
    >
      {text}
    </ProductCard.Button>
  );
}
