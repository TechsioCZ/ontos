"use client";

import { Button } from "@techsio/ui-kit/atoms/button";
import { FavoriteButton } from "@/features/favorites/favorite-button";
import { ProductShare } from "./product-share";
import { ProductVariantActions } from "./product-variant-actions";

export function ProductDetailActions({
  showVariantFavorites = false,
  ...props
}: {
  productId: string;
  productName: string;
  productSlug: string;
  showVariantFavorites?: boolean;
}) {
  return (
    <div
      className="akros-product-actions -mt-(--akros-product-actions-offset) flex flex-wrap gap-x-(--akros-product-actions-column-gap) gap-y-(--dimension-8) pt-(--dimension-4)"
      aria-label="Další akce produktu"
    >
      {showVariantFavorites && <FavoriteButton {...props} placement="action" />}
      <ProductVariantActions {...props} />
      <ProductShare {...props} />
      <Button
        className="akros-product-actions__print hover:underline focus-visible:underline"
        icon="token-icon-akros-product-print"
        iconSize="sm"
        onClick={() => window.print()}
        size="sm"
        theme="borderless"
        variant="secondary"
      >
        Tisk
      </Button>
    </div>
  );
}
