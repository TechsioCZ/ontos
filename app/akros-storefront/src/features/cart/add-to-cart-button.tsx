"use client";

import { ProductCard } from "@techsio/ui-kit/molecules/product-card";

import { useCart } from "./cart-provider";
import { cs } from "@/i18n/cs";
import type { CartItemSnapshot } from "@/features/cart/cart-state";
import type { CatalogPriceTier } from "@/ontos/catalog-types";

export function AddToCartButton({
  item,
  label = cs.actions.addToCart,
  quantity = 1,
  priceTiers,
}: {
  item: CartItemSnapshot;
  label?: string;
  quantity?: number;
  priceTiers?: CatalogPriceTier[];
}) {
  const { addItem, adding } = useCart();

  return (
    <ProductCard.Button
      aria-label={`${label}: ${item.variantLabel ?? item.name}`}
      buttonVariant="cart"
      aria-disabled={adding}
      onClick={() => void addItem(item, quantity, priceTiers)}
    >
      {label}
    </ProductCard.Button>
  );
}
