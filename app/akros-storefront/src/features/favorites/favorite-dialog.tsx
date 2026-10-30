"use client";

import { VariantSelectionDialog } from "@/components/variant-selection-dialog";
import { saveProductFavorites } from "./use-favorites";
import type { FavoriteReference } from "@/features/favorites/state";

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
  return (
    <VariantSelectionDialog
      productId={productId}
      productName={productName}
      slug={slug}
      title="Oblíbené varianty"
      confirmLabel="Uložit výběr"
      allowEmpty
      requireChange
      submitErrorMessage="Výběr se nepodařilo uložit. Zkontrolujte povolení úložiště a zkuste to znovu."
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
