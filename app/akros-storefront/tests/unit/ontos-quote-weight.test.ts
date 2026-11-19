import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MARKET_LOCALE_HEADER } from "@/ontos/market-locale";
import { quoteCart } from "@/ontos/quote";
import { browserAt, serveHttp } from "../support/http";
import { nextRequest } from "../support/next-request";

const variant = (id: string, sku: string) => ({
  id,
  sku,
  name: id,
  active: true,
  priceMinor: 100,
  grossPriceMinor: 121,
  stockOnHand: 1000,
  availability: "IN_STOCK",
  minimumQuantity: 1,
});
const group = {
  id: "p",
  slug: "vruty",
  name: "Vruty",
  active: true,
  vatRate: 21,
  availability: "IN_STOCK",
  variantSummary: { count: 2, minGrossPriceMinor: 121, stockOnHand: 2000, units: ["ks"] },
  variantRecords: [variant("v", "100084A0040035"), variant("w", "W-1")],
};
const solo = {
  id: "s",
  slug: "solo",
  sku: "10091200240100",
  name: "Solo",
  active: true,
  vatRate: 21,
  currentPriceMinor: 100,
  grossPriceMinor: 121,
  stockOnHand: 10,
  availability: "IN_STOCK",
  variantSummary: { count: 0, units: [] },
};
const line = (productId: string, variantId: string | undefined, extra: object = {}) => ({
  productId,
  ...(variantId ? { variantId } : {}),
  slug: productId,
  name: productId,
  sku: "",
  imageSrc: "",
  imageAlt: "",
  unit: "ks",
  minimumQuantity: 1,
  stockCount: 1000,
  priceMinor: 121,
  quantity: 2,
  ...extra,
});

let network: Awaited<ReturnType<typeof serveHttp>>;
let context: ReturnType<typeof nextRequest>;
const actionPath = "/shell-super-app-api/merchandise/merchandise/actions/place-storefront-order";

beforeEach(async () => {
  network = await serveHttp(async (request) => {
    const path = new URL(request.url).pathname;
    const gatewayContext = {
      apiBaseUrl: "/shell-super-app-api/merchandise",
      compositionRevision: "a".repeat(64),
      token: "quote-weight-assertion",
      expiresAt: Date.now() + 60_000,
    };
    if (request.method === "POST" && path === "/shell-super-app-api/auth/api-key/gateway-read") {
      const body = await request.json();
      const response =
        body.audience === "commerce-market-catalog" && body.readName === "current-market-catalog"
          ? { markets: [], associations: [] }
          : body.audience === "merchandise" && body.readName === "records"
            ? { revision: 1, products: [group, solo] }
            : undefined;
      if (response !== undefined)
        return Response.json(response, {
          headers: { "x-ontos-gateway-context": JSON.stringify(gatewayContext) },
        });
    }
    if (request.method === "POST" && path === "/shell-super-app-api/auth/api-key/gateway-context")
      return Response.json(gatewayContext);
    if (request.method === "POST" && path === actionPath)
      return Response.json({
        storefrontOrder: { outcome: "VALID", issues: [], totalMinor: 726, totalVatMinor: 126 },
      });
    return Response.json({ code: "unexpected_request" }, { status: 404 });
  });
  browserAt(network.origin);
  vi.stubEnv("ONTOS_SHELL_URL", network.origin);
  vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", "quote-weight-test-key");
  context = nextRequest(`${network.origin}/api/ontos/cart`, {
    headers: { [MARKET_LOCALE_HEADER]: "cs" },
  });
});

afterEach(async () => {
  try {
    await context.close();
  } finally {
    try {
      await network.close();
    } finally {
      vi.unstubAllEnvs();
    }
  }
});

describe("server cart quote weights", () => {
  it("refreshes kg per sales unit from the projected variant or variant-less product", async () => {
    const quote = await context.run(() =>
      quoteCart({
        version: 3,
        lines: [line("p", "v"), line("p", "w", { unitWeightKg: 9 }), line("s", undefined)],
      }),
    );
    expect(quote.issues).toEqual([]);
    expect(quote.canCheckout).toBe(true);
    expect(quote.cart.lines.map((l) => l.unitWeightKg)).toEqual([0.0034, undefined, 0.494]);
    // Weight never reaches the OntOS order command.
    await network.idle();
    const actions = network.requests.filter(
      (request) => new URL(request.url).pathname === actionPath,
    );
    expect(actions).toHaveLength(1);
    expect(await actions[0]!.text()).not.toContain("unitWeightKg");
  });

  it("is stable: a refreshed cart quotes to the same cart (no revalidation loop)", async () => {
    const first = await context.run(() =>
      quoteCart({ version: 3, lines: [line("p", "v"), line("s", undefined)] }),
    );
    expect(first.issues).toEqual([]);
    expect(first.canCheckout).toBe(true);
    const second = await context.run(() => quoteCart(first.cart));
    expect(second.issues).toEqual([]);
    expect(second.canCheckout).toBe(true);
    expect(JSON.stringify(second.cart)).toBe(JSON.stringify(first.cart));
  });
});
