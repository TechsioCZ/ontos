import { getProductById, getProductVariantById } from "./catalog";
import { addCartItems, type CartLine, type CartState } from "./cart";
import type { DemoOrderLine } from "./fixtures/account";

export function prepareReorder(cart: CartState, lines: DemoOrderLine[]) {
  const items: CartLine[] = [];
  const missing: string[] = [];
  for (const line of lines) {
    const product = getProductById(line.productId);
    const variant = getProductVariantById(line.productId, line.variantId);
    if (!product || !variant) {
      missing.push(`${line.sku}: varianta již není v nabídce.`);
      continue;
    }
    items.push({
      productId: product.id,
      variantId: variant.id,
      slug: product.slug,
      name: product.name,
      sku: variant.sku,
      imageSrc: variant.imageSrc ?? product.imageSrc,
      imageAlt: product.imageAlt,
      unit: variant.unit,
      minimumQuantity: variant.minimumQuantity,
      stockCount: variant.stockCount,
      priceMinor: variant.priceMinor,
      priceExcludingVatMinor: variant.priceTiers.find(
        (tier) => tier.priceMinor === variant.priceMinor,
      )?.priceExcludingVatMinor,
      variantLabel: variant.label,
      quantity: line.quantity,
    });
  }
  const { addedLines, notices } = addCartItems(cart, items);
  return { items, result: { addedLines, notices: [...missing, ...notices] } };
}
