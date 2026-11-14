import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectProducts as project } from "@/ontos/catalog-projection";
import { readCartProducts, readProducts } from "@/ontos/catalog-server";
import { callAction, readRecords } from "@/ontos/gateway";
import { readAccount } from "@/ontos/account";
import { quoteCart } from "@/ontos/quote";
import { ownerIssueText } from "@/ontos/owner-issues";
import { POST as orderRoute } from "@/app/api/ontos/orders/route";
import { createCheckoutDraft } from "@/features/checkout/checkout-state";
import { cs } from "@/i18n/cs";
import { sk } from "@/i18n/sk";
import { en } from "@/i18n/en";
import type { MoneyFormat } from "@/lib/format";
import { getActiveMarket } from "@/ontos/active-market";
import { testMarket } from "../support/market-fixture";

type AnyAsync = (...args: unknown[]) => Promise<unknown>;
vi.mock("@/ontos/catalog-server", () => ({
  readCartProducts: vi.fn<AnyAsync>(),
  readProducts: vi.fn<AnyAsync>(),
}));
vi.mock("@/ontos/gateway", () => ({
  callAction: vi.fn<AnyAsync>(),
  readRecords: vi.fn<AnyAsync>(),
  OntosError: class extends Error {},
}));
vi.mock("@/ontos/account", () => ({ readAccount: vi.fn<AnyAsync>() }));

const eur: MoneyFormat = { currency: "EUR", locale: "en-GB" };
const czechOnly = /[ěřůĚŘŮ]/u;
const line = { label: "Bolts (M8)", unit: "pcs", minimumQuantity: 10, packageQuantity: 50 };
const codes = [
  "NOT_FOUND",
  "NOT_AVAILABLE",
  "NOT_OFFERED_IN_MARKET",
  "VARIANT_REQUIRED",
  "OUT_OF_STOCK",
  "INSUFFICIENT_STOCK",
  "AVAILABILITY_UNKNOWN",
  "MINIMUM_QUANTITY",
  "PACKAGE_QUANTITY",
  "PRICE_UNAVAILABLE",
  "PRICE_CHANGED",
  "SHIPPING_PRICE_CHANGED",
  "MARKET_UNAVAILABLE",
  "SOMETHING_NEW",
];
const czechOwnerMessage =
  "Šrouby: cena se změnila z 1,00 Kč na 2,00 Kč. Potvrďte prosím novou cenu.";

describe("owner issues are worded from their code, never from the owner's Czech message", () => {
  it.each([
    ["sk", sk],
    ["en", en],
  ])("words every owner code in %s without Czech", (_locale, t) => {
    const texts = codes.map((code) =>
      ownerIssueText(
        {
          code,
          message: czechOwnerMessage,
          availableQuantity: 7,
          expectedUnitPriceMinor: 100,
          currentUnitPriceMinor: 250,
        },
        line,
        t,
        eur,
      ),
    );
    expect(
      texts.filter((text) => !text || text === czechOwnerMessage || czechOnly.test(text)),
    ).toEqual([]);
  });

  it("keeps the numbers the owner and the catalog provide", () => {
    expect(
      ownerIssueText(
        { code: "PRICE_CHANGED", expectedUnitPriceMinor: 100, currentUnitPriceMinor: 250 },
        line,
        en,
        eur,
      ),
    ).toBe("Bolts (M8): the price changed from €1.00 to €2.50. Please confirm the new price.");
    expect(
      ownerIssueText({ code: "INSUFFICIENT_STOCK", availableQuantity: 7 }, line, en, eur),
    ).toBe("Bolts (M8): only 7 pcs available.");
    expect(ownerIssueText({ code: "PACKAGE_QUANTITY" }, line, sk, eur)).toBe(
      sk.server.cart.packageQuantity("Bolts (M8)", 50, "pcs"),
    );
    expect(
      ownerIssueText(
        { code: "SHIPPING_PRICE_CHANGED", currentUnitPriceMinor: 499 },
        undefined,
        en,
        eur,
      ),
    ).toBe("The shipping price changed to €4.99.");
    expect(ownerIssueText({ code: "MARKET_UNAVAILABLE" }, undefined, cs, eur)).toBe(
      "V tomto trhu nyní nelze objednávat.",
    );
  });

  it("falls back to a generic sentence when a number is missing", () => {
    expect(ownerIssueText({ code: "MINIMUM_QUANTITY" }, { label: "X" }, en, eur)).toBe(
      en.server.cart.quantityRejected("X"),
    );
    expect(ownerIssueText({ code: "PRICE_CHANGED" }, undefined, en, eur)).toBe(
      en.server.cart.priceChangedPlain(en.server.cart.fallbackItem),
    );
  });
});

