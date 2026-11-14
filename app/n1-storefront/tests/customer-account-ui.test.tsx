import { describe, expect } from "@rstest/core";
import { it } from "effect-rstest";
import { Effect, Schema } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { CustomerOrdersList } from "../src/features/customer-orders-panel";
import { CustomerOrderContent } from "../src/features/customer-order-detail";
import { CustomerOrderSchema } from "../src/ontos/customer-orders";
import { getDictionary } from "../src/i18n";

const order = {
  createdAt: "2026-11-04T12:00:00.000Z",
  currency: "EUR",
  detail: {
    billingAddress: null,
    contact: { email: "customer@example.invalid", name: "Customer" },
    deliveryAddress: { city: "Praha", country: "CZ", postalCode: "11000", street: "Test 1" },
    deliveryRecipient: null,
    lines: [
      {
        productId: "product-1",
        productName: "Real stored item",
        quantity: 2,
        sku: "SKU-1",
        unitPriceMinor: 1000,
        vatRate: 21,
      },
    ],
    note: "<img src=x onerror=alert(1)>",
  },
  id: "order-1",
  market: {
    currency: "EUR",
    exchangeRate: "0.04",
    marketCode: "N1-EU",
    marketId: "71000000-0000-4000-8000-000000000093",
    roundingMinor: 1,
  },
  number: "N1-42",
  preview: [
    {
      name: "Real stored item",
      productId: "product-1",
      quantity: 2,
      sku: "SKU-1",
      variantId: null,
      variantName: null,
    },
  ],
  pricesIncludeVat: true,
  shipping: { label: "PPL", method: "PPL", priceMinor: 500, vatRate: 21 },
  status: "NEW",
  totalMinor: 2500,
  totalVatMinor: 434,
  updatedAt: "2026-11-04T12:30:00.000Z",
} satisfies typeof CustomerOrderSchema.Encoded;

