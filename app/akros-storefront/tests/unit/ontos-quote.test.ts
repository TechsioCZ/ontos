import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { quoteCart } from "@/ontos/quote";
import { POST as quoteRoute } from "@/app/api/ontos/cart/route";
import { testMarket } from "../support/market-fixture";
import { browserAt, serveHttp } from "../support/http";
import { nextRequest } from "../support/next-request";

const product = (variant: Record<string, unknown>) => ({
  id: "p",
  slug: "vruty",
  name: "Vruty",
  active: true,
  vatRate: 21,
  availability: variant.availability ?? "IN_STOCK",
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
      priceTiers: [
        { minimumQuantity: 1, priceMinor: 121, priceExcludingVatMinor: 100 },
        { minimumQuantity: 100, priceMinor: 115, priceExcludingVatMinor: 95 },
        { minimumQuantity: 500, priceMinor: 109, priceExcludingVatMinor: 90 },
      ],
      ...variant,
    },
  ],
});
const cart = (quantity: number, priceMinor: number) => ({
  version: 3 as const,
  lines: [
    {
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
      priceMinor,
      quantity,
    },
  ],
});

const initialBrowserUrl = window.location.href;
const locales = ["cs", "sk", "en", "de"];
const seller = { resourceId: "71000000-0000-4000-8000-000000000024" };
const period = { startsAt: "2020-01-01T00:00:00.000Z" };
const markets = locales.map((locale, index) => ({
  marketRef: {
    resourceId: index === 0 ? testMarket.marketId : `0b3d6c1e-2f4a-4c5b-8d6e-7f8091a2b3c${index}`,
  },
  marketCode: `AKROS-${locale.toUpperCase()}`,
  supportedLocales: [locale],
  lifecycle: "ACTIVE",
  effectivePeriod: period,
  sellingLegalEntityRef: seller,
}));
let catalog: { revision: number; products: ReturnType<typeof product>[] };
let ownerAnswer: Record<string, unknown>;
let network: Awaited<ReturnType<typeof serveHttp>>;
const actionPath = "/shell-super-app-api/quote/merchandise/actions/place-storefront-order";
const actionRequests = () =>
  network.requests.filter((request) => new URL(request.url).pathname === actionPath);
const contextBody = {
  apiBaseUrl: "/shell-super-app-api/quote",
  compositionRevision: "a".repeat(64),
  token: "quote-owner-assertion",
  expiresAt: 4102444800000,
};

beforeAll(async () => {
  network = await serveHttp(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/ontos/cart") {
      const context = nextRequest(request.url, { headers: request.headers });
      try {
        return await context.run(() => quoteRoute(request));
      } finally {
        await context.close();
      }
    }
    if (request.method !== "POST") throw new Error(`Unexpected method: ${request.method}`);
    if (path === "/shell-super-app-api/auth/api-key/gateway-context") {
      expect(await request.json()).toMatchObject({ audience: "merchandise" });
      return Response.json(contextBody);
    }
    if (path === actionPath) {
      expect(request.headers.get("authorization")).toBe(`Bearer ${contextBody.token}`);
      expect(request.headers.get("idempotency-key")).toMatch(/^sf-quote-/);
      return Response.json(ownerAnswer);
    }
    if (path !== "/shell-super-app-api/auth/api-key/gateway-read") {
      throw new Error(`Unexpected path: ${path}`);
    }
    expect(request.headers.get("x-api-key")).toBe("quote-http-test-key");
    const body = await request.json();
    const headers = { "x-ontos-gateway-context": JSON.stringify(contextBody) };
    if (body.audience === "commerce-market-catalog" && body.readName === "current-market-catalog") {
      return Response.json(
        {
          markets,
          associations: markets.map((market) => ({
            marketRef: market.marketRef,
            storefrontRef: { appId: "akros-storefront", tenantId: "quote-tenant" },
            sellingLegalEntityRef: seller,
            channel: "B2C",
            effectivePeriod: period,
          })),
        },
        { headers },
      );
    }
    expect(body).toMatchObject({ audience: "merchandise", readName: "records" });
    const query = body.query.view.storefrontCatalog;
    if (query.fields === "full") {
      expect(query).toMatchObject({ productIds: ["p"], variantIds: ["v"], pageSize: 1 });
    }
    return Response.json(
      {
        ...catalog,
        market: { marketId: query.marketId, currency: "CZK", configured: true },
      },
      { headers },
    );
  });
  browserAt(network.origin);
  vi.stubEnv("ONTOS_SHELL_URL", network.origin);
  vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", "quote-http-test-key");
  vi.stubEnv("ONTOS_STOREFRONT_APP_ID", "akros-storefront");
  vi.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", seller.resourceId);
});

