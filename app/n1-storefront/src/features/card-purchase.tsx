"use client";

import { useRef } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { useToast } from "@techsio/ui-kit/molecules/toast";
import type { Dictionary } from "@/i18n";
import type { ProductCardModel } from "@/ontos/catalog-model";
import { useCart } from "./cart-provider";
import { simpleCardEntry } from "./card-purchase-model";

/** Same native cart draft and toast contract as ProductPurchase; no eager owner reads. */
export const CardPurchase = ({
  dictionary: d,
  product,
}: {
  dictionary: Dictionary;
  product: ProductCardModel;
}) => {
  const cart = useCart();
  const toaster = useToast();
  const active = useRef(false);
  const entry = simpleCardEntry(product, cart);
  const addToCart = () => {
    if (active.current || entry === null || cart === null) {
      return;
    }
    active.current = true;
    const added = cart.add(entry);
    toaster.create({
      description: added ? `${entry.quantity} × ${product.name}` : undefined,
      duration: 10_000,
      title: added ? d.shopping.added : d.shopping.addFailed,
      type: added ? "success" : "error",
    });
    active.current = false;
  };
  return (
    <Button
      aria-label={entry === null ? `${d.addToCart}: ${d.commerceUnavailable}` : d.addToCart}
      density="compact"
      disabled={entry === null}
      icon="token-icon-cart"
      iconPosition="left"
      onClick={addToCart}
      size="sm"
      theme="solid"
      variant="secondary"
    >
      {d.addToCart}
    </Button>
  );
};
