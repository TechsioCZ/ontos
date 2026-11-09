import { beforeEach, describe, expect, rs } from "@rstest/core";
import { it } from "effect-rstest";
import { Effect, Schema } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { CheckoutView } from "../src/features/checkout-view";
import { useCheckout } from "../src/features/use-checkout";
import { getDictionary } from "../src/i18n";
import type { CheckoutOptions } from "../src/ontos/checkout-server";
import { CheckoutResultSchema } from "../src/ontos/checkout";

rs.mock("next/navigation", () => ({ useRouter: () => ({ push: rs.fn(), refresh: rs.fn() }) }));
rs.mock("../src/features/use-checkout", () => ({ useCheckout: rs.fn() }));

const options = {
  countryCodes: ["CZ"],
  paymentAvailable: false,
  scope: {
    currency: "CZK",
    legalEntityId: "71000000-0000-4000-8000-000000000099",
    marketId: "market-cz",
    tenantId: "70000000-0000-4000-8000-000000000099",
  },
  shippingMethods: [{ id: "PPL", priceMinor: 12_900, title: "PPL" }],
  state: "ready",
} satisfies CheckoutOptions;
const d = getDictionary("cs");
const state = (): ReturnType<typeof useCheckout> => ({
  cart: {
    acceptPrice: () => false,
    add: () => false,
    clear: () => {},
    clearSubmitted: () => false,
    entries: [],
    error: false,
    imageHosts: [],
    loaded: true,
    remove: () => false,
    scope: options.scope,
    update: () => false,
  },
  dismiss: () => {},
  guarded: false,
  guardLoaded: true,
  handleEdit: () => {},
  notice: null,
  progress: "idle",
  quote: null,
  receipt: null,
  receiptEntries: [],
  recover: () => {},
  submit: () => {},
});
const populatedState = (): ReturnType<typeof useCheckout> => {
  const checkout = state();
  if (checkout.cart === null) {
    throw new Error("Missing test cart");
  }
  return {
    ...checkout,
    cart: {
      ...checkout.cart,
      entries: [
        {
          expectedUnitPriceMinor: 100,
          image: null,
          name: "Item",
          productId: "p1",
          quantity: 1,
          sku: "P1",
          slug: "item",
          unit: "ks",
          variantName: "",
        },
      ],
    },
  };
};
const rejected = () =>
  Schema.decodeUnknownSync(CheckoutResultSchema)({
    issues: [{ code: "OUT_OF_STOCK", productId: "p1" }],
    lines: [],
    orderId: null,
    orderNumber: null,
    outcome: "REJECTED",
    scope: options.scope,
    shippingPriceMinor: null,
    status: null,
    totalMinor: null,
    totalVatMinor: null,
  });

const render = (checkout: ReturnType<typeof useCheckout>, locale = "cs") => {
  rs.mocked(useCheckout).mockReturnValue(checkout);
  return renderToStaticMarkup(
    <CheckoutView dictionary={getDictionary(locale)} locale={locale} options={options} />,
  );
};

beforeEach(() => {
  rs.clearAllMocks();
});

describe("checkout action accessibility", () => {
  it.effect(
    "keeps one busy submit with the localized operation name while verifying or placing",
    () =>
      Effect.sync(() => {
        for (const locale of ["cs", "en"]) {
          const dictionary = getDictionary(locale);
          for (const progress of ["quote", "place"] as const) {
            const html = render({ ...populatedState(), progress }, locale);
            const button = /<button(?=[^>]*type="submit")[^>]*>[\s\S]*?<\/button>/u.exec(html)?.[0];
            const label =
              progress === "place" ? dictionary.checkout.sending : dictionary.checkout.checking;
            expect(html.split('type="submit"')).toHaveLength(2);
            expect(button).toContain('aria-busy="true"');
            expect(button).toContain(`aria-label="${label}"`);
            expect(button).toContain('disabled=""');
            expect(button).toContain(label);
          }
        }
      }),
  );

  it.effect("keeps the full verification purpose as the accessible name when idle", () =>
    Effect.sync(() => {
      for (const locale of ["cs", "en"]) {
        const html = render(populatedState(), locale);
        const button = /<button(?=[^>]*type="submit")[^>]*>[\s\S]*?<\/button>/u.exec(html)?.[0];
        expect(button).toContain(`aria-label="${getDictionary(locale).checkout.verify}"`);
        expect(button).not.toContain('aria-busy="true"');
        expect(button).not.toContain('disabled=""');
      }
    }),
  );
});

