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
  presentation = "featured",
  product,
}: {
  dictionary: Dictionary;
  presentation?: "featured" | "listing";
  product: ProductCardModel;
}) => {
  const cart = useCart();
  const toaster = useToast();
  const active = useRef(false);
  const entry = simpleCardEntry(product, cart);
  const listing = presentation === "listing";
  const label = listing ? d.addToCartListing : d.addToCart;
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
      {...(listing ? {} : { icon: "token-icon-cart" })}
      aria-label={entry === null ? `${label}: ${d.commerceUnavailable}` : label}
      block={listing}
      density={listing ? undefined : "compact"}
      disabled={entry === null}
      iconPosition="left"
      onClick={addToCart}
      size={listing ? "md" : "sm"}
      theme="solid"
      variant={listing ? "primary" : "secondary"}
    >
      {label}
    </Button>
  );
};
