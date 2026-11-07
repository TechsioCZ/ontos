import { describe, expect, it } from "effect-rstest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Schema } from "effect";
import { CheckoutItems, CheckoutShipping } from "../src/features/checkout-panels";
import type { CheckoutOptions } from "../src/ontos/checkout-server";
import { getDictionary } from "../src/i18n";
import { CheckoutResultSchema } from "../src/ontos/checkout";
import type { CheckoutResult } from "../src/ontos/checkout";
import type { CartEntry } from "../src/features/cart-state";

const result = Schema.decodeUnknownSync(CheckoutResultSchema)({
  issues: [],
  lines: [
    {
      lineTotalMinor: null,
      name: "Saved shirt",
      productId: "product-1",
      quantity: 2,
      sku: "S",
      unitPriceMinor: 1210,
      variantId: "size/M",
      variantName: "Saved medium",
    },
  ],
  orderId: "order-1",
  orderNumber: "N1-42",
  outcome: "REPLAYED",
  productPresentation: [
    {
      image: "/obrazky/product-1/a973f79c-0f97-476f-a003-f6db822156fb",
      productId: "product-1",
      slug: "current shirt",
    },
  ],
  scope: {
    currency: "CZK",
    legalEntityId: "71000000-0000-4000-8000-000000000099",
    marketId: "market-1",
    tenantId: "71000000-0000-4000-8000-000000000098",
  },
  shippingPriceMinor: 12_900,
  status: "NEW",
  totalMinor: 15_320,
  totalVatMinor: 2659,
});

const render = (receipt: CheckoutResult, entries: readonly CartEntry[] = []) =>
  renderToStaticMarkup(
    createElement(CheckoutItems, {
      currency: "CZK",
      dictionary: getDictionary("cs"),
      entries,
      imageHosts: [],
      locale: "cs",
      result: receipt,
    }),
  );

describe("owner shipping availability", () => {
  const options = {
    countryCodes: ["CZ"],
    paymentAvailable: false,
    scope: result.scope,
    shippingMethods: [],
    state: "ready",
  } satisfies CheckoutOptions;

  for (const locale of ["cs", "en"] as const) {
    it(`announces unavailable shipping without an empty required radio group (${locale})`, () => {
      const d = getDictionary(locale);
      const html = renderToStaticMarkup(
        createElement(CheckoutShipping, {
          dictionary: d,
          disabled: false,
          locale,
          onChange: () => {},
          options,
          value: null,
        }),
      );
      expect(html).toContain('role="alert"');
      expect(html).toContain(d.fulfillment.noShipping);
      expect(html).not.toContain('role="radiogroup"');
      expect(html).not.toContain('type="radio"');
    });
  }

  it("keeps the owner's real shipping choice available without an error alert", () => {
    const html = renderToStaticMarkup(
      createElement(CheckoutShipping, {
        dictionary: getDictionary("cs"),
        disabled: false,
        locale: "cs",
        onChange: () => {},
        options: {
          ...options,
          shippingMethods: [{ id: "PPL", priceMinor: 12_900, title: "PPL" }],
        },
        value: "PPL",
      }),
    );
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('type="radio"');
    expect(html).toContain('value="PPL"');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain(getDictionary("cs").fulfillment.noShipping);
  });
});

describe("recovered checkout item presentation", () => {
  it("renders the exact current product thumbnail and encoded variant link with saved commercial data", () => {
    const html = render(result);
    expect(html).toContain("/cs/produkt/current%20shirt?variantId=size%2FM");
    expect(html).toContain("<img");
    expect(html).toContain(
      encodeURIComponent("/obrazky/product-1/a973f79c-0f97-476f-a003-f6db822156fb"),
    );
    expect(html).toContain("Saved shirt");
    expect(html).toContain("Saved medium");
    expect(html).toContain("Kusů: 2");
    expect(html).toContain("12,1\u00A0Kč");
  });
  it("prefers the exact cart selection while ignoring other variant and product entries", () => {
    const entry = {
      expectedUnitPriceMinor: 99_999,
      image: "/obrazky/product-1/a973f79c-0f97-476f-a003-f6db822156fb",
      name: "Unverified cart name",
      productId: "product-1",
      quantity: 5,
      sku: "S",
      slug: "cart-slug",
      unit: "ks",
      variantId: "size/M",
      variantName: "Unverified cart size",
    };
    const html = render(result, [entry]);
    expect(html).toContain("/cs/produkt/cart-slug?variantId=size%2FM");
    expect(html).not.toContain("Unverified cart name");
    expect(html).not.toContain("Unverified cart size");
    expect(html).toContain("12,1\u00A0Kč");
    expect(html).not.toContain("999,99");
    expect(render(result, [{ ...entry, variantId: "size/L" }])).toContain(
      "/cs/produkt/current%20shirt?variantId=size%2FM",
    );
  });
  it("keeps historical rows readable without guessing media or routes from unrelated metadata", () => {
    const html = render(
      Schema.decodeUnknownSync(CheckoutResultSchema)({
        ...result,
        productPresentation: [{ image: null, productId: "other", slug: "other" }],
      }),
    );
    expect(html).toContain("Saved shirt");
    expect(html).not.toContain("/cs/produkt/");
    expect(html).not.toContain("<img");
  });
});
