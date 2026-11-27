"use client";

import dynamic from "next/dynamic";
import { useRef, useState } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { toaster } from "@techsio/ui-kit/molecules/toast";
import { useDictionary } from "@/ontos/market-context";
import { saveProductFavorites, useFavorites } from "./use-favorites";

const FavoriteDialog = dynamic(() =>
  import("./favorite-dialog").then((module) => module.FavoriteDialog),
);

/**
 * Favorite toggle of one concrete item (`variantId`: a variant id, or `null` for a product without variants),
 * or the variant chooser of a product with several variants (`variantId` omitted). Browser-local by design.
 */
export function FavoriteButton({
  productId,
  productName,
  productSlug,
  variantId,
  placement = "detail",
}: {
  productId: string;
  productName: string;
  productSlug: string;
  variantId?: string | null;
  placement?: "card" | "detail" | "action";
}) {
  const cs = useDictionary();
  const { favorites, ready } = useFavorites();
  const saved = favorites.filter((item) => item.productId === productId);
  const concrete = variantId !== undefined;
  const selected = concrete ? saved.some((item) => item.variantId === variantId) : saved.length > 0;
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  function handleClick() {
    if (!concrete) {
      setOpen(true);
      return;
    }
    try {
      saveProductFavorites(
        productId,
        selected
          ? saved.filter((item) => item.variantId !== variantId)
          : [...saved, { productId, productSlug, variantId }],
      );
      toaster.create({
        id: `sf-favorite-${productId}`,
        type: "success",
        title: selected ? cs.favorites.removed : cs.favorites.saved,
        duration: 4000,
      });
    } catch {
      toaster.create({
        id: `sf-favorite-${productId}`,
        type: "error",
        title: cs.favorites.saveFailed,
        duration: 6000,
      });
    }
  }
  const label = concrete
    ? selected
      ? cs.favorites.remove(productName)
      : cs.favorites.save(productName)
    : cs.favorites.choose(productName, saved.length);
  return (
    <>
      <Button
        ref={trigger}
        disabled={!ready}
        aria-label={label}
        aria-haspopup={concrete ? undefined : "dialog"}
        aria-pressed={concrete ? selected : undefined}
        className={
          placement === "card"
            ? "sf-product-card__favorite absolute top-0 right-0 w-11"
            : placement === "action"
              ? "sf-product-detail__favorite sf-product-actions__favorite hover:underline focus-visible:underline"
              : "sf-product-detail__favorite"
        }
        data-favorite-selected={selected || undefined}
        icon={selected ? "icon-[mdi--heart]" : "icon-[mdi--heart-outline]"}
        iconSize={placement === "action" ? "sm" : "lg"}
        onClick={handleClick}
        size={placement === "detail" ? "md" : "sm"}
        theme={placement === "detail" ? "outlined" : "borderless"}
        variant="secondary"
      >
        {placement === "action" &&
          (concrete
            ? selected
              ? cs.favorites.removeAction
              : cs.favorites.saveAction
            : saved.length
              ? cs.favorites.variantsActionCount(saved.length)
              : cs.favorites.variantsAction)}
      </Button>
      {open && (
        <FavoriteDialog
          productId={productId}
          productName={productName}
          slug={productSlug}
          initialSelection={saved}
          finalFocusEl={() => trigger.current}
          onClose={() => setOpen(false)}
          onSaved={() =>
            toaster.create({
              id: `sf-favorite-${productId}`,
              type: "success",
              title: cs.favorites.selectionSaved,
              duration: 4000,
            })
          }
        />
      )}
    </>
  );
}
