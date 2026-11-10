import { describe, expect, it } from "effect-rstest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProductPurchase } from "../src/features/product-purchase";
import { selectProductDetail } from "../src/features/product-selection";
import { projectCatalog } from "../src/ontos/catalog-model";
import { getDictionary } from "../src/i18n";

const purchase = (availability: "OUT_OF_STOCK" | "IN_STOCK" | "UNKNOWN", locale: string) => {
  const {
    details: [product],
  } = projectCatalog(
    {
      market: { configured: true, currency: "CZK", marketId: "owner-market" },
      products: [
        {
          availability,
          currency: "CZK",
          grossPriceMinor: 47_500,
          id: "owner-shirt",
          name: "Owner shirt",
          slug: "owner-shirt",
          stockOnHand: availability === "IN_STOCK" ? 2 : 0,
          stockTracked: true,
          variantRecords: [
            {
              active: true,
              attributes: "M",
              availability,
              grossPriceMinor: 47_500,
              id: "owner-size-m",
              name: "M",
              sku: "OWNER-M",
              stockOnHand: availability === "IN_STOCK" ? 2 : 0,
            },
          ],
          variantSummary: {
            count: 1,
            minGrossPriceMinor: 47_500,
            stockOnHand: availability === "IN_STOCK" ? 2 : 0,
          },
        },
      ],
    },
    [],
  );
  return renderToStaticMarkup(
    <ProductPurchase
      dictionary={getDictionary(locale)}
      locale={locale}
      product={product}
      selection={selectProductDetail(product, "owner-size-m")}
    />,
  );
};

describe("sold-out purchase feedback", () => {
  it("keeps both desktop steppers inside the field's horizontal focus and validation control", () => {
    const html = purchase("IN_STOCK", "cs");
    const [desktopControl] =
      html.match(/<div[^>]*data-part="control"[^>]*>[\s\S]*?<\/div>/gu) ?? [];
    expect(desktopControl).toMatch(
      /data-part="decrement-trigger"[\s\S]*data-part="input"[\s\S]*data-part="increment-trigger"/u,
    );
    expect(desktopControl).toContain("numeric-input-focus-owner");
    expect(desktopControl).toContain("numeric-input-validation");
  });

  it.each(["cs", "en"])("explains sold-out stock without a shop outage caption in %s", (locale) => {
    const dictionary = getDictionary(locale);
    const html = purchase("OUT_OF_STOCK", locale);
    expect(html).toContain(dictionary.stock.unavailable);
    expect(html).not.toContain(dictionary.commerceUnavailable);
    expect(html).not.toContain('id="purchase-unavailable"');
    expect(html).not.toContain('aria-describedby="purchase-unavailable');
    const buttons = html.match(/<button\b[^>]*>/gu) ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button).toContain('disabled=""');
    }
  });

  it.each(["cs", "en"])("keeps real purchase-context failures visible in %s", (locale) => {
    const dictionary = getDictionary(locale);
    for (const availability of ["IN_STOCK", "UNKNOWN"] as const) {
      const html = purchase(availability, locale);
      expect(html).toContain(dictionary.commerceUnavailable);
      expect(html).toContain('id="purchase-unavailable"');
      expect(html).toContain('aria-describedby="purchase-unavailable');
    }
  });
});
