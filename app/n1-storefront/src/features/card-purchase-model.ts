import { Schema } from "effect";
import { ProductCardModelSchema } from "@/ontos/catalog-model";
import type { ProductCardModel } from "@/ontos/catalog-model";
import { CartScopeSchema } from "@/ontos/cart-quote";
import type { useCart } from "./cart-provider";
import type { CartEntry } from "./cart-state";
import { validCartQuantity } from "./cart-state";

const SimpleCardProductSchema = Schema.Struct({
  ...ProductCardModelSchema.fields,
  minimumQuantity: Schema.Finite.check(Schema.isBetween({ maximum: 1_000_000, minimum: 0.001 })),
  priceMinor: Schema.Int.check(Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 })),
  stock: Schema.Literals(["available", "limited"]),
  unit: Schema.String.check(Schema.isMaxLength(100), Schema.isPattern(/\S/u)),
  variantCount: Schema.Literal(0),
}).check(
  Schema.makeFilter(({ variantPreview }) =>
    (variantPreview?.length ?? 0) === 0
      ? undefined
      : "A simple product cannot contain variant labels",
  ),
);

/** A card may add only an explicitly simple owner product, at its actual minimum. */
export const simpleCardEntry = (
  product: ProductCardModel,
  cart: ReturnType<typeof useCart>,
): CartEntry | null => {
  if (
    cart === null ||
    !cart.loaded ||
    cart.error ||
    !Schema.is(CartScopeSchema)(cart.scope) ||
    cart.scope.currency !== product.currency ||
    !Schema.is(SimpleCardProductSchema)(product)
  ) {
    return null;
  }
  // Match the native order contract; never round the owner's minimum for a shortcut.
  if (
    !validCartQuantity(product.minimumQuantity, product.minimumQuantity, product.packageQuantity)
  ) {
    return null;
  }
  return {
    expectedUnitPriceMinor: product.priceMinor,
    image: product.image,
    minimumQuantity: product.minimumQuantity,
    name: product.name,
    packageQuantity: product.packageQuantity ?? null,
    productId: product.id,
    quantity: product.minimumQuantity,
    sku: product.sku,
    slug: product.slug,
    unit: product.unit,
    variantName: "",
  };
};