afterAll(async () => {
  await network.close();
  browserAt(initialBrowserUrl);
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  await network.idle();
  network.requests.length = 0;
  catalog = { revision: 3, products: [product({})] };
  ownerAnswer = {
    storefrontOrder: { outcome: "VALID", issues: [], totalMinor: 54500, totalVatMinor: 9459 },
  };
});

async function quoteInRequest(...args: Parameters<typeof quoteCart>) {
  const context = nextRequest(`${network.origin}/api/ontos/cart`, {
    headers: { "x-akros-market-locale": "cs" },
  });
  try {
    return await context.run(() => quoteCart(...args));
  } finally {
    await context.close();
    await network.idle();
  }
}

describe("server cart quote", () => {
  it("quotes an unpackaged variant without inheriting its parent's package constraint", async () => {
    catalog = {
      revision: 3,
      products: [
        {
          ...product({ minimumQuantity: 1, stockOnHand: 5 }),
          minimumQuantity: 10,
          packageQuantity: 10,
        },
      ],
    };
    const quote = await quoteInRequest(cart(5, 121));
    expect(quote.canCheckout).toBe(true);
    expect(quote.lineIssues).toEqual([]);
    expect(quote.cart.lines[0]).toMatchObject({
      minimumQuantity: 1,
      quantityStep: 1,
      quantity: 5,
    });
    expect(actionRequests()).toHaveLength(1);
  });
  it("quotes a quantity above an unpackaged minimum without rounding it to a multiple", async () => {
    catalog = { revision: 3, products: [product({ minimumQuantity: 10, stockOnHand: 15 })] };
    const quote = await quoteInRequest(cart(15, 121));
    expect(quote.canCheckout).toBe(true);
    expect(quote.lineIssues).toEqual([]);
    expect(quote.cart.lines[0]).toMatchObject({
      minimumQuantity: 10,
      quantityStep: 1,
      quantity: 15,
    });
  });
  it("blocks an item whose owner availability is UNKNOWN, naming the variant, without asking OntOS to order", async () => {
    catalog = { revision: 3, products: [product({ availability: "UNKNOWN" })] };
    const quote = await quoteInRequest(cart(10, 121));
    expect(quote.canCheckout).toBe(false);
    expect(quote.lineIssues).toEqual([
      expect.objectContaining({ code: "AVAILABILITY_UNKNOWN", productId: "p", variantId: "v" }),
    ]);
    expect(quote.issues[0]).toMatch(/^Vruty \(3,5 × 16\): dostupnost nyní nelze ověřit/);
    expect(actionRequests()).toEqual([]);
  });

  it("blocks an unpriced item", async () => {
    catalog = { revision: 3, products: [product({ grossPriceMinor: 0, priceMinor: 0 })] };
    const quote = await quoteInRequest(cart(10, 0));
    expect(quote.canCheckout).toBe(false);
    expect(quote.lineIssues[0]?.code).toBe("PRICE_UNAVAILABLE");
    expect(quote.issues[0]).toMatch(/cena není dostupná/);
  });

  it("applies the owner quantity tier and returns OntOS dry-run totals (no browser VAT)", async () => {
    catalog = { revision: 3, products: [product({})] };
    const quote = await quoteInRequest(cart(500, 109), "PPL");
    expect(quote.priceChanged).toBe(false);
    expect(quote.cart.lines[0]).toMatchObject({ priceMinor: 109, priceExcludingVatMinor: 90 });
    expect(quote.canCheckout).toBe(true);
    expect(quote.totals).toEqual({
      totalMinor: 54500,
      totalVatMinor: 9459,
      netMinor: 45041,
      shippingMinor: 0,
    });
    const [actionRequest] = actionRequests();
    expect(actionRequest).toBeDefined();
    if (!actionRequest) throw new Error("No owner action arrived");
    // The narrow storefront-order HTTP path, never apply-command.
    expect(new URL(actionRequest.url).pathname).toBe(actionPath);
    const payload = await actionRequest.json();
    expect(payload).toMatchObject({
      expectedRevision: 3,
      command: { _tag: "PlaceStorefrontOrder", dryRun: true, shippingMethod: "PPL" },
    });
  });

  it("keeps the cart blocked when OntOS itself rejects a line", async () => {
    catalog = { revision: 3, products: [product({})] };
    ownerAnswer = {
      storefrontOrder: {
        outcome: "REJECTED",
        issues: [
          {
            code: "AVAILABILITY_UNKNOWN",
            productId: "p",
            variantId: "v",
            message:
              "Vruty (3,5 × 16): dostupnost nyní nelze ověřit, objednávku proto nelze dokončit.",
          },
        ],
      },
    };
    const quote = await quoteInRequest(cart(10, 121));
    expect(quote.canCheckout).toBe(false);
    expect(quote.totals).toBeNull();
    expect(quote.lineIssues[0]?.code).toBe("AVAILABILITY_UNKNOWN");
  });
  it("asks the owner for the request's market and keeps a not-offered line blocked", async () => {
    catalog = { revision: 3, products: [product({})] };
    ownerAnswer = {
      storefrontOrder: {
        outcome: "REJECTED",
        issues: [
          {
            code: "NOT_OFFERED_IN_MARKET",
            productId: "p",
            variantId: "v",
            message: "Vruty (3,5 × 16) není v nabídce tohoto trhu.",
          },
        ],
      },
    };
    const quote = await quoteInRequest(cart(10, 121));
    const [actionRequest] = actionRequests();
    expect(actionRequest).toBeDefined();
    if (!actionRequest) throw new Error("No owner action arrived");
    expect(await actionRequest.json()).toMatchObject({
      command: { dryRun: true, marketId: testMarket.marketId },
    });
    expect(quote.canCheckout).toBe(false);
    expect(quote.lineIssues[0]?.code).toBe("NOT_OFFERED_IN_MARKET");
  });
});

