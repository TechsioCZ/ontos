// @rstest-environment happy-dom
// @rstest-environment-options {"url":"https://shop.example.test"}
import { afterEach, expect, it } from "@rstest/core";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ProductView } from "../src/features/product-view";
import { CartProvider } from "../src/features/cart-provider";
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

let mounted: { container: HTMLDivElement; root: Root } | null = null;
const mount = (view: ReactNode) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted = { container, root };
  flushSync(() => {
    root.render(
      <CartProvider
        imageHosts={[]}
        scope={{ currency: "CZK", legalEntityId: "legal", marketId: "market", tenantId: "tenant" }}
      >
        {view}
      </CartProvider>,
    );
  });
  return container;
};

afterEach(() => {
  if (mounted !== null) {
    const { container, root } = mounted;
    flushSync(() => root.unmount());
    container.remove();
    mounted = null;
  }
});

it.each(["cs", "en"])("renders a safe inactive share action during SSR in %s", (locale) => {
  const dictionary = getDictionary(locale);
  const html = renderToStaticMarkup(
    <ProductView dictionary={dictionary} locale={locale} product={product} />,
  );
  expect(html).toMatch(
    new RegExp(`<a [^>]*aria-disabled="true"[^>]*>${dictionary.sendToFriend}</a>`, "u"),
  );
  expect(html).not.toContain("mailto:");
});

it.each(["cs", "en"])("shares only the resolved variant and localized product in %s", (locale) => {
  const container = mount(
    <ProductView
      dictionary={getDictionary(locale)}
      locale={locale}
      product={product}
      variantId="owner-variant"
    />,
  );
  const href = container.querySelector('a[href^="mailto:"]')?.getAttribute("href");
  expect(href).toContain(
    encodeURIComponent(
      `https://shop.example.test/${locale}/produkt/owner-product?variantId=owner-variant`,
    ),
  );
  expect(href).toContain("mailto:?subject=Owner%20product&body=");
});

it("omits an invalid variant selector from the draft while the purchase remains blocked", () => {
  const container = mount(
    <ProductView
      dictionary={getDictionary("cs")}
      locale="cs"
      product={product}
      variantId="unknown"
    />,
  );
  const href = container.querySelector('a[href^="mailto:"]')?.getAttribute("href");
  expect(href).toContain(
    `body=${encodeURIComponent("https://shop.example.test/cs/produkt/owner-product")}`,
  );
  expect(href).not.toContain("variantId%3Dunknown");
  expect(container.querySelector('[role="spinbutton"]')).toBeNull();
});
