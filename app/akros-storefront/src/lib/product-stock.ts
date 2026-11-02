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

/** The ui-kit stock badge knows three tones; „nelze ověřit“ uses the cautionary one. */
export const productStockTone = (
  status: ProductStockStatus,
): "in-stock" | "limited-stock" | "out-of-stock" =>
  status === "unknown" ? "limited-stock" : status;
