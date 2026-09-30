"use client";

import { useState } from "react";
import NextLink from "next/link";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";

interface ProductDetailActionsProps {
  productId: string;
  productName: string;
}

export function ProductFavoriteButton({ productId, productName }: ProductDetailActionsProps) {
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
        isFavorite ? `Odebrat ${productName} z oblíbených` : `Přidat ${productName} k oblíbeným`
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
  const storageKey = `akros-watch-${productId}`;
  const [isWatched, setIsWatched] = useState(false);

  const toggleWatch = () => {
    const nextWatched = !isWatched;
    setIsWatched(nextWatched);
    window.localStorage.setItem(storageKey, String(nextWatched));
  };

  const shareProduct = async () => {
    const shareData = { title: productName, url: window.location.href };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== "AbortError") throw error;
      }
      return;
    }

    window.location.href = `mailto:?subject=${encodeURIComponent(productName)}&body=${encodeURIComponent(
      window.location.href,
    )}`;
  };

  return (
    <div className="akros-product-actions" aria-label="Další akce produktu">
      <Button
        aria-pressed={isWatched}
        icon={isWatched ? "icon-[mdi--bell-ring]" : "icon-[mdi--bell-ring-outline]"}
        onClick={toggleWatch}
        size="sm"
        theme="borderless"
        variant="secondary"
      >
        {isWatched ? "Produkt hlídáme" : "Hlídat produkt"}
      </Button>
      <LinkButton
        as={NextLink}
        href="/kontakty#primy-kontakt"
        icon="icon-[mdi--help-circle-outline]"
        size="sm"
        theme="borderless"
        variant="secondary"
      >
        Dotaz na produkt
      </LinkButton>
      <Button
        icon="icon-[mdi--email-outline]"
        onClick={shareProduct}
        size="sm"
        theme="borderless"
        variant="secondary"
      >
        Poslat kamarádovi
      </Button>
    </div>
  );
}
