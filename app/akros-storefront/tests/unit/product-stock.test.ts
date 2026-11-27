import { describe, expect, it } from "vitest";

import { cs } from "@/i18n/cs";
import { getProductStockStatus, stockStatusLabel } from "@/lib/product-stock";

describe("getProductStockStatus", () => {
  it("follows the owner: stock held below one package is named and never sold", () => {
    const belowPackage = { stockOnHand: 6, firstOrderableQuantity: 10 };
    expect(getProductStockStatus({ stockCount: 10 })).toBe("in-stock");
    expect(getProductStockStatus({ stockCount: 0 })).toBe("out-of-stock");
    expect(getProductStockStatus({ stockCount: 0, belowPackage })).toBe("below-package");
    expect(getProductStockStatus({ availabilityUnknown: true, belowPackage, stockCount: 0 })).toBe(
      "unknown",
    );
    expect(stockStatusLabel(cs, "below-package", belowPackage, "ks")).toBe(
      "Skladem 6 ks, prodej po 10 ks",
    );
    expect(stockStatusLabel(cs, "below-package", { stockOnHand: 12 }, "ks")).toBe(
      "Skladem méně než balení",
    );
  });
});
