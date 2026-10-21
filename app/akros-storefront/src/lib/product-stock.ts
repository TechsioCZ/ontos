export type ProductStockStatus = "in-stock" | "limited-stock" | "out-of-stock" | "unknown";

export const getProductStockStatus = ({
  availabilityUnknown,
  minimumQuantity,
  stockCount,
}: {
  availabilityUnknown?: boolean;
  minimumQuantity: number;
  stockCount: number;
}): ProductStockStatus => {
  if (availabilityUnknown) return "unknown";
  if (stockCount <= 0) return "out-of-stock";
  if (stockCount < minimumQuantity) return "limited-stock";
  return "in-stock";
};

/** Czech labels of every stock state; „nelze ověřit“ is never replaced by „skladem“. */
export const productStockLabels: Record<ProductStockStatus, string> = {
  "in-stock": "Skladem",
  "limited-stock": "Omezeně skladem",
  "out-of-stock": "Není skladem",
  unknown: "Dostupnost nelze ověřit",
};

/** The ui-kit stock badge knows three tones; „nelze ověřit“ uses the cautionary one. */
export const productStockTone = (
  status: ProductStockStatus,
): "in-stock" | "limited-stock" | "out-of-stock" =>
  status === "unknown" ? "limited-stock" : status;
