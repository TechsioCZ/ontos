export interface ProductVariantReference {
  productId: string;
  productSlug: string;
  variantId: string | null;
}

export function parseVariantReferences(
  snapshot: string | null | undefined,
): ProductVariantReference[] {
  try {
    const value: unknown = JSON.parse(snapshot ?? "null");
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    return value
      .filter((item): item is ProductVariantReference => {
        if (
          !item ||
          typeof item !== "object" ||
          typeof item.productId !== "string" ||
          !item.productId.trim() ||
          typeof item.productSlug !== "string" ||
          !item.productSlug.trim() ||
          !(
            item.variantId === null ||
            (typeof item.variantId === "string" && item.variantId.trim())
          )
        )
          return false;
        const key = JSON.stringify([item.productId, item.variantId]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(({ productId, productSlug, variantId }) => ({ productId, productSlug, variantId }));
  } catch {
    return [];
  }
}

export function replaceProductReferences(
  current: ProductVariantReference[],
  productId: string,
  selected: ProductVariantReference[],
): ProductVariantReference[] {
  return parseVariantReferences(
    JSON.stringify([
      ...current.filter((item) => item.productId !== productId),
      ...selected.filter((item) => item.productId === productId),
    ]),
  );
}
