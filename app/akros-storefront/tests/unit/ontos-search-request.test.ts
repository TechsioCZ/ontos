import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/ontos/search/route";
import { browserAt, serveHttp } from "../support/http";
import { nextRequest } from "../support/next-request";

const searchPath = "/api/ontos/search";
const gatewayPath = "/shell-super-app-api/auth/api-key/gateway-read";
const gatewayRead = Schema.Struct({ audience: Schema.String, query: Schema.Unknown });
const catalogQuery = Schema.Struct({
  view: Schema.Struct({
    storefront: Schema.Boolean,
    storefrontCatalog: Schema.Record(Schema.String, Schema.Unknown),
  }),
});
let network: Awaited<ReturnType<typeof serveHttp>>;

const ask = (body: unknown, locale = "cs") =>
  fetch(`${network.origin}${searchPath}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-akros-market-locale": locale },
    body: JSON.stringify(body),
  });

const ownerRequests = () =>
  network.requests.filter((request) => new URL(request.url).pathname === gatewayPath);

async function productQueries() {
  const reads = await Promise.all(
    ownerRequests().map(async (request) =>
      Schema.decodeUnknownSync(gatewayRead)(await request.json()),
    ),
  );
  return reads
    .filter((read) => read.audience === "merchandise")
    .map((read) => Schema.decodeUnknownSync(catalogQuery)(read.query).view.storefrontCatalog)
    .filter((query) => query.mode !== "categories");
}

beforeEach(async () => {
  network = await serveHttp(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === searchPath) {
      const context = nextRequest(request.url, {
        method: request.method,
        headers: request.headers,
      });
      try {
        return await context.run(() => POST(request));
      } finally {
        await context.close();
      }
    }
    if (path === gatewayPath) {
      const read = Schema.decodeUnknownSync(gatewayRead)(await request.json());
      if (read.audience !== "commerce-market-catalog" && read.audience !== "merchandise")
        return new Response("Unknown owner", { status: 404 });
      return Response.json(
        read.audience === "commerce-market-catalog"
          ? { markets: [], associations: [] }
          : { categories: [], products: [], total: 0, page: 1, pageSize: 6 },
        {
          headers: {
            "x-ontos-gateway-context": JSON.stringify({
              apiBaseUrl: `/shell-super-app-api/${read.audience}`,
              compositionRevision: "a".repeat(64),
              token: "search-request-test-assertion",
              expiresAt: Date.now() + 60_000,
            }),
          },
        },
      );
    }
    return new Response("Not found", { status: 404 });
  });
  browserAt(network.origin);
  vi.stubEnv("ONTOS_SHELL_URL", network.origin);
  vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", "search-request-test-key");
});

afterEach(async () => {
  try {
    await network.close();
  } finally {
    vi.unstubAllEnvs();
  }
});

const empty = { items: [], total: 0, categories: [] };

describe("public storefront search query ingress", () => {
  it.each(["šš", "Český šroub", "x".repeat(200)])(
    "forwards a valid query trimmed and never accent-stripped: %s",
    async (query) => {
      const response = await ask({ q: `  ${query}  ` });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual(empty);
      await network.idle();
      // One real card read, with no full-variant hydration for the empty result.
      expect(await productQueries()).toEqual([
        { q: query, page: 1, pageSize: 6, fields: "card", includeCategories: false },
      ]);
    },
  );

  it("cuts text longer than 200 characters to 200 instead of rejecting it", async () => {
    const response = await ask({ q: `  ${"x".repeat(200)}yyy  ` });
    expect(response.status).toBe(200);
    await response.json();
    await network.idle();
    expect(await productQueries()).toEqual([
      { q: "x".repeat(200), page: 1, pageSize: 6, fields: "card", includeCategories: false },
    ]);
  });

  it.each([
    {},
    { q: null },
    { q: 1 },
    { q: [] },
    { q: {} },
    { q: "" },
    { q: " \t\n " },
    { q: "š" },
    { q: " a " },
    [],
    "šroub",
    1,
  ])("answers %j with no results and no owner read, never a 400", async (body) => {
    const response = await ask(body);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(empty);
    await network.idle();
    expect(
      network.requests.filter((request) => new URL(request.url).pathname === searchPath),
    ).toHaveLength(1);
    expect(ownerRequests()).toEqual([]);
  });
});
