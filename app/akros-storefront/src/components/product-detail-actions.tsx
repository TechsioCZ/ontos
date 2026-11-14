"use client";

import { Button } from "@techsio/ui-kit/atoms/button";
import { FavoriteButton } from "@/features/favorites/favorite-button";
import { useDictionary } from "@/ontos/market-context";
import { ProductShare } from "./product-share";
import { ProductVariantActions } from "./product-variant-actions";

/** Product-level actions: variant favorites (several variants), watch, question, share and print. */
export function ProductDetailActions({
  showVariantFavorites = false,
  ...props
}: {
  productId: string;
  productName: string;
  productSlug: string;
  showVariantFavorites?: boolean;
}) {
  const cs = useDictionary();
  return (
    <div
      className="sf-product-actions -mt-(--sf-product-actions-offset) flex flex-wrap gap-x-(--sf-product-actions-column-gap) gap-y-(--dimension-8) pt-(--dimension-4)"
      aria-label={cs.product.otherActions}
    >
      {showVariantFavorites && <FavoriteButton {...props} placement="action" />}
      <ProductVariantActions {...props} />
      <ProductShare {...props} />
      <Button
        className="sf-product-actions__print hover:underline focus-visible:underline"
        icon="token-icon-sf-product-print"
        iconSize="sm"
        onClick={() => window.print()}
        size="sm"
        theme="borderless"
        variant="secondary"
      >
        {cs.productActions.print}
      </Button>
    </div>
  );
}
