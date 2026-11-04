import { describe, expect } from "@rstest/core";
import { it } from "effect-rstest";
import { Effect, Schema } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { CheckoutFields } from "../src/features/checkout-fields";
import { CheckoutShipping, CheckoutTotals } from "../src/features/checkout-panels";
import { CheckoutResultSchema } from "../src/ontos/checkout";
import { getDictionary } from "../src/i18n";

const scope = {
  currency: "CZK",
  legalEntityId: "71000000-0000-4000-8000-000000000099",
  marketId: "market-cz",
  tenantId: "70000000-0000-4000-8000-000000000099",
} satisfies (typeof CheckoutResultSchema.Encoded)["scope"];

describe("N1 guest checkout composition", () => {
  it.effect("offers only the supported address fields and the actual market country", () =>
    Effect.sync(() => {
      const html = renderToStaticMarkup(
        <CheckoutFields
          countryCodes={["CZ"]}
          dictionary={getDictionary("cs")}
          disabled={false}
          locale="cs"
          onEdit={() => {}}
        />,
      );
      for (const field of [
        "firstName",
        "lastName",
        "street",
        "city",
        "postalCode",
        "country",
        "email",
        "phone",
      ]) {
        expect(html).toContain(`name="${field}"`);
      }
      for (const omitted of ["company", "street2", "region", "customerAccountId", "partyId"]) {
        expect(html).not.toContain(`name="${omitted}"`);
      }
      expect(html).toContain('value="CZ"');
      expect(html).not.toContain('value="US"');
    }),
  );

  it.effect(
    "shipping selection uses owner methods and prices without fixture pickup or estimates",
    () =>
      Effect.sync(() => {
        const html = renderToStaticMarkup(
          <CheckoutShipping
            dictionary={getDictionary("cs")}
            disabled={false}
            locale="cs"
            onChange={() => {}}
            options={{
              countryCodes: ["CZ"],
              paymentAvailable: false,
              scope,
              shippingMethods: [{ id: "CESKA_POSTA", priceMinor: 11_900, title: "Česká pošta" }],
              state: "ready",
            }}
            value="CESKA_POSTA"
          />,
        );
        expect(html).toContain("Česká pošta");
        expect(html).toContain("119");
        expect(html).not.toContain("Parcel Shop");
        expect(html).not.toContain("2-3");
      }),
  );

  it.effect(
    "keeps shipping VAT in the native net amount instead of subtracting shipping twice",
    () =>
      Effect.gen(function* shippingVatBreakdown() {
        const result = yield* Schema.decodeUnknownEffect(CheckoutResultSchema)({
          issues: [],
          lines: [
            {
              lineTotalMinor: 2420,
              name: "Real owner item",
              productId: "p1",
              quantity: 1,
              sku: "P1",
              unitPriceMinor: 2420,
            },
          ],
          orderId: null,
          orderNumber: null,
          outcome: "VALID",
          scope,
          shippingPriceMinor: 12_900,
          status: null,
          totalMinor: 15_320,
          totalVatMinor: 2659,
        });
        const html = renderToStaticMarkup(
          <CheckoutTotals
            currency="CZK"
            dictionary={getDictionary("cs")}
            locale="cs"
            result={result}
          />,
        );
        expect(html).toContain("Cena bez DPH včetně dopravy");
        expect(html).toContain("126,61");
        expect(html).toContain("153,2");
        expect(html).not.toContain("-2,39");
        expect(html).toContain("Z toho doprava");
      }),
  );

  it.effect("does not present missing owner amounts as free shipping or a confirmed total", () =>
    Effect.sync(() => {
      const d = getDictionary("en");
      const html = renderToStaticMarkup(
        <CheckoutTotals currency="CZK" dictionary={d} locale="en" result={null} />,
      );
      expect(html).toContain(d.shopping.unresolved);
      expect(html).not.toContain("CZK 0");
    }),
  );
});