const product = {
  id: "p",
  slug: "vruty",
  name: "Vruty",
  active: true,
  vatRate: 21,
  availability: "IN_STOCK",
  variantSummary: { count: 1, minGrossPriceMinor: 121, stockOnHand: 1000, units: ["ks"] },
  variantRecords: [
    {
      id: "v",
      sku: "V-1",
      name: "3,5 × 16",
      active: true,
      priceMinor: 100,
      grossPriceMinor: 121,
      stockOnHand: 1000,
      availability: "IN_STOCK",
      minimumQuantity: 1,
    },
  ],
};
const cartLine = {
  productId: "p",
  variantId: "v",
  slug: "vruty",
  name: "Vruty",
  variantLabel: "3,5 × 16",
  sku: "V-1",
  imageSrc: "",
  imageAlt: "",
  unit: "ks",
  minimumQuantity: 1,
  stockCount: 1000,
  priceMinor: 121,
  quantity: 10,
};
const rejected = {
  storefrontOrder: {
    outcome: "REJECTED",
    issues: [
      {
        code: "INSUFFICIENT_STOCK",
        productId: "p",
        variantId: "v",
        availableQuantity: 4,
        message: "Vruty (3,5 × 16): k dispozici je jen 4 ks.",
      },
      {
        code: "PRICE_CHANGED",
        productId: "p",
        variantId: "v",
        expectedUnitPriceMinor: 121,
        currentUnitPriceMinor: 130,
        message:
          "Vruty (3,5 × 16): cena se změnila z 1,21 Kč na 1,30 Kč. Potvrďte prosím novou cenu.",
      },
    ],
  },
};

describe("cart quote and order speak the market language for owner rejections", () => {
  beforeEach(() => {
    vi.mocked(callAction).mockReset();
    vi.mocked(readCartProducts).mockResolvedValue(project({ revision: 3, products: [product] }));
  });

  it("rewords the owner's dry-run issues in English", async () => {
    vi.mocked(callAction).mockResolvedValue(rejected);
    vi.mocked(getActiveMarket).mockResolvedValueOnce({
      ...testMarket,
      marketCode: "AKROS-EU",
      locale: "en",
      formatLocale: "en-GB",
      currency: "EUR",
    });
    const quote = await quoteCart({ version: 3, lines: [cartLine] }, undefined, en);
    expect(quote.canCheckout).toBe(false);
    expect(quote.priceChanged).toBe(true);
    expect(quote.issues).toEqual([
      "Vruty (3,5 × 16): only 4 ks available.",
      "Vruty (3,5 × 16): the price changed from €1.21 to €1.30. Please confirm the new price.",
    ]);
    expect(quote.lineIssues.map((issue) => issue.code)).toEqual([
      "INSUFFICIENT_STOCK",
      "OWNER_REJECTED",
    ]);
  });

  it("keeps the Czech wording for the Czech market", async () => {
    vi.mocked(callAction).mockResolvedValue(rejected);
    const quote = await quoteCart({ version: 3, lines: [cartLine] });
    expect(quote.issues[0]).toBe("Vruty (3,5 × 16): k dispozici je jen 4 ks.");
  });

  it("rewords a rejected order in Slovak (409)", async () => {
    vi.mocked(readAccount).mockResolvedValue(null);
    vi.mocked(readProducts).mockResolvedValue(project({ revision: 7, products: [] }));
    vi.mocked(readRecords).mockResolvedValue({
      market: {
        marketId: testMarket.marketId,
        marketCode: "AKROS-CZ",
        currency: "CZK",
        configured: true,
      },
      checkout: {
        shippingMethods: [{ id: "PPL", title: "PPL", priceMinor: 12900 }],
        paymentAvailable: false,
        carrierTrackingAvailable: false,
      },
    });
    vi.mocked(callAction).mockResolvedValue(rejected);
    const response = await orderRoute(
      new Request("http://localhost:3070/api/ontos/orders", {
        method: "POST",
        headers: {
          origin: "http://localhost:3070",
          "content-type": "application/json",
          "x-akros-market-locale": "sk",
        },
        body: JSON.stringify({
          clientRequestId: "sf-12345678-1234-4234-8234-123456789abc",
          cart: { version: 3, lines: [cartLine] },
          draft: {
            ...createCheckoutDraft(),
            deliveryId: "PPL",
            email: "guest@example.test",
            billing: {
              firstName: "Guest",
              lastName: "Test",
              street: "Test 1",
              city: "Brno",
              postalCode: "60200",
              country: "CZ",
              phone: "+420777123456",
            },
          },
        }),
      }),
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      message: string;
      issues: { code: string; message: string }[];
    };
    expect(body.issues.map((issue) => issue.code)).toEqual(["INSUFFICIENT_STOCK", "PRICE_CHANGED"]);
    expect(body.issues[0]!.message).toBe(
      sk.server.cart.insufficientStock("Vruty (3,5 × 16)", 4, "ks"),
    );
    expect(body.message).not.toMatch(czechOnly);
  });
});
