"use client";

import { useState } from "react";
import NextLink from "next/link";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";

interface ProductDetailActionsProps {
  productId: string;
  productName: string;
}

export function ProductDetailActions({ productId, productName }: ProductDetailActionsProps) {
  const [isFavorite, setIsFavorite] = useState(false);

  const toggleFavorite = () => {
    const nextFavorite = !isFavorite;
    setIsFavorite(nextFavorite);
    window.localStorage.setItem(`akros-favorite-${productId}`, String(nextFavorite));
  };

  const shareProduct = async () => {
    const shareData = { title: productName, url: window.location.href };
    if (navigator.share) {
      await navigator.share(shareData);
      return;
    }

    window.location.href = `mailto:?subject=${encodeURIComponent(productName)}&body=${encodeURIComponent(
      window.location.href,
    )}`;
  };

  return (
    <section className="akros-product-detail__surface" aria-labelledby="product-actions-title">
      <h2 id="product-actions-title">Akce produktu</h2>
      <div className="akros-product-actions">
        <LinkButton as={NextLink} href="#product-variants" size="lg" variant="primary">
          Prosím vyberte variantu
        </LinkButton>
        <Button onClick={toggleFavorite} size="lg" variant="primary">
          {isFavorite ? "Odebrat z oblíbených" : "Přidat k oblíbeným"}
        </Button>
        <Button onClick={() => window.print()} size="lg" variant="primary">
          Tisk
        </Button>
        <LinkButton as={NextLink} href="/kontakty#primy-kontakt" size="lg" variant="primary">
          Dotaz na produkt
        </LinkButton>
        <Button onClick={shareProduct} size="lg" variant="primary">
          Poslat kamarádovi
        </Button>
      </div>
    </section>
  );
}
