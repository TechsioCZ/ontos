import { describe, expect, it } from "vitest";
import { en } from "@/i18n/en";
import { sk } from "@/i18n/sk";
import { describeCatalogPrice, getCatalogPriceLabel } from "@/lib/product-price";

const eur = { currency: "EUR" as const, locale: "sk-SK" };

describe("catalog price label", () => {
  it("shows the variant-price prompt instead of a group lower bound", () => {
    expect(getCatalogPriceLabel({ priceIsFrom: true, priceMinor: 254, currency: "CZK" })).toBe(
      "Cena dle varianty",
    );
    expect(
      getCatalogPriceLabel({ priceIsFrom: true, priceMinor: 254, currency: "EUR" }, sk, eur),
    ).toBe("Cena podľa varianty");
  });
  it("formats an exact price in the market currency", () => {
    expect(
      getCatalogPriceLabel({ priceIsFrom: false, priceMinor: 254, currency: "EUR" }, sk, eur),
    ).toMatch(/^2,54\s€$/);
  });
  it("never formats a missing, zero or foreign-currency price", () => {
    expect(
      describeCatalogPrice({ priceIsFrom: false, priceMinor: 0, currency: "CZK" }, en),
    ).toEqual({
      kind: "unavailable",
      label: "Price unavailable",
      reason: "Cena v OntOS je nulová, položku proto nelze objednat.",
    });
    expect(
      describeCatalogPrice({ priceIsFrom: false, priceMinor: 500, currency: "CZK" }, sk, eur).kind,
    ).toBe("unavailable");
  });
});
