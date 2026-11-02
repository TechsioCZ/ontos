"use client";

import { VariantSelectionDialog } from "@/components/variant-selection-dialog";
import { useDictionary } from "@/ontos/market-context";
import type { FavoriteReference } from "./favorite-references";
import { saveProductFavorites } from "./use-favorites";

export function FavoriteDialog({
  productId,
  productName,
  slug,
  initialSelection,
  finalFocusEl,
  onClose,
  onSaved,
}: {
  productId: string;
  productName: string;
  slug: string;
  initialSelection: FavoriteReference[];
  finalFocusEl: () => HTMLElement | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const cs = useDictionary();
  return (
    <VariantSelectionDialog
      productId={productId}
      productName={productName}
      slug={slug}
      title={cs.favorites.dialogTitle}
      confirmLabel={cs.favorites.confirm}
      allowEmpty
      requireChange
      submitErrorMessage={cs.favorites.storageFailed}
      initialSelection={initialSelection.map((item) => item.variantId ?? productId)}
      finalFocusEl={finalFocusEl}
      onClose={onClose}
      onConfirm={(selected, catalog) => {
        const known = new Set(catalog.variants.map((item) => item.id));
        const missing = initialSelection.filter((item) => !known.has(item.variantId ?? productId));
        saveProductFavorites(productId, [
          ...missing,
          ...selected.map((item) => ({
            productId,
            productSlug: slug,
            variantId: catalog.product.hasVariants ? item.id : null,
          })),
        ]);
        onSaved();
      }}
    />
  );
}
