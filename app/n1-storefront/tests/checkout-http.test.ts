import { describe, expect } from "@rstest/core";
import { it } from "effect-rstest";
import { Context, Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { checkoutWeb } from "../src/ontos/checkout-http";

const origin = "https://n1.example";
const scope = {
  currency: "CZK",
  legalEntityId: "71000000-0000-4000-8000-000000000099",
  marketId: "71000000-0000-4000-8000-000000000097",
  tenantId: "71000000-0000-4000-8000-000000000098",
};
const input = {
  address: { city: "Praha", country: "CZ", postalCode: "11000", street: "Testovací 1" },
  clientRequestId: "71000000-0000-4000-8000-000000000096",
  contact: { email: "buyer@example.test", firstName: "Jan", lastName: "Novák" },
  expectedShippingPriceMinor: 12_900,
  lines: [{ expectedUnitPriceMinor: 1210, productId: "product-1", quantity: 2 }],
  locale: "cs",
  mode: "place",
  scope,
  shippingMethod: "PPL",
};
const request = (body: string, requestOrigin = origin, suffix = "") =>
  new Request(`${origin}/api/checkout${suffix}`, {
    body,
    headers: { "content-type": "application/json", host: "n1.example", origin: requestOrigin },
    method: "POST",
  });
const withNoNetwork = () => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = () => {
    calls += 1;
    return Promise.resolve(Response.json({}, { status: 503 }));
  };
  return { context: Context.make(FetchHttpClient.Fetch, fetch), count: () => calls };
};

describe("guest checkout HTTP guard", () => {
  for (const field of ["company", "street2", "region"]) {
    it.effect(`rejects the deliberately omitted address field ${field}`, () =>
      Effect.gen(function* noDroppedFields() {
        const owner = withNoNetwork();
        const response = yield* Effect.promise(() =>
          checkoutWeb.handler(
            request(
              JSON.stringify({ ...input, address: { ...input.address, [field]: "not-supported" } }),
            ),
            owner.context,
          ),
        );
        expect(response.status).toBe(400);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(owner.count()).toBe(0);
      }),
    );
  }
  for (const field of ["customerAccountId", "partyId"]) {
    it.effect(`rejects browser-owned account identity ${field}`, () =>
      Effect.gen(function* noBrowserAdmission() {
        const owner = withNoNetwork();
        const response = yield* Effect.promise(() =>
          checkoutWeb.handler(
            request(JSON.stringify({ ...input, [field]: "foreign-account" })),
            owner.context,
          ),
        );
        expect(response.status).toBe(400);
        expect(owner.count()).toBe(0);
      }),
    );
  }
  it.effect("rejects a cross-origin request before backend access", () =>
    Effect.gen(function* sameOrigin() {
      const owner = withNoNetwork();
      const response = yield* Effect.promise(() =>
        checkoutWeb.handler(
          request(JSON.stringify(input), "https://foreign.example"),
          owner.context,
        ),
      );
      expect(response.status).toBe(403);
      expect(owner.count()).toBe(0);
    }),
  );
  it.effect("rejects URL parameters and oversized bodies without dispatch", () =>
    Effect.gen(function* bodyLimits() {
      const owner = withNoNetwork();
      const query = yield* Effect.promise(() =>
        checkoutWeb.handler(
          request(JSON.stringify(input), origin, "?clientRequestId=leak"),
          owner.context,
        ),
      );
      expect(query.status).toBe(400);
      const oversized = request(JSON.stringify(input));
      oversized.headers.set("content-length", "65537");
      const large = yield* Effect.promise(() => checkoutWeb.handler(oversized, owner.context));
      expect(large.status).toBe(400);
      expect(owner.count()).toBe(0);
    }),
  );
  it.effect("rejects duplicate product/variant lines at the public boundary", () =>
    Effect.gen(function* duplicateLines() {
      const owner = withNoNetwork();
      const response = yield* Effect.promise(() =>
        checkoutWeb.handler(
          request(JSON.stringify({ ...input, lines: [input.lines[0], input.lines[0]] })),
          owner.context,
        ),
      );
      expect(response.status).toBe(400);
      expect(owner.count()).toBe(0);
    }),
  );
  it.effect("exposes recovery as a POST body, with no PII or mutable request fields", () =>
    Effect.gen(function* recoveryBody() {
      const owner = withNoNetwork();
      const response = yield* Effect.promise(() =>
        checkoutWeb.handler(
          request(
            JSON.stringify({
              clientRequestId: input.clientRequestId,
              contact: input.contact,
              locale: "cs",
              scope,
            }),
            origin,
            "/status",
          ),
          owner.context,
        ),
      );
      expect(response.status).toBe(400);
      expect(owner.count()).toBe(0);
    }),
  );
});
