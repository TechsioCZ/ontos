import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { quoteCart } from "@/ontos/quote";
import { ownerIssueText } from "@/ontos/owner-issues";
import { POST as orderRoute } from "@/app/api/ontos/orders/route";
import { createCheckoutDraft } from "@/features/checkout/checkout-state";
import { cs } from "@/i18n/cs";
import { sk } from "@/i18n/sk";
import { en } from "@/i18n/en";
import type { MoneyFormat } from "@/lib/format";
import { getConfig } from "@/ontos/config";
import { browserAt, serveHttp } from "../support/http";
import { nextRequest } from "../support/next-request";
import { testMarket } from "../support/market-fixture";

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
  const markets = [
    testMarket,
    {
      ...testMarket,
      marketId: "0b3d6c1e-2f4a-4c5b-8d6e-7f8091a2b3c5",
      marketCode: "AKROS-EU",
      locale: "en",
      formatLocale: "en-GB",
      currency: "EUR",
    },
    {
      ...testMarket,
      marketId: "0b3d6c1e-2f4a-4c5b-8d6e-7f8091a2b3c6",
      marketCode: "AKROS-SK",
      locale: "sk",
      formatLocale: "sk-SK",
    },
  ];
  const originalBrowserUrl = window.location.href;
  let network: Awaited<ReturnType<typeof serveHttp>>;

  beforeAll(async () => {
    network = await serveHttp(async (request) => {
      const path = new URL(request.url).pathname;
      const context = {
        apiBaseUrl: "/shell-super-app-api/owner",
        compositionRevision: "a".repeat(64),
        token: "owner-issues-test-assertion",
        expiresAt: Date.now() + 60_000,
      };
      if (path === "/shell-super-app-api/auth/api-key/gateway-context")
        return Response.json(context);
      if (path === "/shell-super-app-api/owner/api/portal-auth/customer-account")
        return Response.json({ state: "anonymous" });
      if (path === "/shell-super-app-api/owner/merchandise/actions/place-storefront-order")
        return Response.json(rejected);
      if (path !== "/shell-super-app-api/auth/api-key/gateway-read")
        throw new Error(`Unexpected owner request: ${request.method} ${path}`);

      const body: unknown = await request.json();
      if (typeof body !== "object" || body === null || !("readName" in body))
        throw new Error("Missing governed read name");
      const headers = { "x-ontos-gateway-context": JSON.stringify(context) };
      if (body.readName === "current-market-catalog") {
        const { appId, legalEntityId } = getConfig();
        const effectivePeriod = { startsAt: "2020-01-01T00:00:00.000Z" };
        return Response.json(
          {
            markets: markets.map((market) => ({
              marketRef: { resourceId: market.marketId },
              sellingLegalEntityRef: { resourceId: legalEntityId },
              marketCode: market.marketCode,
              supportedLocales: [market.formatLocale],
              lifecycle: "ACTIVE",
              effectivePeriod,
            })),
            associations: markets.map((market) => ({
              marketRef: { resourceId: market.marketId },
              storefrontRef: { appId },
              sellingLegalEntityRef: { resourceId: legalEntityId },
              channel: "B2C",
              effectivePeriod,
            })),
          },
          { headers },
        );
      }
      if (
        body.readName !== "records" ||
        !("query" in body) ||
        typeof body.query !== "object" ||
        body.query === null ||
        !("view" in body.query) ||
        typeof body.query.view !== "object" ||
        body.query.view === null ||
        !("storefrontCatalog" in body.query.view)
      )
        throw new Error("Unexpected catalog read");
      const view = body.query.view;
      const catalog = view.storefrontCatalog;
      if (typeof catalog !== "object" || catalog === null || !("marketId" in catalog))
        throw new Error("Missing owner market selector");
      const market = markets.find((entry) => entry.marketId === catalog.marketId);
      if (!market) throw new Error("Unknown owner market");
      if ("storefrontCheckout" in view && view.storefrontCheckout === true)
        return Response.json(
          {
            market,
            checkout: {
              shippingMethods: [{ id: "PPL", title: "PPL", priceMinor: 12900 }],
              paymentAvailable: false,
              carrierTrackingAvailable: false,
            },
          },
          { headers },
        );
      const full = "fields" in catalog && catalog.fields === "full";
      return Response.json(
        {
          market,
          revision: full ? 3 : 7,
          products: full ? [product] : [],
        },
        { headers },
      );
    });
    browserAt(network.origin);
    vi.stubEnv("ONTOS_SHELL_URL", network.origin);
    vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", "owner-issues-test-key");
  });

  afterAll(async () => {
    try {
      await network.close();
    } finally {
      vi.unstubAllEnvs();
      browserAt(originalBrowserUrl);
    }
  });

  it("rewords the owner's dry-run issues in English", async () => {
    const request = nextRequest(`${network.origin}/api/ontos/cart`, {
      headers: { "x-akros-market-locale": "en" },
    });
    const quote = await request
      .run(() => quoteCart({ version: 3, lines: [cartLine] }, undefined, en))
      .finally(() => request.close());
    await network.idle();
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
    const request = nextRequest(`${network.origin}/api/ontos/cart`, {
      headers: { "x-akros-market-locale": "cs" },
    });
    const quote = await request
      .run(() => quoteCart({ version: 3, lines: [cartLine] }))
      .finally(() => request.close());
    await network.idle();
    expect(quote.issues[0]).toBe("Vruty (3,5 × 16): k dispozici je jen 4 ks.");
  });

  it("rewords a rejected order in Slovak (409)", async () => {
    const request = nextRequest(`${network.origin}/api/ontos/orders`, {
      method: "POST",
      headers: {
        origin: network.origin,
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
    });
    const response = await request
      .run(() => orderRoute(request.request))
      .finally(() => request.close());
    await network.idle();
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
