import type { CartLine } from "@/features/cart/cart-state";
import { createCatalog } from "./catalog-model";
import type { ProductPage } from "./catalog-projection";
import type { CustomerOrder } from "./order-model";
import { purchaseConstraints } from "./purchase-constraints";

/** Why one saved order line cannot go back into the cart; the browser words it from its dictionary. */
export type ReorderSkipReason = "not-offered" | "price-unavailable" | "availability-unknown";

/** Saved order lines resolved against the current OntOS catalogue of the active market. */
export interface ReorderResolution {
  /** Current product/variant snapshots with the ordered quantities (current prices, never the saved ones). */
  items: CartLine[];
  skipped: { sku: string; reason: ReorderSkipReason }[];
}

/**
 * Resolves the exact ordered variants against a fresh catalogue read. Prices, stock, units and quantity rules
 * come from OntOS now; the order contributes only identities and quantities. The cart quote re-checks them.
 */
export function resolveReorder(
  order: Pick<CustomerOrder, "lines">,
  snapshot: ProductPage,
): ReorderResolution {
  const model = createCatalog(snapshot, { categories: [] });
  const items: CartLine[] = [];
  const skipped: ReorderResolution["skipped"] = [];
  for (const line of order.lines) {
    const product = model.getProductById(line.productId);
    const variant = line.variantId
      ? product?.detail.variants.find((entry) => entry.id === line.variantId)
      : undefined;
    // The read carries only the requested variants, so a variant group is recognised by its summary.
    if (!product || (line.variantId ? !variant : product.variantSummary.count > 0)) {
      skipped.push({ sku: line.sku, reason: "not-offered" });
      continue;
    }
    const item = variant ?? product;
    if (item.priceUnavailableReason || item.priceMinor <= 0) {
      skipped.push({ sku: item.sku, reason: "price-unavailable" });
      continue;
    }
    if (item.availabilityUnknown) {
      skipped.push({ sku: item.sku, reason: "availability-unknown" });
      continue;
    }
    const tier = [...(variant?.priceTiers ?? product.detail.priceTiers)]
      .filter((entry) => entry.minimumQuantity <= line.quantity)
      .sort((left, right) => right.minimumQuantity - left.minimumQuantity)[0];
    const unitWeightKg = variant ? variant.sourceNetWeight : product.netWeight;
    items.push({
      vatRate: product.vatRate,
      ...(unitWeightKg === undefined ? {} : { unitWeightKg }),
      productId: product.id,
      ...(variant ? { variantId: variant.id, variantLabel: variant.label } : {}),
      slug: product.slug,
      name: product.name,
      sku: item.sku,
      imageSrc: variant?.imageSrc ?? product.imageSrc,
      imageAlt: product.imageAlt,
      unit: item.unit,
      ...purchaseConstraints(item.minimumQuantity, item.packageQuantity),
      stockCount: item.stockCount,
      priceMinor: tier?.priceMinor ?? item.priceMinor,
      ...(tier ? { priceExcludingVatMinor: tier.priceExcludingVatMinor } : {}),
      quantity: line.quantity,
    });
  }
  return { items, skipped };
}
