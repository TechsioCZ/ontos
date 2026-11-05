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
  // A size adds its own parameters; it does not erase product-level material,
  // brand or colour. Only an exact label/unit match is replaced by owner data.
  const parameters =
    variant && variant.parameters.length > 0
      ? [
          ...product.parameters.filter(
            (parameter) =>
              !variant.parameters.some(
                (own) => own.label === parameter.label && own.unit === parameter.unit,
              ),
          ),
          ...variant.parameters,
        ]
      : product.parameters;
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
