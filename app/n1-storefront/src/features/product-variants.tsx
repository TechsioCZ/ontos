"use client";

import NextImage from "next/image";
import NextLink from "next/link";
import { Image } from "@techsio/ui-kit/atoms/image";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import type { Dictionary } from "@/i18n";
import type { ProductDetailModel } from "@/ontos/catalog-model";

/** N1 composition of native navigation controls and a separate stock asset. */
export const ProductVariants = ({
  dictionary: d,
  pathname,
  selectedVariant,
  variants,
}: {
  dictionary: Dictionary;
  pathname: string;
  selectedVariant: ProductDetailModel["variants"][number] | undefined;
  variants: ProductDetailModel["variants"];
}) => (
  <fieldset className="order-1 md:mb-5">
    <legend className="mb-2 font-bold">{d.selectVariant}</legend>
    <div className="n1-product-variants flex flex-wrap gap-2">
      {variants.map((item) => {
        const selected = item.id === selectedVariant?.id;
        return (
          <div
            className={selected ? "n1-product-variant-selected relative" : "relative"}
            key={item.id}
          >
            <LinkButton
              aria-current={selected ? "true" : undefined}
              as={NextLink}
              href={`${pathname}?${new URLSearchParams({ variantId: item.id })}`}
              prefetch={false}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              {item.name}
            </LinkButton>
            {(item.stock === "available" || item.stock === "limited") && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute right-0 top-0 size-n1-variant-stock-corner"
              >
                <Image
                  alt=""
                  as={NextImage}
                  height={8}
                  size="custom"
                  src="/brand/stock-corner.svg"
                  width={8}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  </fieldset>
);
