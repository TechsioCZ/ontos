import { describe, expect, it } from "vitest";
import { getProductDescriptionParagraphs } from "@/lib/product-description";

const pricingNotice =
  "Limity množstevních slev: nižší cena od 100 kusů další snížení ceny od 500 kusů Snížená cena se projeví po vložení zboží do košíku";

describe("getProductDescriptionParagraphs", () => {
  it("omits only the known standalone quantity-pricing notice", () => {
    expect(getProductDescriptionParagraphs([pricingNotice, `${pricingNotice}.`])).toEqual([]);
  });

  it("preserves material and safety information following the pricing notice", () => {
    const material =
      "Tuto položku zadávejte v případě, že trváte na přesném dodání materiálu A4 - 70.";
    const resistance = "Odolnost: dlouhodobě- 90-100 stupňůkrátkodobě- 140 stupňů";
    expect(
      getProductDescriptionParagraphs([
        `${pricingNotice} ${material}`,
        `${pricingNotice}. ${resistance}`,
      ]),
    ).toEqual([material, resistance]);
  });

  it("keeps other mentions of discounts and preserves paragraph order", () => {
    const paragraphs = [
      "Snížená cena výrobku nemění požadovanou pevnost materiálu.",
      "Přehled množstevních slev je součástí technických podmínek.",
      "Kompletní sortiment pro fotovoltaické panely",
    ];
    expect(getProductDescriptionParagraphs(paragraphs)).toEqual(paragraphs);
  });

  it("handles missing and whitespace-only descriptions", () => {
    expect(getProductDescriptionParagraphs([])).toEqual([]);
    expect(getProductDescriptionParagraphs(["", "  ", "  Technický popis  "])).toEqual([
      "Technický popis",
    ]);
  });
});
