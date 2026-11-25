import { TestClock } from "effect/testing";
import { afterEach, describe, expect, rs } from "@rstest/core";
import { it } from "effect-rstest";
import { Clock, Context, Effect, Fiber } from "effect";
import { FetchHttpClient } from "effect/http";
import { customerOrdersWeb } from "../src/ontos/customer-orders-http";

afterEach(() => {
  rs.unstubAllEnvs();
});

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
  it.effect(
    "preserves native admission cookie deletion when its body reaches the request deadline",
    () =>
      Effect.gen(function* outerOrdersDeadline() {
        rs.stubEnv("ONTOS_N1_STOREFRONT_API_KEY", "orders-test-key");
        rs.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", "71000000-0000-4000-8000-000000000099");
        rs.stubEnv("ONTOS_STOREFRONT_TENANT_ID", "71000000-0000-4000-8000-000000000098");
        rs.stubEnv("ONTOS_SHELL_URL", "https://shell.example");
        const caller = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          (controller) => Effect.sync(() => controller.abort()),
        );
        const started = Promise.withResolvers<null>();
        const release = Promise.withResolvers<null>();
        const calls: Request[] = [];
        let cancelled = false;
        const fetch: typeof globalThis.fetch = async (input, init) => {
          const outgoing = new Request(input, init);
          calls.push(outgoing);
          if (outgoing.url.endsWith("/gateway-context")) {
            return Response.json({
              apiBaseUrl: "/shell-super-app-api/gateway/portal",
              compositionRevision: "a".repeat(64),
              expiresAt: 9_999_999_999,
              token: "orders-test-assertion",
            });
          }
          expect(new URL(outgoing.url).pathname).toBe(
            "/shell-super-app-api/gateway/portal/api/portal-auth/customer-account",
          );
          expect(outgoing.headers.get("cookie")).toBe("commerce-portal.session=customer-session");
          return new Response(
            new ReadableStream<Uint8Array>(
              {
                cancel() {
                  cancelled = true;
                  release.resolve(null);
                },
                async pull() {
                  started.resolve(null);
                  await release.promise;
                },
              },
              { highWaterMark: 0 },
            ),
            {
              headers: [
                ["content-type", "application/json"],
                ["set-cookie", "commerce-portal.session=; Path=/; Max-Age=0; HttpOnly"],
                ["set-cookie", "staff.session=forbidden; Path=/; HttpOnly"],
              ],
            },
          );
        };
        const clock = yield* Clock.Clock;
        const context = Context.make(Clock.Clock, clock).pipe(
          Context.add(FetchHttpClient.Fetch, fetch),
        );
        const incoming = new Request(
          request("?locale=cs", {
            cookie: "staff.session=private; commerce-portal.session=customer-session",
          }),
          { signal: caller.signal },
        );
        const pending = yield* Effect.forkChild(
          Effect.promise(() => customerOrdersWeb.handler(incoming, context)),
        );
        yield* Effect.promise(() => started.promise);
        yield* TestClock.adjust("30 seconds");
        const response = yield* Fiber.join(pending);
        expect(response.status).toBe(503);
        expect(response.headers.get("set-cookie")).toContain("commerce-portal.session=");
        expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
        expect(response.headers.get("set-cookie")).not.toContain("staff.session");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          state: "unavailable",
        });
        expect(calls).toHaveLength(2);
        expect(calls[1]?.signal.aborted).toBe(true);
        expect(cancelled).toBe(true);
      }).pipe(Effect.scoped),
  );
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
