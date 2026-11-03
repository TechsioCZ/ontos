import { describe, expect, it } from "effect-rstest";
import type { ProductCardModel } from "../src/ontos/catalog-model";
import { priceProps } from "../src/features/price-props";

const product: ProductCardModel = {
  currency: "CZK",
  description: "",
  id: "owner-product",
  image: null,
  name: "Owner product",
  priceFrom: false,
  priceMinor: 119_900,
  sku: "",
  slug: "owner-product",
  stock: "unknown",
};

const copy = { from: "od", priceUnavailable: "Cena není dostupná" };

describe("owner price labels", () => {
  it("omits unnecessary decimal zeros for whole-crown prices", () => {
    expect(priceProps(product, copy, "cs")).toEqual({
      amountLabel: "1\u00A0199\u00A0Kč",
      state: "known",
    });
  });
  it("preserves a real fractional crown amount", () => {
    expect(priceProps({ ...product, priceMinor: 119_950 }, copy, "cs")).toEqual({
      amountLabel: "1\u00A0199,5\u00A0Kč",
      state: "known",
    });
  });
  it("does not turn a missing owner price into a zero or an amount label", () => {
    expect(priceProps({ ...product, priceMinor: null }, copy, "cs")).toEqual({
      label: copy.priceUnavailable,
      state: "on-request",
    });
  });
  it("preserves the variant minimum prefix and the actual market currency", () => {
    const result = priceProps({ ...product, currency: "EUR", priceFrom: true }, copy, "en");
    expect(result).toEqual({ amountLabel: "€1,199.00", prefix: "od", state: "from" });
  });
});
