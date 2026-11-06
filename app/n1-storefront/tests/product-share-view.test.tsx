import { afterEach, expect, it, rs } from "@rstest/core";
import { renderToStaticMarkup } from "react-dom/server";
import { ProductView } from "../src/features/product-view";
import { productShareOrigin } from "../src/features/product-share";
import { projectCatalog } from "../src/ontos/catalog-model";
import { getDictionary } from "../src/i18n";

const {
  details: [product],
} = projectCatalog(
  {
    market: { configured: true, currency: "CZK", marketId: "market" },
    products: [
      {
        id: "owner-product",
        name: "Owner product",
        slug: "owner-product",
        variantRecords: [
          {
            active: true,
            attributes: "",
            availability: "IN_STOCK",
            grossPriceMinor: 12_100,
            id: "owner-variant",
            name: "M",
            sku: "OWNER-M",
            stockOnHand: 2,
          },
        ],
        variantSummary: { count: 1, minGrossPriceMinor: 12_100, stockOnHand: 2 },
      },
    ],
  },
  [],
);

afterEach(() => {
  rs.restoreAllMocks();
});

it.each(["cs", "en"])("renders a safe inactive share action during SSR in %s", (locale) => {
  const dictionary = getDictionary(locale);
  const html = renderToStaticMarkup(
    <ProductView dictionary={dictionary} locale={locale} product={product} />,
  );
  expect(html).toContain(`<a aria-disabled="true">${dictionary.sendToFriend}</a>`);
  expect(html).not.toContain("mailto:");
});

it.each(["cs", "en"])("shares only the resolved variant and localized product in %s", (locale) => {
  rs.spyOn(productShareOrigin, "getServerSnapshot").mockReturnValue("https://shop.example.test");
  const html = renderToStaticMarkup(
    <ProductView
      dictionary={getDictionary(locale)}
      locale={locale}
      product={product}
      variantId="owner-variant"
    />,
  );
  expect(html).toContain(
    encodeURIComponent(
      `https://shop.example.test/${locale}/produkt/owner-product?variantId=owner-variant`,
    ),
  );
  expect(html).toContain("mailto:?subject=Owner%20product&amp;body=");
});

it("omits an invalid variant selector from the draft while the purchase remains blocked", () => {
  rs.spyOn(productShareOrigin, "getServerSnapshot").mockReturnValue("https://shop.example.test");
  const html = renderToStaticMarkup(
    <ProductView
      dictionary={getDictionary("cs")}
      locale="cs"
      product={product}
      variantId="unknown"
    />,
  );
  expect(html).toContain(
    `body=${encodeURIComponent("https://shop.example.test/cs/produkt/owner-product")}`,
  );
  expect(html).not.toContain("variantId%3Dunknown");
  expect(html).not.toContain('role="spinbutton"');
});