describe("cart quote messages follow the market language", () => {
  const ask = (body: unknown, locale?: string) =>
    fetch(`${network.origin}/api/ontos/cart`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(locale === undefined ? {} : { "x-akros-market-locale": locale }),
      },
      body: JSON.stringify(body),
    });
  it.each([
    ["cs", "Vruty (3,5 × 16): dostupnost nyní nelze ověřit, objednávku proto nelze dokončit."],
    ["sk", "Vruty (3,5 × 16): dostupnosť teraz nemožno overiť, objednávku preto nemožno dokončiť."],
    [
      "en",
      "Vruty (3,5 × 16): availability cannot be verified right now, so the order cannot be completed.",
    ],
    ["de", "Vruty (3,5 × 16): availability cannot be verified right now"],
  ])("words a blocked line for locale %s", async (locale, expected) => {
    catalog = { revision: 3, products: [product({ availability: "UNKNOWN" })] };
    const response = await ask({ cart: cart(10, 121) }, locale);
    expect(response.status).toBe(200);
    expect((await response.json()).issues[0]).toContain(expected);
  });
  it.each([
    [undefined, "Neplatný košík."],
    ["sk", "Neplatný košík."],
    ["en", "Invalid cart."],
  ])("refuses an invalid cart for locale %s with the same validation", async (locale, message) => {
    const response = await ask({ cart: { version: 3, lines: [] } }, locale);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message });
  });
  it("words a package-quantity issue in Slovak and English", async () => {
    catalog = { revision: 3, products: [product({ packageQuantity: 50 })] };
    const sk = await (await ask({ cart: cart(10, 121) }, "sk")).json();
    expect(sk.issues).toContain("Vruty (3,5 × 16): objednajte celé balenia po 50 ks.");
    const en = await (await ask({ cart: cart(10, 121) }, "en")).json();
    expect(en.issues).toContain("Vruty (3,5 × 16): order whole packages of 50 ks.");
    const cs = await (await ask({ cart: cart(10, 121) }, "cs")).json();
    expect(cs.issues).toContain("Vruty (3,5 × 16): objednejte celé balení po 50 ks.");
  });
});
