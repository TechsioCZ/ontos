import { type CartState, createEmptyCart, normalizeOrderQuantity } from "./cart";

export const parseStoredCart = (value: string | null): CartState => {
  if (!value) return createEmptyCart();

  try {
    const parsed = JSON.parse(value) as Partial<CartState>;
    if (parsed.version !== 3 || !Array.isArray(parsed.lines)) return createEmptyCart();

    return {
      version: 3,
      lines: parsed.lines.flatMap((line) => {
        if (
          typeof line?.productId !== "string" ||
          typeof line.slug !== "string" ||
          typeof line.name !== "string" ||
          typeof line.sku !== "string" ||
          typeof line.imageSrc !== "string" ||
          typeof line.imageAlt !== "string" ||
          typeof line.unit !== "string" ||
          typeof line.priceMinor !== "number" ||
          typeof line.stockCount !== "number" ||
          typeof line.minimumQuantity !== "number" ||
          !Number.isSafeInteger(line.priceMinor) ||
          line.priceMinor < 0 ||
          !Number.isFinite(line.stockCount) ||
          line.stockCount < 0 ||
          !Number.isFinite(line.minimumQuantity) ||
          line.minimumQuantity <= 0 ||
          !Number.isFinite(line.quantity) ||
          line.quantity <= 0
        ) {
          return [];
        }

        const item = {
          productId: line.productId,
          ...(typeof line.variantId === "string" ? { variantId: line.variantId } : {}),
          slug: line.slug,
          name: line.name,
          sku: line.sku,
          imageSrc: line.imageSrc,
          imageAlt: line.imageAlt,
          unit: line.unit,
          minimumQuantity: line.minimumQuantity,
          priceMinor: line.priceMinor,
          ...(Number.isSafeInteger(line.priceExcludingVatMinor) &&
          (line.priceExcludingVatMinor ?? -1) >= 0 &&
          (line.priceExcludingVatMinor ?? Infinity) <= line.priceMinor
            ? { priceExcludingVatMinor: line.priceExcludingVatMinor }
            : {}),
          ...(typeof line.vatRate === "number" &&
          Number.isFinite(line.vatRate) &&
          line.vatRate >= 0 &&
          line.vatRate <= 100
            ? { vatRate: line.vatRate }
            : {}),
          stockCount: line.stockCount,
          ...(typeof line.variantLabel === "string" ? { variantLabel: line.variantLabel } : {}),
        };
        const quantity = normalizeOrderQuantity(item, line.quantity);

        return quantity > 0 ? [{ ...item, quantity }] : [];
      }),
    };
  } catch {
    return createEmptyCart();
  }
};
