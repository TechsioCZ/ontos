// @vitest-environment node
import { Suspense } from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ErpHomeStrip } from "@/components/erp-home-strip";
import { MarketProvider } from "@/ontos/market-context";
import { serveHttp } from "../support/http";
import { testMarket } from "../support/market-fixture";
import { nextRequest } from "../support/next-request";

const legalEntityId = "c0c78a3e-6e2a-57e0-9d0d-86253499fee7";
beforeEach(() => {
  vi.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", legalEntityId);
  vi.stubEnv(
    "ONTOS_STOREFRONT_ERP_OFFERS",
    JSON.stringify({
      [legalEntityId]: {
        customerConfigurationId: "akros-eshop",
        channelId: "B2C",
        marketId: "akros-cz",
        currencyCode: "CZK",
        unitId: "30000000-0000-4000-8000-000000000001",
        unitQuantity: "1",
      },
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function renderBody() {
  const stream = await renderToReadableStream(
    <MarketProvider market={{ ...testMarket, live: [] }}>
      <Suspense fallback={null}>
        <ErpHomeStrip />
      </Suspense>
    </MarketProvider>,
  );
  return new Response(stream).text();
}

it("finishes the body with the local listing link without starting an ERP owner read", async () => {
  const ownerRead = Promise.withResolvers<string>();
  const releaseOwner = Promise.withResolvers<void>();
  const network = await serveHttp(async (request) => {
    const { audience, readName } = await request.json();
    const headers = {
      "x-ontos-gateway-context": JSON.stringify({
        apiBaseUrl: "/shell-super-app-api/erp",
        token: "test-assertion",
        compositionRevision: "a".repeat(64),
        expiresAt: Date.now() + 60_000,
      }),
    };
    if (audience === "commerce-market-catalog")
      return Response.json({ markets: [], associations: [] }, { headers });
    ownerRead.resolve(`${audience}/${readName}`);
    await releaseOwner.promise;
    return Response.json({ count: 0, items: [] }, { headers });
  });
  vi.stubEnv("ONTOS_SHELL_URL", network.origin);
  vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", "erp-test-key");
  const request = nextRequest(`${network.origin}/cs`, {
    headers: { "x-akros-market-locale": "cs" },
  });
  const body = request.run(renderBody);
  try {
    // A Suspense shell is not success: text() resolves only at body EOF.
    const html = await Promise.race([
      body,
      ownerRead.promise.then((read) => {
        throw new Error(`Home started ${read} before body EOF`);
      }),
    ]);
    expect(html).toContain('href="/cs/novinky-z-erp"');
    expect(html).toContain("Novinky z ERP");
    expect(html).toContain("Zobrazit vše");
    expect(network.requests).toHaveLength(0);
  } finally {
    releaseOwner.resolve();
    try {
      await body;
    } finally {
      await Promise.all([request.close(), network.close()]);
    }
  }
});

it("hides the section when the offer belongs to a different storefront", async () => {
  vi.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", "71000000-0000-4000-8000-000000000024");
  const html = await renderBody();
  expect(html).not.toContain("<section");
  expect(html).not.toContain("/novinky-z-erp");
});
