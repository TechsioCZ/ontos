import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "@rstest/core";
import { ListingCards } from "../src/features/listing-cards";
import { getDictionary } from "../src/i18n";
import { projectCatalog } from "../src/ontos/catalog-model";
import type { ProductCardModel } from "../src/ontos/catalog-model";

const catalogue = (changes: Partial<ProductCardModel> = {}, withoutVariantCount = false) => {
  const model = projectCatalog(
    {
      market: { configured: true, currency: "CZK", marketId: "owner-market" },
      products: [
        {
          availability: "IN_STOCK",
          currency: "CZK",
          currentPriceMinor: 100,
          grossPriceMinor: 121,
          id: "owner-product",
          minimumQuantity: 1,
          name: "Owner product",
          slug: "owner-product",
          stockOnHand: 7,
          stockTracked: true,
          storefrontVariantPreview: { total: 0, variants: [] },
          unit: "ks",
          variantSummary: { count: 0, minGrossPriceMinor: null, stockOnHand: 0 },
        },
      ],
    },
    [],
  );
  const product = { ...model.products[0], ...changes };
  if (withoutVariantCount) {
    delete product.variantCount;
  }
  return { ...model, products: [product] };
};
const render = (changes: Partial<ProductCardModel>, locale = "cs", withoutVariantCount = false) =>
  renderToStaticMarkup(
    <ListingCards
      catalog={catalogue(changes, withoutVariantCount)}
      dictionary={getDictionary(locale)}
      locale={locale}
    />,
  );

describe("mobile listing card action intent", () => {
  for (const [locale, choose, add] of [
    ["cs", "Vybrat variantu", "Do košíku"],
    ["en", "Choose a variant", "Add to cart"],
  ]) {
    it(`navigates an available variant group to actual variant selection in ${locale}`, () => {
      const html = render({ variantCount: 2, variantPreview: [{ id: "M", name: "M" }] }, locale);
      expect(html).toContain(choose);
      expect(html).toContain(`href="/${locale}/produkt/owner-product"`);
      expect(html).not.toContain(`<button`);
    });
    it(`reuses native cart purchase for a priced available simple product in ${locale}`, () => {
      const html = render({ variantCount: 0 }, locale);
      expect(html).toContain(`<button`);
      expect(html).toContain(add);
    });
  }
  it.each([
    { stock: "unavailable", variantCount: 2 },
    { stock: "unknown", variantCount: 0 },
    { priceMinor: null, stock: "available", variantCount: 0 },
  ] satisfies Partial<ProductCardModel>[])(
    "keeps detail navigation when purchase is not established: %j",
    (changes) => {
      const html = render(changes);
      expect(html).toContain("Detail");
      expect(html).not.toContain("Vybrat variantu");
      expect(html).not.toContain(`<button`);
    },
  );
  it("keeps detail navigation when the owner variant count is absent", () => {
    const html = render({ stock: "available" }, "cs", true);
    expect(html).toContain("Detail");
    expect(html).not.toContain("Vybrat variantu");
    expect(html).not.toContain(`<button`);
  });
});
