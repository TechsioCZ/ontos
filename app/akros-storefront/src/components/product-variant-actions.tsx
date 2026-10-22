"use client";

import dynamic from "next/dynamic";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@techsio/ui-kit/atoms/button";
import { toaster } from "@techsio/ui-kit/molecules/toast";
import {
  replaceStoredProductReferences,
  useVariantReferences,
} from "@/features/products/use-variant-references";
import { productWatchStorageKey } from "@/mock-storefront/product-watch";
import { buildVariantQuestionHref } from "@/lib/product-variant-links";

const VariantSelectionDialog = dynamic(() =>
  import("./variant-selection-dialog").then((module) => module.VariantSelectionDialog),
);

export function ProductVariantActions({
  productId,
  productName,
  productSlug,
  variantId,
}: {
  productId: string;
  productName: string;
  productSlug: string;
  variantId?: string;
}) {
  const router = useRouter();
  const { references, ready } = useVariantReferences(productWatchStorageKey);
  const watched = references.filter((item) => item.productId === productId);
  const variantWatched = watched.some((item) => item.variantId === variantId);
  const [action, setAction] = useState<"watch" | "question" | null>(null);
  const watchTrigger = useRef<HTMLButtonElement>(null);
  const questionTrigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={watchTrigger}
        disabled={!ready}
        aria-haspopup={variantId ? undefined : "dialog"}
        aria-pressed={variantId ? variantWatched : undefined}
        className="akros-product-actions__watch hover:underline focus-visible:underline"
        icon="token-icon-akros-product-watch"
        iconSize="sm"
        size="sm"
        theme="borderless"
        variant="secondary"
        onClick={() => {
          if (!variantId) {
            setAction("watch");
            return;
          }
          try {
            replaceStoredProductReferences(
              productWatchStorageKey,
              productId,
              variantWatched
                ? watched.filter((item) => item.variantId !== variantId)
                : [...watched, { productId, productSlug, variantId }],
            );
            toaster.create({
              type: "success",
              title: variantWatched
                ? "Hlídání varianty odebráno v tomto prohlížeči."
                : "Hlídání varianty uloženo v tomto prohlížeči.",
              duration: 4000,
            });
          } catch {
            toaster.create({
              type: "error",
              title: "Hlídání se nepodařilo uložit. Zkuste to znovu.",
              duration: 6000,
            });
          }
        }}
      >
        {variantId
          ? variantWatched
            ? "Zrušit hlídání varianty"
            : "Hlídat variantu"
          : watched.length
            ? `Upravit hlídání (${watched.length})`
            : "Hlídat produkt"}
      </Button>
      <Button
        ref={questionTrigger}
        aria-haspopup={variantId ? undefined : "dialog"}
        className="akros-product-actions__question hover:underline focus-visible:underline"
        icon="token-icon-akros-product-question"
        iconSize="sm"
        size="sm"
        theme="borderless"
        variant="secondary"
        onClick={() =>
          variantId
            ? router.push(buildVariantQuestionHref(productSlug, [variantId]))
            : setAction("question")
        }
      >
        {variantId ? "Dotaz na variantu" : "Dotaz na produkt"}
      </Button>
      {action && (
        <VariantSelectionDialog
          productId={productId}
          productName={productName}
          slug={productSlug}
          title={action === "watch" ? "Hlídat varianty" : "Dotaz na varianty"}
          confirmLabel={action === "watch" ? "Uložit hlídání" : "Pokračovat k dotazu"}
          description={
            action === "watch"
              ? "V této ukázce se výběr hlídání ukládá jen v tomto prohlížeči."
              : undefined
          }
          initialSelection={
            action === "watch" ? watched.map((item) => item.variantId ?? productId) : []
          }
          allowEmpty={action === "watch"}
          requireChange={action === "watch"}
          finalFocusEl={() => (action === "watch" ? watchTrigger.current : questionTrigger.current)}
          onClose={() => setAction(null)}
          onConfirm={(selected, catalog) => {
            if (action === "question") {
              router.push(
                buildVariantQuestionHref(
                  productSlug,
                  catalog.product.hasVariants ? selected.map((item) => item.id) : [],
                ),
              );
              return;
            }
            const known = new Set(catalog.variants.map((item) => item.id));
            replaceStoredProductReferences(productWatchStorageKey, productId, [
              ...watched.filter((item) => !known.has(item.variantId ?? productId)),
              ...selected.map((item) => ({
                productId,
                productSlug,
                variantId: catalog.product.hasVariants ? item.id : null,
              })),
            ]);
            toaster.create({
              id: `akros-watch-${productId}`,
              type: "success",
              title: "Výběr hlídání uložen v tomto prohlížeči.",
              duration: 4000,
            });
          }}
        />
      )}
    </>
  );
}
