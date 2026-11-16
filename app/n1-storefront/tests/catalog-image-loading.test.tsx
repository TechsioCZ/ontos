import { describe, expect, it } from "@rstest/core";
import { renderToStaticMarkup } from "react-dom/server";
import { CatalogView } from "../src/features/catalog-view";
import { ListingCards } from "../src/features/listing-cards";
import { getDictionary } from "../src/i18n";
import { projectCatalog } from "../src/ontos/catalog-model";

const catalog = projectCatalog(
  {
    market: { configured: true, currency: "CZK", marketId: "fixture-market" },
    products: ["First", "Second"].map((name, index) => ({
      id: `fixture-${index}`,
      imageSrc: `https://images.example.invalid/${index}.jpg`,
      name,
      slug: `fixture-${index}`,
      variantSummary: { count: 1, minGrossPriceMinor: 10_000, stockOnHand: 1 },
    })),
  },
  ["images.example.invalid"],
);
const dictionary = getDictionary("cs");

describe("catalogue image loading policy", () => {
  it("starts the first mobile listing image immediately while retaining lazy later images", () => {
    const html = renderToStaticMarkup(
      <ListingCards catalog={catalog} dictionary={dictionary} locale="cs" />,
    );
    const images = html.match(/<img\b[^>]*>/gu);
    expect(images).toHaveLength(2);
    expect(images?.[0]).toContain('loading="eager"');
    expect(images?.[1]).toContain('loading="lazy"');
  });
  it("starts the first desktop listing image immediately while retaining lazy later images", () => {
    const html = renderToStaticMarkup(
      <CatalogView
        catalog={catalog}
        dictionary={dictionary}
        locale="cs"
        presentation="listing"
        title="Fixture listing"
      />,
    );
    const images = html.match(/<img\b[^>]*>/gu);
    expect(images).toHaveLength(2);
    expect(images?.[0]).toContain('loading="eager"');
    expect(images?.[1]).toContain('loading="lazy"');
  });
  it("keeps all homepage featured images lazy below the hero", () => {
    const html = renderToStaticMarkup(
      <CatalogView
        catalog={catalog}
        dictionary={dictionary}
        locale="cs"
        title="Fixture featured"
      />,
    );
    const images = html.match(/<img\b[^>]*>/gu);
    expect(images).toHaveLength(2);
    for (const image of images ?? []) {
      expect(image).toContain('loading="lazy"');
    }
  });
});
