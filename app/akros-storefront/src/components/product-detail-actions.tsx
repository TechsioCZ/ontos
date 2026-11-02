"use client";

import { useState } from "react";
import StoreLink from "@/components/store-link";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { useDictionary } from "@/ontos/market-context";

const isDOMException = (value: unknown): value is DOMException =>
  value !== null && value !== undefined && DOMException.prototype.isPrototypeOf(value);

interface ProductDetailActionsProps {
  productId: string;
  productName: string;
}

export function ProductFavoriteButton({ productId, productName }: ProductDetailActionsProps) {
  const cs = useDictionary();
  const storageKey = `akros-favorite-${productId}`;
  const [isFavorite, setIsFavorite] = useState(false);

  const toggleFavorite = () => {
    const nextFavorite = !isFavorite;
    setIsFavorite(nextFavorite);
    window.localStorage.setItem(storageKey, String(nextFavorite));
  };

  return (
    <Button
      aria-label={
        isFavorite ? cs.product.removeFavorite(productName) : cs.product.addFavorite(productName)
      }
      aria-pressed={isFavorite}
      className="akros-product-detail__favorite"
      icon={isFavorite ? "icon-[mdi--heart]" : "icon-[mdi--heart-outline]"}
      iconSize="lg"
      onClick={toggleFavorite}
      size="md"
      theme="outlined"
      variant="secondary"
    />
  );
}

export function ProductDetailActions({ productId, productName }: ProductDetailActionsProps) {
  const cs = useDictionary();
  const shareProduct = async () => {
    const shareData = { title: productName, url: window.location.href };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
      } catch (error) {
        if (!isDOMException(error) || error.name !== "AbortError") throw error;
      }
      return;
    }

    window.location.href = `mailto:?subject=${encodeURIComponent(productName)}&body=${encodeURIComponent(
      window.location.href,
    )}`;
  };

  return (
    <div
      className="akros-product-actions -mt-(--akros-product-actions-offset) flex flex-wrap gap-x-(--akros-product-actions-column-gap) gap-y-(--dimension-8) pt-(--dimension-4) [&>*]:min-h-(--akros-product-actions-min-height)"
      aria-label={cs.product.otherActions}
    >
      <LinkButton
        as={StoreLink}
        href={`/kontakty?productId=${encodeURIComponent(productId)}#primy-kontakt`}
        className="akros-product-actions__question hover:underline focus-visible:underline"
        icon="token-icon-akros-product-question"
        iconSize="sm"
        size="sm"
        theme="borderless"
        variant="secondary"
      >
        {cs.product.askQuestion}
      </LinkButton>
      <Button
        className="akros-product-actions__email hover:underline focus-visible:underline"
        icon="token-icon-akros-product-email"
        iconSize="sm"
        onClick={shareProduct}
        size="sm"
        theme="borderless"
        variant="secondary"
      >
        {cs.product.sendToFriend}
      </Button>
    </div>
  );
}
