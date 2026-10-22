"use client";

import NextLink from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { Tooltip } from "@techsio/ui-kit/atoms/tooltip";
import { buildVariantDetailHref } from "@/lib/product-variant-links";
import type { CatalogProductVariant } from "@/mock-storefront/types";
import { ProductVariantImage } from "./product-variant-image";

export function ProductVariantLink({
  slug,
  imageSrc,
  variant,
  label,
}: {
  slug: string;
  imageSrc: string;
  variant: CatalogProductVariant;
  label: string;
}) {
  const search = useSearchParams();
  const [previewOpen, setPreviewOpen] = useState(false);
  // The kit's span trigger can receive hover-exit while its nested link keeps focus.
  const [focused, setFocused] = useState(false);
  return (
    <Tooltip
      open={previewOpen || focused}
      onOpenChange={({ open }) => setPreviewOpen(open)}
      className="akros-variant-preview"
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
          alt={`Náhled: ${variant.label}`}
          preview
        />
      }
    >
      <LinkButton
        as={NextLink}
        href={buildVariantDetailHref(slug, variant.id, search.toString())}
        scroll={false}
        prefetch={false}
        theme="borderless"
        variant="secondary"
        size="current"
        className="akros-variant-detail-link hover:underline focus-visible:underline"
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
