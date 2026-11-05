import { Struct } from "effect";
import type { ProductDetailModel } from "@/ontos/catalog-model";

/** Presentation of a genuine owner variant; unknown selections never choose an unrelated variant. */
export const selectProductDetail = (product: ProductDetailModel, variantId: string | undefined) => {
  const variant = product.variants.find((item) => item.id === variantId);
  const current = variant
    ? {
        ...Struct.omit(product, ["packageQuantity"]),
        ...Struct.pick(variant, ["packageQuantity"]),
        image: variant.image ?? product.image,
        minimumQuantity: variant.minimumQuantity,
        priceExcludingVatMinor: variant.priceExcludingVatMinor,
        priceFrom: false,
        priceMinor: variant.priceMinor,
        sku: variant.sku,
        stock: variant.stock,
        stockQuantity: variant.stockQuantity,
        unit: variant.unit,
      }
    : product;
  const parameters =
    variant && variant.parameters.length > 0 ? variant.parameters : product.parameters;
  const variantImage = variant?.image ?? null;
  const images =
    variantImage === null
      ? [...product.images]
      : [variantImage, ...product.images.filter((src) => src !== variantImage)];
  return {
    current,
    images,
    parameters,
    selectionRequired: product.variants.length > 0 && !variant,
    variant,
  };
};