describe("native customer account presentation", () => {
  for (const locale of ["cs", "en"]) {
    it.effect(`shows the stored shipping method in ${locale}`, () =>
      Effect.gen(function* storedShippingMethod() {
        const value = yield* Schema.decodeEffect(CustomerOrderSchema)({
          ...order,
          shipping: { ...order.shipping, label: "PPL Private" },
        });
        const dictionary = getDictionary(locale);
        const html = renderToStaticMarkup(
          <CustomerOrderContent dictionary={dictionary} locale={locale} order={value} />,
        );
        expect(html).toContain(`${dictionary.accountPage.shipping} (PPL Private)`);
      }),
    );
    it.effect(`does not invent a missing shipping method in ${locale}`, () =>
      Effect.gen(function* missingShippingMethod() {
        const value = yield* Schema.decodeEffect(CustomerOrderSchema)({ ...order, shipping: null });
        const dictionary = getDictionary(locale);
        const html = renderToStaticMarkup(
          <CustomerOrderContent dictionary={dictionary} locale={locale} order={value} />,
        );
        expect(html).toContain(dictionary.accountPage.shipping);
        expect(html).toContain(dictionary.accountPage.unknown);
        expect(html).not.toContain("PPL");
        expect(html).not.toContain(`${dictionary.accountPage.shipping} ()`);
        const blank = yield* Schema.decodeEffect(CustomerOrderSchema)({
          ...order,
          shipping: { ...order.shipping, label: "   " },
        });
        const blankHtml = renderToStaticMarkup(
          <CustomerOrderContent dictionary={dictionary} locale={locale} order={blank} />,
        );
        expect(blankHtml).toContain(dictionary.accountPage.shipping);
        expect(blankHtml).not.toContain(`${dictionary.accountPage.shipping} (`);
      }),
    );
    it.effect(`renders the shipping method as literal text in ${locale}`, () =>
      Effect.gen(function* literalShippingMethod() {
        const value = yield* Schema.decodeEffect(CustomerOrderSchema)({
          ...order,
          shipping: { ...order.shipping, label: "$& <script>owner label</script>" },
        });
        const dictionary = getDictionary(locale);
        const html = renderToStaticMarkup(
          <CustomerOrderContent dictionary={dictionary} locale={locale} order={value} />,
        );
        expect(html).toContain(
          `${dictionary.accountPage.shipping} ($&amp; &lt;script&gt;owner label&lt;/script&gt;)`,
        );
        expect(html).not.toContain("<script>owner label</script>");
      }),
    );
    it.effect(`keeps both stored metadata timestamps in ${locale}`, () =>
      Effect.gen(function* storedMetadataTimes() {
        const value = yield* Schema.decodeEffect(CustomerOrderSchema)(order);
        const dictionary = getDictionary(locale);
        const html = renderToStaticMarkup(
          <CustomerOrderContent dictionary={dictionary} locale={locale} order={value} />,
        );
        const formatter = new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "cs-CZ", {
          dateStyle: "medium",
          timeStyle: "short",
        });
        expect(html).toContain(formatter.format(Date.parse(order.createdAt)));
        expect(html).toContain(formatter.format(Date.parse(order.updatedAt)));
        expect(html).toContain(
          new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "cs-CZ", {
            dateStyle: "long",
          }).format(Date.parse(order.createdAt)),
        );
      }),
    );
    it.effect(`keeps invalid and absent order dates explicit in ${locale}`, () =>
      Effect.gen(function* unavailableOrderDates() {
        const value = yield* Schema.decodeEffect(CustomerOrderSchema)({
          ...order,
          createdAt: "not-a-date",
          updatedAt: null,
        });
        const dictionary = getDictionary(locale);
        const html = renderToStaticMarkup(
          <CustomerOrderContent dictionary={dictionary} locale={locale} order={value} />,
        );
        expect(html.split(dictionary.accountPage.unknown).length).toBeGreaterThan(2);
        expect(html).not.toContain(dictionary.accountPage.updatedAt);
        expect(html).not.toContain("Invalid Date");
      }),
    );
  }
  it.effect("keeps a historical order currency when the storefront locale is Czech", () =>
    Effect.gen(function* historicalCurrency() {
      const value = yield* Schema.decodeEffect(CustomerOrderSchema)(order);
      const html = renderToStaticMarkup(
        <CustomerOrderContent dictionary={getDictionary("cs")} locale="cs" order={value} />,
      );
      expect(html).toContain("25,00 €");
      expect(html).not.toContain("Kč");
      expect(html).toContain("Real stored item");
      expect(html).toContain("customer@example.invalid");
    }),
  );
  it.effect(
    "does not turn one page of orders into a global spend or disclose detail contacts in a list",
    () =>
      Effect.gen(function* pagedHistory() {
        const value = yield* Schema.decodeEffect(CustomerOrderSchema)(order);
        const html = renderToStaticMarkup(
          <CustomerOrdersList
            data={{ offset: 0, orders: [value], pageSize: 50, total: 51 }}
            dictionary={getDictionary("cs")}
            locale="cs"
          />,
        );
        expect(html).toContain("51");
        expect(html).toContain(getDictionary("cs").accountPage.unknown);
        expect(html).toContain("/cs/ucet/objednavky/order-1");
        expect(html).not.toContain("customer@example.invalid");
        expect(html).not.toContain("Test 1");
        expect(html).toContain(
          new Intl.DateTimeFormat("cs-CZ", { dateStyle: "medium" }).format(
            Date.parse(order.createdAt),
          ),
        );
        expect(html).not.toContain(
          new Intl.DateTimeFormat("cs-CZ", { dateStyle: "medium", timeStyle: "short" }).format(
            Date.parse(order.createdAt),
          ),
        );
      }),
  );
  it.effect("renders owner notes as text and does not invent stored line totals or media", () =>
    Effect.gen(function* safeStoredDetail() {
      const value = yield* Schema.decodeEffect(CustomerOrderSchema)(order);
      const html = renderToStaticMarkup(
        <CustomerOrderContent dictionary={getDictionary("en")} locale="en" order={value} />,
      );
      expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
      expect(html).not.toContain("<img src=");
      expect(html).toContain("Unit price");
      expect(html).not.toContain("€20.00");
    }),
  );
});
