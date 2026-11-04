import { describe, expect, it } from "effect-rstest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CartSummary } from "../src/features/cart-summary";
import { requestForCart } from "../src/features/cart-quote-request";
import { getDictionary } from "../src/i18n";
import type { CartQuote } from "../src/ontos/cart-quote";

const cart: NonNullable<Parameters<typeof requestForCart>[0]> = {
  entries: [
    {
      expectedUnitPriceMinor: 12_100,
      image: null,
      name: "Product",
      productId: "p1",
      quantity: 2,
      sku: "SKU1",
      slug: "product",
      unit: "ks",
      variantId: "v1",
      variantName: "Large",
    },
  ],
  error: false,
  loaded: true,
  scope: {
    currency: "CZK",
    legalEntityId: "71000000-0000-4000-8000-000000000002",
    marketId: "n1-cz",
    tenantId: "71000000-0000-4000-8000-000000000001",
  },
};

describe("cart quote request admission", () => {
  it("does not automatically validate a draft whose storage failed", () => {
    expect(requestForCart({ ...cart, error: true }, "cs", false)).toBeNull();
  });

  it("requires a loaded, scoped, nonempty selection and valid quantity draft", () => {
    for (const draft of [
      null,
      { ...cart, loaded: false },
      { ...cart, scope: null },
      { ...cart, entries: [] },
    ]) {
      expect(requestForCart(draft, "cs", false)).toBeNull();
    }
    expect(requestForCart(cart, "cs", true)).toBeNull();
  });

  it("sends only current purchasing values and scope, without display metadata", () => {
    expect(requestForCart(cart, "en", false)).toEqual({
      lines: [{ expectedUnitPriceMinor: 12_100, productId: "p1", quantity: 2, variantId: "v1" }],
      locale: "en",
      scope: cart.scope,
    });
  });
});

describe("automatic cart quote summary", () => {
  it("keeps explicit retry and blocks checkout when the owner is unavailable", () => {
    const d = getDictionary("cs");
    const html = renderToStaticMarkup(
      createElement(CartSummary, {
        currency: "CZK",
        dictionary: d,
        invalid: false,
        locale: "cs",
        quote: { result: null, state: "unavailable", verify: () => {} },
        verified: null,
      }),
    );
    expect(html).toContain(d.shopping.verify);
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain(d.shopping.unresolved);
  });

  it("continues with a verified total without another manual verification step", () => {
    const { scope } = cart;
    if (scope === null) {
      throw new Error("Scoped fixture required");
    }
    const verified: CartQuote = {
      issues: [],
      outcome: "VALID",
      scope,
      totalMinor: 24_200,
      totalVatMinor: 4200,
    };
    const d = getDictionary("cs");
    const html = renderToStaticMarkup(
      createElement(CartSummary, {
        currency: "CZK",
        dictionary: d,
        invalid: false,
        locale: "cs",
        quote: { result: verified, state: "ready", verify: () => {} },
        verified,
      }),
    );
    expect(html).not.toContain(d.shopping.verify);
    expect(html).toContain(d.shopping.checkout);
    expect(html).toContain('href="/cs/pokladna"');
    expect(html).not.toContain('aria-disabled="true"');
  });
});
