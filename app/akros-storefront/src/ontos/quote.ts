import "server-only";
import { purchaseConstraints } from "./purchase-constraints";
import type { CartState, CartLine } from "@/mock-storefront/cart";
import { createCatalog } from "./catalog-model";
import { getSnapshot } from "./catalog-server";
export function assertCart(value: unknown): asserts value is CartState {
  const cart = value as CartState;
  if (
    cart?.version !== 3 ||
    !Array.isArray(cart.lines) ||
    cart.lines.length < 1 ||
    cart.lines.length > 50
  )
    throw new Error("Neplatný košík.");
  const seen = new Set<string>();
  for (const l of cart.lines) {
    const key = `${l.productId}:${l.variantId ?? ""}`;
    if (
      seen.has(key) ||
      typeof l.productId !== "string" ||
      (l.variantId !== undefined && typeof l.variantId !== "string") ||
      !Number.isFinite(l.quantity) ||
      l.quantity <= 0 ||
      l.quantity > 1_000_000_000 ||
      !Number.isSafeInteger(l.priceMinor) ||
      l.priceMinor < 0
    )
      throw new Error("Neplatná položka košíku.");
    seen.add(key);
  }
}
export async function quoteCart(cart: CartState) {
  const snapshot = await getSnapshot(true);
  const model = createCatalog(snapshot.catalog, snapshot.categories);
  const issues: string[] = [];
  let priceChanged = false;
  const lines: CartLine[] = cart.lines.map((line) => {
    const p = model.getProductById(line.productId);
    const v = p?.detail.variants.find((v) => v.id === line.variantId);
    if (!p || (p.detail.variants.length > 0 && !v)) {
      issues.push(`${line.name || "Položka"}: zboží již není v nabídce.`);
      return line;
    }
    const item = v ?? p;
    const tier = [...(v?.priceTiers ?? p.detail.priceTiers)]
      .filter((t) => t.minimumQuantity <= line.quantity)
      .sort((a, b) => b.minimumQuantity - a.minimumQuantity)[0];
    const price = tier?.priceMinor ?? item.priceMinor;
    if (line.priceMinor !== price) priceChanged = true;
    if (line.quantity > item.stockCount)
      issues.push(`${p.name}: požadované množství není skladem.`);
    if (line.quantity < item.minimumQuantity)
      issues.push(`${p.name}: minimální množství je ${item.minimumQuantity} ${item.unit}.`);
    const step = item.packageQuantity;
    if (step && Math.abs(line.quantity / step - Math.round(line.quantity / step)) > 0.000001)
      issues.push(`${p.name}: objednejte celé balení po ${step} ${item.unit}.`);
    return {
      ...line,
      name: p.name,
      vatRate: p.vatRate,
      slug: p.slug,
      sku: item.sku,
      unit: item.unit,
      stockCount: item.stockCount,
      ...purchaseConstraints(item.minimumQuantity, item.packageQuantity),
      priceMinor: price,
      priceExcludingVatMinor: tier?.priceExcludingVatMinor,
    };
  });
  return {
    cart: { version: 3 as const, lines },
    priceChanged,
    issues,
    canCheckout: !priceChanged && !issues.length,
  };
}
