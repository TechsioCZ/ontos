import { describe, expect } from "@rstest/core";
import { it } from "effect-rstest";
import { Context, Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { customerOrdersWeb } from "../src/ontos/customer-orders-http";

const origin = "https://n1.example";
const noNetwork = () => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => {
    calls += 1;
    return Response.json({}, { status: 503 });
  };
  return { context: Context.make(FetchHttpClient.Fetch, fetch), count: () => calls };
};
const request = (query: string, headers: Record<string, string> = {}) =>
  new Request(`${origin}/api/customer-orders${query}`, {
    headers: { host: "n1.example", ...headers },
  });

describe("private own-orders HTTP boundary", () => {
  for (const query of [
    "?locale=cs&customerAccountId=attacker",
    "?locale=cs&partyId=attacker",
    "?locale=cs&tenantId=attacker",
    "?locale=cs&orderId=first&orderId=second",
    "?locale=cs&offset=0&offset=50",
    "?locale=cs&locale=en",
    "?locale=cs&offset=-1",
    "?locale=cs&offset=1.5",
    "?locale=cs&offset=abc",
    "?locale=cs&orderId=private-order&offset=50",
    "?locale=de",
    "",
  ]) {
    it.effect(`rejects invalid or identity-bearing query before owner admission (${query})`, () =>
      Effect.gen(function* invalidQuery() {
        const network = noNetwork();
        const response = yield* Effect.promise(
          async () => await customerOrdersWeb.handler(request(query), network.context),
        );
        expect(response.status).toBe(400);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(network.count()).toBe(0);
        const body = yield* Effect.promise(async () => await response.text());
        expect(body).not.toContain("attacker");
        expect(body).not.toContain("private-order");
        expect(body).not.toContain("issues");
      }),
    );
  }
  for (const headers of [
    { origin: "https://other.example" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
  ]) {
    it.effect("rejects a foreign request before returning customer data", () =>
      Effect.gen(function* forbiddenOrigin() {
        const network = noNetwork();
        const response = yield* Effect.promise(
          async () =>
            await customerOrdersWeb.handler(request("?locale=cs", headers), network.context),
        );
        expect(response.status).toBe(403);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("referrer-policy")).toBe("no-referrer");
        expect(network.count()).toBe(0);
      }),
    );
  }
});
