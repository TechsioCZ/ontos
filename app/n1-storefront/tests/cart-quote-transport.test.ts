import { afterEach, rs } from "@rstest/core";
import { Context, Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { describe, expect, it } from "effect-rstest";
import { cartQuoteHandler, cartQuoteWeb } from "../src/ontos/cart-quote-http";

rs.mock("server-only", () => ({}));
afterEach(() => {
  rs.unstubAllEnvs();
});
const tenantId = "71000000-0000-4000-8000-000000000098";
const legalEntityId = "71000000-0000-4000-8000-000000000099";
const marketId = "71000000-0000-4000-8000-000000000097";
const scope = { currency: "CZK", legalEntityId, marketId, tenantId };
const input = {
  lines: [{ expectedUnitPriceMinor: 1210, productId: "product-1", quantity: 2 }],
  locale: "cs",
  scope,
};
const origin = "https://n1.example";
interface BackendOptions {
  readonly actionStatus?: number;
  readonly marketConfigured?: boolean;
  readonly mintStatus?: number;
  readonly outcome?: "VALID" | "REJECTED";
  readonly responseConfigured?: boolean;
  readonly responseCurrency?: "CZK" | "EUR";
  readonly responseMarketId?: string;
}
const backend = (options: BackendOptions = {}) => {
  rs.stubEnv("ONTOS_N1_STOREFRONT_API_KEY", "cart-test-key");
  rs.stubEnv("ONTOS_STOREFRONT_TENANT_ID", tenantId);
  rs.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", legalEntityId);
  rs.stubEnv("ONTOS_SHELL_URL", "https://shell.example");
  const calls: Request[] = [];
  let reads = 0;
  const fetch: typeof globalThis.fetch = (url, init) => {
    const request = new Request(url, init);
    calls.push(request.clone());
    const path = new URL(request.url).pathname;
    if (path.endsWith("/gateway-read")) {
      reads += 1;
      const body =
        reads === 1
          ? {
              associations: [
                {
                  channel: "B2C",
                  effectivePeriod: { startsAt: "1970-01-01T00:00:00Z" },
                  marketRef: { resourceId: marketId },
                  sellingLegalEntityRef: { resourceId: legalEntityId },
                  storefrontRef: { appId: "n1-storefront", tenantId },
                },
              ],
              markets: [
                {
                  effectivePeriod: { startsAt: "1970-01-01T00:00:00Z" },
                  lifecycle: "ACTIVE",
                  marketCode: "N1-CZ",
                  marketRef: { resourceId: marketId },
                  sellingLegalEntityRef: { resourceId: legalEntityId },
                  supportedLocales: ["cs-CZ"],
                },
              ],
            }
          : {
              market: { configured: options.marketConfigured ?? true, currency: "CZK", marketId },
              revision: 7,
            };
      return Promise.resolve(
        Response.json(body, {
          headers: {
            "x-ontos-gateway-context": JSON.stringify({
              apiBaseUrl: "/shell-super-app-api/gateway/merchandise",
              compositionRevision: "a".repeat(64),
              expiresAt: 9_999_999_999,
              token: "redeemed-read-assertion",
            }),
          },
        }),
      );
    }
    if (path.endsWith("/gateway-context")) {
      if (options.mintStatus !== undefined) {
        return Promise.resolve(Response.json({}, { status: options.mintStatus }));
      }
      return Promise.resolve(
        Response.json({
          apiBaseUrl: "/shell-super-app-api/gateway/merchandise",
          compositionRevision: "a".repeat(64),
          expiresAt: 9_999_999_999,
          token: "fresh-quote-assertion",
        }),
      );
    }
    if (options.actionStatus !== undefined) {
      return Promise.resolve(Response.json({}, { status: options.actionStatus }));
    }
    return Promise.resolve(
      Response.json({
        entityIds: [],
        revision: 7,
        storefrontOrder: {
          issues:
            options.outcome === "REJECTED"
              ? [
                  {
                    code: "PRICE_CHANGED",
                    currentUnitPriceMinor: 1300,
                    message: "Changed",
                    productId: "product-1",
                  },
                ]
              : [],
          lines: [],
          market: {
            configured: options.responseConfigured ?? true,
            currency: options.responseCurrency ?? "CZK",
            marketId: options.responseMarketId ?? marketId,
          },
          outcome: options.outcome ?? "VALID",
          shippingPriceMinor: 0,
          totalMinor: 2420,
          totalVatMinor: 420,
        },
      }),
    );
  };
  return { calls, fetch };
};
const request = (body: string, requestOrigin = origin) =>
  new Request(`${origin}/api/cart-quote`, {
    body,
    headers: { "content-type": "application/json", host: "n1.example", origin: requestOrigin },
    method: "POST",
  });

describe("governed cart quote transport", () => {
  it.effect(
    "uses fresh N1 identity, revision and assertion for an explicitly non-saving quote",
    () =>
      Effect.gen(function* realGeneratedQuoteClient() {
        const owner = backend();
        const response = yield* Effect.promise(
          async () =>
            await cartQuoteWeb.handler(
              request(JSON.stringify(input)),
              Context.make(FetchHttpClient.Fetch, owner.fetch),
            ),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const quote = yield* Effect.promise(async () => await response.json());
        expect(quote).toMatchObject({
          outcome: "VALID",
          scope,
          totalMinor: 2420,
          totalVatMinor: 420,
        });
        expect(owner.calls).toHaveLength(4);
        const action = owner.calls.at(-1);
        expect(action?.headers.get("authorization")).toBe("Bearer fresh-quote-assertion");
        expect(action?.headers.get("x-api-key")).toBeNull();
        expect(action?.headers.get("idempotency-key")).toMatch(/^n1-quote-/u);
        expect(yield* Effect.promise(async () => await action?.json())).toMatchObject({
          command: {
            _tag: "PlaceStorefrontOrder",
            dryRun: true,
            expectedShippingPriceMinor: 0,
            lines: input.lines,
            marketId,
            shippingMethod: "OSOBNI_ODBER",
          },
          expectedRevision: 7,
        });
        expect(yield* Effect.promise(async () => await owner.calls[0]?.json())).toMatchObject({
          audience: "commerce-market-catalog",
          legalEntityId,
          readName: "current-market-catalog",
        });
        expect(yield* Effect.promise(async () => await owner.calls[1]?.json())).toMatchObject({
          audience: "merchandise",
          legalEntityId,
          query: { view: { storefrontCatalog: { marketId } } },
        });
      }),
  );
  it.effect("keeps owner REJECTED distinct from channel failures", () =>
    Effect.gen(function* preservesOwnerRejection() {
      const owner = backend({ outcome: "REJECTED" });
      const response = yield* Effect.promise(
        async () =>
          await cartQuoteWeb.handler(
            request(JSON.stringify(input)),
            Context.make(FetchHttpClient.Fetch, owner.fetch),
          ),
      );
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(async () => await response.json())).toMatchObject({
        issues: [{ code: "PRICE_CHANGED", currentUnitPriceMinor: 1300 }],
        outcome: "REJECTED",
      });
    }),
  );
  it.effect("rejects a foreign tenant before any HTTP", () =>
    Effect.gen(function* protectsScope() {
      const owner = backend();
      const response = yield* Effect.promise(
        async () =>
          await cartQuoteWeb.handler(
            request(JSON.stringify({ ...input, scope: { ...scope, tenantId: legalEntityId } })),
            Context.make(FetchHttpClient.Fetch, owner.fetch),
          ),
      );
      expect(response.status).toBe(409);
      expect(owner.calls).toHaveLength(0);
    }),
  );
  it.effect("does not quote a market with no configured offer", () =>
    Effect.gen(function* missingOffer() {
      const owner = backend({ marketConfigured: false });
      const response = yield* Effect.promise(
        async () =>
          await cartQuoteWeb.handler(
            request(JSON.stringify(input)),
            Context.make(FetchHttpClient.Fetch, owner.fetch),
          ),
      );
      expect(response.status).toBe(503);
      expect(owner.calls).toHaveLength(2);
    }),
  );
  for (const responseCurrency of ["EUR"] as const) {
    it.effect("rejects an owner verdict in another currency", () =>
      Effect.gen(function* protectsVerdictCurrency() {
        const owner = backend({ responseCurrency });
        const response = yield* Effect.promise(
          async () =>
            await cartQuoteWeb.handler(
              request(JSON.stringify(input)),
              Context.make(FetchHttpClient.Fetch, owner.fetch),
            ),
        );
        expect(response.status).toBe(409);
      }),
    );
  }
  it.effect("never retries an indeterminate command response", () =>
    Effect.gen(function* noUnknownRetry() {
      const owner = backend({ actionStatus: 503 });
      const response = yield* Effect.promise(
        async () =>
          await cartQuoteWeb.handler(
            request(JSON.stringify(input)),
            Context.make(FetchHttpClient.Fetch, owner.fetch),
          ),
      );
      expect(response.status).toBe(503);
      expect(owner.calls).toHaveLength(4);
    }),
  );
  for (const quantity of [0.0001, 1_000_001]) {
    it.effect(`rejects owner-invalid quantity ${quantity} before HTTP`, () =>
      Effect.gen(function* ownerQuantityGuard() {
        const owner = backend();
        const response = yield* Effect.promise(
          async () =>
            await cartQuoteWeb.handler(
              request(JSON.stringify({ ...input, lines: [{ ...input.lines[0], quantity }] })),
              Context.make(FetchHttpClient.Fetch, owner.fetch),
            ),
        );
        expect(response.status).toBe(400);
        expect(owner.calls).toHaveLength(0);
      }),
    );
  }
  it.effect("rejects duplicate lines before any HTTP", () =>
    Effect.gen(function* duplicatePairs() {
      const owner = backend();
      const response = yield* Effect.promise(
        async () =>
          await cartQuoteWeb.handler(
            request(JSON.stringify({ ...input, lines: [input.lines[0], input.lines[0]] })),
            Context.make(FetchHttpClient.Fetch, owner.fetch),
          ),
      );
      expect(response.status).toBe(400);
      expect(owner.calls).toHaveLength(0);
    }),
  );
  it.effect("enforces origin and streamed body limits before owner calls", () =>
    Effect.gen(function* inboundGuards() {
      const owner = backend();
      const foreign = yield* Effect.promise(
        async () =>
          await cartQuoteWeb.handler(
            request("invalid-json", "https://foreign.example"),
            Context.make(FetchHttpClient.Fetch, owner.fetch),
          ),
      );
      expect(foreign.status).toBe(403);
      const oversized = yield* Effect.promise(
        async () =>
          await cartQuoteWeb.handler(
            request("x".repeat(70_000)),
            Context.make(FetchHttpClient.Fetch, owner.fetch),
          ),
      );
      expect(oversized.status).toBe(400);
      expect(owner.calls).toHaveLength(0);
    }),
  );
  it.effect("normalizes the actual Host authority at the Next edge", () =>
    Effect.gen(function* nextRequestOrigin() {
      const response = yield* Effect.promise(
        async () =>
          await cartQuoteHandler(
            new Request("http://localhost:3071/api/cart-quote", {
              body: "{}",
              headers: {
                "content-type": "application/json",
                host: "127.0.0.1:3071",
                origin: "http://127.0.0.1:3071",
              },
              method: "POST",
            }),
          ),
      );
      expect(response.status).toBe(400);
    }),
  );
});

for (const changedScope of [
  { ...scope, currency: "EUR" },
  { ...scope, marketId: legalEntityId },
]) {
  it.effect("refuses a stale market or currency before minting a quote assertion", () =>
    Effect.gen(function* staleScopeBeforeAction() {
      const owner = backend();
      const response = yield* Effect.promise(
        async () =>
          await cartQuoteWeb.handler(
            request(JSON.stringify({ ...input, scope: changedScope })),
            Context.make(FetchHttpClient.Fetch, owner.fetch),
          ),
      );
      expect(response.status).toBe(409);
      expect(owner.calls).toHaveLength(2);
    }),
  );
}
it.effect("keeps definite gateway denial separate from owner rejection", () =>
  Effect.gen(function* deniedQuoteCapability() {
    const owner = backend({ mintStatus: 403 });
    const response = yield* Effect.promise(
      async () =>
        await cartQuoteWeb.handler(
          request(JSON.stringify(input)),
          Context.make(FetchHttpClient.Fetch, owner.fetch),
        ),
    );
    expect(response.status).toBe(403);
    expect(owner.calls).toHaveLength(3);
  }),
);
it.effect("keeps a matching-market owner rejection when the offer becomes unavailable", () =>
  Effect.gen(function* offerRejectedAfterRead() {
    const owner = backend({ outcome: "REJECTED", responseConfigured: false });
    const response = yield* Effect.promise(
      async () =>
        await cartQuoteWeb.handler(
          request(JSON.stringify(input)),
          Context.make(FetchHttpClient.Fetch, owner.fetch),
        ),
    );
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(async () => await response.json())).toMatchObject({
      outcome: "REJECTED",
      totalMinor: null,
      totalVatMinor: null,
    });
  }),
);