describe("checkout cart state and navigation", () => {
  it.effect("offers the home action for a loaded, genuinely empty cart", () =>
    Effect.sync(() => {
      const html = render(state());
      expect(html).toContain(d.shopping.empty);
      expect(html).toContain(d.shopping.backHome);
      expect(html).toContain('href="/cs"');
      expect(html).not.toContain('href="/cs/kosik"');
    }),
  );

  it.effect("does not disguise storage, scope, loading or unresolved-order states as empty", () =>
    Effect.sync(() => {
      const base = state();
      if (base.cart === null) {
        throw new Error("Missing test cart");
      }
      for (const checkout of [
        { ...base, cart: { ...base.cart, error: true } },
        { ...base, cart: { ...base.cart, scope: null } },
        { ...base, cart: { ...base.cart, loaded: false } },
        { ...base, notice: "storage" as const },
        { ...base, guardLoaded: false },
        { ...base, guarded: true },
      ]) {
        expect(render(checkout)).not.toContain(d.shopping.backHome);
      }
      expect(render({ ...base, guarded: true })).toContain(d.checkout.checkResult);
    }),
  );

  it.effect("prevents back navigation while checkout is verifying or placing", () =>
    Effect.sync(() => {
      const base = state();
      if (base.cart === null) {
        throw new Error("Missing test cart");
      }
      const cart = {
        ...base.cart,
        entries: [
          {
            expectedUnitPriceMinor: 100,
            image: null,
            name: "Item",
            productId: "p1",
            quantity: 1,
            sku: "P1",
            slug: "item",
            unit: "ks",
            variantName: "",
          },
        ],
      };
      for (const progress of ["quote", "place"] as const) {
        const html = render({ ...base, cart, progress });
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*Zpět/u);
        expect(html).not.toContain('href="/cs/kosik"');
      }
      expect(render({ ...base, cart })).toContain('href="/cs/kosik"');
    }),
  );
});

describe("checkout operation feedback", () => {
  it.effect("announces one specific owner refusal instead of two generic instructions", () =>
    Effect.sync(() => {
      const html = render({ ...populatedState(), notice: "invalid", quote: rejected() });
      expect(html.split(d.checkout.rejected)).toHaveLength(2);
      expect(html).not.toContain(d.checkout.invalid);
      expect(html.split('role="alert"')).toHaveLength(2);
    }),
  );

  it.effect("removes the previous refusal while a fresh quote is pending", () =>
    Effect.sync(() => {
      const html = render({ ...populatedState(), progress: "quote", quote: rejected() });
      expect(html).not.toContain(d.checkout.rejected);
      expect(html).not.toContain('role="alert"');
      expect(html).toContain(d.checkout.checking);
    }),
  );

  it.effect("keeps unresolved orders visible as a persistent recovery warning", () =>
    Effect.sync(() => {
      const html = render({ ...populatedState(), guarded: true, notice: "uncertain" });
      expect(html).toMatch(/role="status"[^>]*>[\s\S]*Neodesílejte ji znovu/u);
      expect(html).toContain(d.checkout.checkResult);
      expect(html).not.toContain('type="submit"');
    }),
  );

  it.effect("does not mistake the retained guard of a confirmed order for an unknown result", () =>
    Effect.sync(() => {
      const receipt = Schema.decodeUnknownSync(CheckoutResultSchema)({
        ...rejected(),
        issues: [],
        lines: [
          {
            lineTotalMinor: 100,
            name: "Item",
            productId: "p1",
            quantity: 1,
            sku: "P1",
            unitPriceMinor: 100,
          },
        ],
        orderId: "o1",
        orderNumber: "N1-1",
        outcome: "PLACED" as const,
        shippingPriceMinor: 12_900,
        status: "NEW" as const,
        totalMinor: 13_000,
        totalVatMinor: 2256,
      });
      const checkout = { ...populatedState(), guarded: true, quote: rejected(), receipt };
      const html = render(checkout);
      expect(html).toContain(d.checkout.confirmed);
      expect(html).not.toContain(d.checkout.uncertain);
      expect(html).not.toContain(d.checkout.rejected);
      const preserved = render({ ...checkout, notice: "cart-preserved" });
      expect(preserved).toContain(d.checkout.cartPreserved);
      expect(preserved).toContain('role="status"');
      expect(preserved).not.toContain(d.checkout.uncertain);
      expect(preserved).not.toContain('role="alert"');
      for (const notice of ["storage", "unavailable"] as const) {
        const failure = render({ ...checkout, notice });
        expect(failure).toContain(d.checkout[notice]);
        expect(failure).toContain('role="alert"');
        expect(failure).not.toContain(d.checkout.uncertain);
      }
    }),
  );
});
