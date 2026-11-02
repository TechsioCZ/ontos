"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useDictionary, useStoreHref } from "@/ontos/market-context";
import { Button } from "@techsio/ui-kit/atoms/button";
import { VariantSelectionDialog } from "./variant-selection-dialog";

/** Questions still go through the native inquiry form; no simulated stock-alert subscription. */
export function ProductVariantActions({
  productId,
  productName,
  productSlug,
  variantId,
}: {
  productId: string;
  productName: string;
  productSlug: string;
  variantId?: string | null;
}) {
  const router = useRouter();
  const cs = useDictionary();
  const storeHref = useStoreHref();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const ask = (ids: string[]) => {
    const query = new URLSearchParams({ productId });
    if (ids.length) query.set("variantIds", ids.join(","));
    router.push(storeHref(`/kontakty?${query}#primy-kontakt`));
  };
  return (
    <>
      <Button
        ref={trigger}
        type="button"
        size="sm"
        theme="borderless"
        variant="secondary"
        className="akros-product-actions__question hover:underline focus-visible:underline"
        icon="token-icon-akros-product-question"
        iconSize="sm"
        aria-haspopup={variantId !== undefined ? undefined : "dialog"}
        onClick={() =>
          variantId !== undefined ? ask(variantId ? [variantId] : []) : setOpen(true)
        }
      >
        {variantId ? cs.product.askVariant : cs.product.askQuestion}
      </Button>
      {open && (
        <VariantSelectionDialog
          productId={productId}
          productName={productName}
          slug={productSlug}
          title="Dotaz na varianty"
          confirmLabel="Pokračovat k dotazu"
          allowEmpty={false}
          initialSelection={[]}
          finalFocusEl={() => trigger.current}
          onClose={() => setOpen(false)}
          onConfirm={(selected) => {
            setOpen(false);
            ask(selected.map((item) => item.id));
          }}
        />
      )}
    </>
  );
}
