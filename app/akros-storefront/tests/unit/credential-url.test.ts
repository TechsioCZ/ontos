// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { proxy } from "@/proxy";
import { serveHttp } from "../support/http";
import { nextRequest } from "../support/next-request";

const legalEntityId = "71000000-0000-4000-8000-000000000024";
const marketRef = { resourceId: "71000000-0000-4000-8000-000000000025" };
const effectivePeriod = { startsAt: "2020-01-01T00:00:00.000Z" };
let network: Awaited<ReturnType<typeof serveHttp>>;

beforeAll(async () => {
  network = await serveHttp((request) => {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/shell-super-app-api/auth/api-key/gateway-read"
    )
      return Response.json({ error: "Unexpected request" }, { status: 404 });
    return Response.json(
      {
        markets: [
          {
            marketRef,
            marketCode: "CZ",
            supportedLocales: ["cs-CZ"],
            sellingLegalEntityRef: { resourceId: legalEntityId },
            lifecycle: "ACTIVE",
            effectivePeriod,
          },
        ],
        associations: [
          {
            marketRef,
            storefrontRef: { appId: "akros-storefront" },
            sellingLegalEntityRef: { resourceId: legalEntityId },
            channel: "B2C",
            effectivePeriod,
          },
        ],
      },
      {
        headers: {
          "x-ontos-gateway-context": JSON.stringify({
            apiBaseUrl: "/shell-super-app-api/commerce-market-catalog",
            compositionRevision: "a".repeat(64),
            token: "credential-url-market-read",
            expiresAt: Date.now() + 60_000,
          }),
        },
      },
    );
  });
  vi.stubEnv("ONTOS_SHELL_URL", network.origin);
  vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", "credential-url-test-key");
  vi.stubEnv("ONTOS_STOREFRONT_APP_ID", "akros-storefront");
  vi.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", legalEntityId);
});

afterAll(async () => {
  try {
    await network.close();
  } finally {
    vi.unstubAllEnvs();
  }
});

async function requestProxy(url: URL, init?: RequestInit) {
  const context = nextRequest(url.href, init);
  try {
    return await context.run(() => proxy(context.request));
  } finally {
    await context.close();
  }
}

describe("credential query guard", () => {
  it.each(["password", "newPassword", "Password", "api_key", "client_secret", "access_token"])(
    "strips %s before rendering an auth page",
    async (key) => {
      const url = new URL("https://store.test/sk/prihlaseni");
      url.searchParams.set(key, "query-probe");
      const response = await requestProxy(url);
      expect(response.status).toBe(303);
      // The login page of the same market.
      expect(new URL(response.headers.get("location") ?? "").href).toBe(
        "https://store.test/sk/prihlaseni",
      );
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    },
  );
  it("does not redirect a Zerops request to Next's internal listener origin", async () => {
    const url = new URL("https://0.0.0.0:3070/prihlaseni");
    url.searchParams.set("password", "proxy-origin-probe");
    const response = await requestProxy(url, {
      headers: { host: "ontos-stage-akros.web-revolution.cz", "x-forwarded-proto": "https" },
    });
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location") ?? "").href).toBe(
      // A legacy URL without a market goes to the Czech market's login.
      "https://ontos-stage-akros.web-revolution.cz/cs/prihlaseni",
    );
  });
  it("preserves legitimate verification tokens and normal navigation", async () => {
    for (const path of ["/cs/overeni-emailu?token=one-use", "/cs/prihlaseni?returnTo=%2Fkosik"]) {
      const response = await requestProxy(new URL(path, "https://store.test"));
      expect(response.status).toBe(200);
      expect(response.headers.get("x-middleware-rewrite")).toBe(
        new URL(path.slice(3), "https://store.test").href,
      );
    }
    await network.idle();
    expect(network.requests).toHaveLength(1);
    const [read] = network.requests;
    expect(read.headers.get("x-api-key")).toBe("credential-url-test-key");
    expect(await read.json()).toEqual({
      audience: "commerce-market-catalog",
      legalEntityId,
      readName: "current-market-catalog",
      query: { at: expect.any(String) },
    });
  });
});
