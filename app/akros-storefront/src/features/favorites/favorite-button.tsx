"use client";

import dynamic from "next/dynamic";
import { useRef, useState } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { toaster } from "@techsio/ui-kit/molecules/toast";
import { saveProductFavorites, useFavorites } from "./use-favorites";

const FavoriteDialog = dynamic(() =>
  import("./favorite-dialog").then((module) => module.FavoriteDialog),
);

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
        id: `akros-favorite-${productId}`,
        type: "success",
        title: selected ? "Varianta odebrána z oblíbených." : "Varianta uložena do oblíbených.",
        duration: 4000,
      });
    } catch {
      toaster.create({
        id: `akros-favorite-${productId}`,
        type: "error",
        title: "Oblíbené se nepodařilo uložit. Zkuste to znovu.",
        duration: 6000,
      });
    }
  }
  const label = concrete
    ? `${selected ? "Odebrat" : "Uložit"} ${productName} ${selected ? "z" : "do"} oblíbených`
    : `Vybrat oblíbené varianty: ${productName}, uloženo ${saved.length}`;
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
            ? "akros-product-card__favorite absolute top-0 right-0 w-11"
            : placement === "action"
              ? "akros-product-detail__favorite akros-product-actions__favorite hover:underline focus-visible:underline"
              : "akros-product-detail__favorite"
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
              ? "Odebrat z oblíbených"
              : "Uložit do oblíbených"
            : `Oblíbené varianty${saved.length ? ` (${saved.length})` : ""}`)}
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
              id: `akros-favorite-${productId}`,
              type: "success",
              title: "Výběr oblíbených variant uložen.",
              duration: 4000,
            })
          }
        />
      )}
    </>
  );
}
