import { beforeEach, describe, expect, rs } from "@rstest/core";
import { it } from "effect-rstest";
import { Effect } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { CheckoutView } from "../src/features/checkout-view";
import { useCheckout } from "../src/features/use-checkout";
import { getDictionary } from "../src/i18n";
import type { CheckoutOptions } from "../src/ontos/checkout-server";

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
const render = (checkout: ReturnType<typeof useCheckout>) => {
  rs.mocked(useCheckout).mockReturnValue(checkout);
  return renderToStaticMarkup(<CheckoutView dictionary={d} locale="cs" options={options} />);
};

beforeEach(() => {
  rs.clearAllMocks();
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
        expect(html).toMatch(/<a[^>]*aria-disabled="true"[^>]*>[^<]*Zpět/u);
      }
      expect(render({ ...base, cart })).toContain('href="/cs/kosik"');
    }),
  );
});
