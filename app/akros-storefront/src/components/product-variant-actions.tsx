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
import { productWatchStorageKey } from "@/features/products/product-watch";
import { useDictionary, useStoreHref } from "@/ontos/market-context";

/**
 * The contact page's OntOS product question (`productId`, as the inquiry carries it) with Kai's optional
 * variant selection (`variantIds`).
 */
export function buildProductQuestionHref(productId: string, variantIds: readonly string[]) {
  const params = new URLSearchParams({ productId });
  if (variantIds.length) params.set("variantIds", [...new Set(variantIds)].join(","));
  return `/kontakty?${params}#primy-kontakt`;
}

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
  const cs = useDictionary();
  const storeHref = useStoreHref();
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
        className="sf-product-actions__watch hover:underline focus-visible:underline"
        icon="token-icon-sf-product-watch"
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
              title: variantWatched ? cs.productActions.watchRemoved : cs.productActions.watchSaved,
              duration: 4000,
            });
          } catch {
            toaster.create({
              type: "error",
              title: cs.productActions.watchFailed,
              duration: 6000,
            });
          }
        }}
      >
        {variantId
          ? variantWatched
            ? cs.productActions.unwatchVariant
            : cs.productActions.watchVariant
          : watched.length
            ? cs.productActions.editWatch(watched.length)
            : cs.productActions.watchProduct}
      </Button>
      <Button
        ref={questionTrigger}
        aria-haspopup={variantId ? undefined : "dialog"}
        className="sf-product-actions__question hover:underline focus-visible:underline"
        icon="token-icon-sf-product-question"
        iconSize="sm"
        size="sm"
        theme="borderless"
        variant="secondary"
        onClick={() =>
          variantId
            ? router.push(storeHref(buildProductQuestionHref(productId, [variantId])))
            : setAction("question")
        }
      >
        {variantId ? cs.productActions.askVariant : cs.product.askQuestion}
      </Button>
      {action && (
        <VariantSelectionDialog
          productId={productId}
          productName={productName}
          slug={productSlug}
          title={
            action === "watch" ? cs.productActions.watchTitle : cs.productActions.questionTitle
          }
          confirmLabel={
            action === "watch" ? cs.productActions.saveWatch : cs.productActions.continueToQuestion
          }
          description={action === "watch" ? cs.productActions.watchDescription : undefined}
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
                storeHref(
                  buildProductQuestionHref(
                    productId,
                    catalog.product.hasVariants ? selected.map((item) => item.id) : [],
                  ),
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
              id: `sf-watch-${productId}`,
              type: "success",
              title: cs.productActions.watchSelectionSaved,
              duration: 4000,
            });
          }}
        />
      )}
    </>
  );
}
