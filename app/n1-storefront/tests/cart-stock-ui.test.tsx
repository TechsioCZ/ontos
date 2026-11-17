import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import { renderToStaticMarkup } from "react-dom/server";
import { CartView } from "../src/features/cart-view";
import { useCart } from "../src/features/cart-provider";
import { useCartQuote } from "../src/features/use-cart-quote";
import { getDictionary } from "../src/i18n";

rs.mock("next/navigation", () => ({ useRouter: () => ({ refresh: rs.fn() }) }));
rs.mock("../src/features/cart-provider", () => ({ useCart: rs.fn() }));
rs.mock("../src/features/use-cart-quote", () => ({ useCartQuote: rs.fn() }));

const scope = {
  currency: "CZK",
  legalEntityId: "seller",
  marketId: "market",
  tenantId: "tenant",
} as const;
const entry = {
  expectedUnitPriceMinor: 10_000,
  image: null,
  minimumQuantity: 1,
  name: "Owner product",
  productId: "product",
  quantity: 2,
  sku: "SKU",
  slug: "product",
  unit: "ks",
  variantId: "size-m",
  variantName: "M",
};
const quote = {
  issues: [],
  outcome: "VALID",
  scope,
  totalMinor: 20_000,
  totalVatMinor: 3471,
} as const;

beforeEach(() => {
  rs.mocked(useCart).mockReturnValue({
    acceptPrice: () => false,
    add: () => true,
    clear: () => {},
    clearSubmitted: () => false,
    entries: [entry],
    error: false,
    imageHosts: [],
    loaded: true,
    remove: () => true,
    scope,
    update: () => true,
  });
});

describe("cart controls use current owner stock", () => {
  it.each(["cs", "en"])(
    "bounds a legacy hintless cart and disables increment at max in %s",
    (locale) => {
      rs.mocked(useCartQuote).mockReturnValue({
        result: {
          ...quote,
          stocks: [{ productId: entry.productId, stockQuantity: 2, variantId: entry.variantId }],
        },
        state: "ready",
        stocks: [{ productId: entry.productId, stockQuantity: 2, variantId: entry.variantId }],
        verify: () => {},
      });
      const html = renderToStaticMarkup(
        <CartView dictionary={getDictionary(locale)} locale={locale} />,
      );
      const input = /<input[^>]*role="spinbutton"[^>]*>/u.exec(html)?.[0];
      expect(input).toContain('aria-valuemax="2"');
      expect(input).toContain('aria-valuenow="2"');
      const increment = /<button[^>]*data-part="increment-trigger"[^>]*>/u.exec(html)?.[0];
      expect(increment).toContain('disabled=""');
      expect(html).toContain(`href="/${locale}/pokladna"`);
    },
  );
  it("blocks checkout when fresh catalog stock falls below the saved quantity", () => {
    rs.mocked(useCartQuote).mockReturnValue({
      result: {
        ...quote,
        stocks: [{ productId: entry.productId, stockQuantity: 1, variantId: entry.variantId }],
      },
      state: "ready",
      stocks: [{ productId: entry.productId, stockQuantity: 1, variantId: entry.variantId }],
      verify: () => {},
    });
    const html = renderToStaticMarkup(<CartView dictionary={getDictionary("cs")} locale="cs" />);
    expect(html).not.toContain('href="/cs/pokladna"');
    expect(html).toContain('aria-valuemax="1"');
  });
});
