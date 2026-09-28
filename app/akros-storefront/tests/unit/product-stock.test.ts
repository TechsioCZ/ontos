import { describe, expect, it } from "vitest";

import { getProductStockStatus } from "@/lib/product-stock";

describe("getProductStockStatus", () => {
  it("marks a product without stock as out of stock", () => {
    expect(getProductStockStatus({ minimumQuantity: 1, stockCount: 0 })).toBe("out-of-stock");
  });

  it("marks stock below the purchasable minimum as limited", () => {
    expect(getProductStockStatus({ minimumQuantity: 10, stockCount: 4 })).toBe("limited-stock");
  });

  it("marks a product meeting its minimum as in stock", () => {
    expect(getProductStockStatus({ minimumQuantity: 10, stockCount: 10 })).toBe("in-stock");
  });
});
