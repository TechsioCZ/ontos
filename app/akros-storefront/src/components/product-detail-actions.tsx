"use client";

import { Button } from "@techsio/ui-kit/atoms/button";
import { FavoriteButton } from "@/features/favorites/favorite-button";
import { ProductShare } from "./product-share";
import { ProductVariantActions } from "./product-variant-actions";

interface ProductDetailActionsProps {
  productId: string;
  productName: string;
  productSlug: string;
  variantId?: string | null;
}

export function ProductFavoriteButton(props: ProductDetailActionsProps) {
  return <FavoriteButton {...props} />;
}

export function ProductDetailActions(props: ProductDetailActionsProps) {
  return (
    <div
      className="akros-product-actions flex flex-wrap items-center gap-x-(--akros-product-actions-column-gap) gap-y-(--dimension-8)"
      aria-label="Další akce produktu"
    >
      <FavoriteButton {...props} placement="action" />
      <ProductVariantActions {...props} />
      <ProductShare {...props} />
      <Button
        type="button"
        size="sm"
        theme="borderless"
        variant="secondary"
        icon="token-icon-akros-product-print"
        iconSize="sm"
        onClick={() => window.print()}
      >
        Tisk
      </Button>
    </div>
  );
}
