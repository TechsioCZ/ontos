import { describe, expect, it } from "vitest";

import { describeOfferPrice, PRICE_UNAVAILABLE_LABEL } from "@/lib/format";
import { toRemoteSuggestion } from "@/ontos/search-suggestions";
import type { CatalogProduct } from "@/ontos/catalog-types";

const label = (input: Parameters<typeof describeOfferPrice>[0]) => describeOfferPrice(input).label;

describe("describeOfferPrice", () => {
  it("formats a positive CZK price, with „od“ for variant ranges", () => {
    expect(describeOfferPrice({ priceMinor: 12_100, currency: "CZK" })).toEqual({
      available: true,
      label: "121,00 Kč",
    });
    expect(label({ priceMinor: 12_100, currency: "CZK", priceIsFrom: true })).toBe("od 121,00 Kč");
  });

  it.each([
    ["zero", 0, "Cena v OntOS je nulová, položku proto nelze objednat."],
    ["negative", -100, "Cena v OntOS je nulová, položku proto nelze objednat."],
    ["missing", undefined, "OntOS pro tuto položku nevrátil cenu."],
    ["null", null, "OntOS pro tuto položku nevrátil cenu."],
    ["NaN", Number.NaN, "OntOS pro tuto položku nevrátil cenu."],
    ["fractional", 12.5, "OntOS pro tuto položku nevrátil cenu."],
  ])("never prints 0,00 Kč for a %s price", (_name, priceMinor, reason) => {
    const price = describeOfferPrice({ priceMinor, currency: "CZK", priceIsFrom: true });
    expect(price).toEqual({ available: false, label: PRICE_UNAVAILABLE_LABEL, reason });
    expect(price.label).not.toMatch(/Kč|0,00/);
  });

  it("refuses an unsupported or missing currency instead of formatting it", () => {
    expect(describeOfferPrice({ priceMinor: 12_100, currency: "eur" })).toEqual({
      available: false,
      label: PRICE_UNAVAILABLE_LABEL,
      reason: "Cena je v nepodporované měně (EUR); e-shop prodává jen v Kč.",
    });
    expect(describeOfferPrice({ priceMinor: 12_100, currency: undefined })).toEqual({
      available: false,
      label: PRICE_UNAVAILABLE_LABEL,
      reason: "OntOS pro tuto položku nevrátil měnu ceny.",
    });
  });

  it("keeps the catalog's own reason when the projection already marked the price unavailable", () => {
    expect(
      describeOfferPrice({
        priceMinor: 12_100,
        currency: "CZK",
        priceUnavailableReason: "OntOS pro tuto položku nevrátil cenu.",
      }),
    ).toEqual({
      available: false,
      label: PRICE_UNAVAILABLE_LABEL,
      reason: "OntOS pro tuto položku nevrátil cenu.",
    });
  });
});

describe("toRemoteSuggestion", () => {
  const product = {
    id: "p1",
    slug: "sroub",
    name: "Šroub",
    imageSrc: "/a.jpg",
    currency: "CZK",
    priceMinor: 0,
    priceUnavailableReason: "Cena v OntOS je nulová, položku proto nelze objednat.",
    variantSummary: { count: 0, minGrossPriceMinor: null, stockOnHand: 0, units: [] },
  } as unknown as CatalogProduct;

  it("carries the price-unavailable reason to the header search", () => {
    expect(toRemoteSuggestion(product)).toMatchObject({
      priceMinor: 0,
      priceUnavailableReason: "Cena v OntOS je nulová, položku proto nelze objednat.",
      hasVariants: false,
    });
  });
});
