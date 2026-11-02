"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { Tooltip } from "@techsio/ui-kit/atoms/tooltip";
import StoreLink from "@/components/store-link";
import { buildVariantDetailHref } from "@/lib/product-variant-links";
import type { CatalogPurchaseVariant } from "@/ontos/catalog-types";
import { useDictionary } from "@/ontos/market-context";
import { ProductVariantImage } from "./product-variant-image";

export function ProductVariantLink({
  slug,
  imageSrc,
  variant,
  label,
}: {
  slug: string;
  imageSrc: string;
  variant: Pick<CatalogPurchaseVariant, "id" | "label" | "imageSrc">;
  label: string;
}) {
  const cs = useDictionary();
  // Null outside the app router (isolated component tests).
  const search = useSearchParams();
  const [previewOpen, setPreviewOpen] = useState(false);
  // The kit's span trigger can receive hover-exit while its nested link keeps focus.
  const [focused, setFocused] = useState(false);
  return (
    <Tooltip
      open={previewOpen || focused}
      onOpenChange={({ open }) => setPreviewOpen(open)}
      className="sf-variant-preview"
      variant="outline"
      interactive={false}
      closeOnClick
      closeOnScroll={false}
      placement="left"
      flip={["top", "right", "bottom"]}
      content={
        <ProductVariantImage
          key={variant.id}
          src={variant.imageSrc}
          fallback={imageSrc}
          alt={cs.variants.preview(variant.label)}
          preview
        />
      }
    >
      <LinkButton
        as={StoreLink}
        href={buildVariantDetailHref(slug, variant.id, search?.toString() ?? "")}
        scroll={false}
        theme="borderless"
        variant="secondary"
        size="current"
        className="sf-variant-detail-link hover:underline focus-visible:underline"
        data-variant-detail-link={variant.id}
        aria-haspopup="dialog"
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onClick={() => {
          setFocused(false);
          setPreviewOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setFocused(false);
            setPreviewOpen(false);
          }
        }}
      >
        {label}
      </LinkButton>
    </Tooltip>
  );
}
