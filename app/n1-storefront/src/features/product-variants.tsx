"use client";

import NextImage from "next/image";
import NextLink from "next/link";
import { Image } from "@techsio/ui-kit/atoms/image";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import type { Dictionary } from "@/i18n";
import type { ProductDetailModel } from "@/ontos/catalog-model";

/** N1 composition of native navigation controls and a separate stock asset. */
export const ProductVariants = ({
  desktop,
  dictionary: d,
  pathname,
  selectedVariant,
  variants,
}: {
  desktop: boolean;
  dictionary: Dictionary;
  pathname: string;
  selectedVariant: ProductDetailModel["variants"][number] | undefined;
  variants: ProductDetailModel["variants"];
}) => (
  <fieldset className="order-1 md:mb-5">
    <legend className="mb-6 font-semibold md:mb-2 md:font-bold">{d.selectVariant}</legend>
    <div className="flex flex-wrap gap-2 md:n1-product-variants">
      {variants.map((item) => {
        const selected = item.id === selectedVariant?.id;
        return (
          <div
            className={selected ? "relative md:n1-product-variant-selected" : "relative"}
            key={item.id}
          >
            <LinkButton
              aria-current={selected ? "true" : undefined}
              as={NextLink}
              href={`${pathname}?${new URLSearchParams({ variantId: item.id })}`}
              prefetch={false}
              size={desktop ? "sm" : "md"}
              theme={!desktop && selected ? "solid" : "outlined"}
              variant={!desktop && selected ? "primary" : "secondary"}
            >
              <span>
                {item.name}
                {selected && <span className="md:hidden">{` · ${d.selectedOption}`}</span>}
              </span>
            </LinkButton>
            {(item.stock === "available" || item.stock === "limited") && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute right-0 top-0 hidden size-n1-variant-stock-corner md:block"
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
