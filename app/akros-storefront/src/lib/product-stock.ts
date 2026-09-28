export type ProductStockStatus = "in-stock" | "limited-stock" | "out-of-stock";

export const getProductStockStatus = ({
  minimumQuantity,
  stockCount,
}: {
  minimumQuantity: number;
  stockCount: number;
}): ProductStockStatus => {
  if (stockCount <= 0) return "out-of-stock";
  if (stockCount < minimumQuantity) return "limited-stock";
  return "in-stock";
};
