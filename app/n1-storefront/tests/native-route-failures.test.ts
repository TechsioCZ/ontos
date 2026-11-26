import { Deferred, Effect, Layer, Predicate, Schema, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { describe, expect, it } from "effect-rstest";
import { ERROR_BYTES } from "@ontos/storefront-runtime";
import { POST as checkout } from "../src/app/api/checkout/route";
import { POST as inquiry } from "../src/app/api/inquiries/route";
import { GET as image } from "../src/app/obrazky/[product]/[asset]/route";
import { ownerServer } from "./support/owner-server";

const tenantId = "71000000-0000-4000-8000-000000000098";
const legalEntityId = "71000000-0000-4000-8000-000000000099";
const marketId = "71000000-0000-4000-8000-000000000097";
const environment = {
  ONTOS_N1_STOREFRONT_API_KEY: "native-failure-test",
  ONTOS_STOREFRONT_LEGAL_ENTITY_ID: legalEntityId,
  ONTOS_STOREFRONT_TENANT_ID: tenantId,
};
const context = {
  apiBaseUrl: "/shell-super-app-api/gateway",
  compositionRevision: "a".repeat(64),
  expiresAt: 9_999_999_999,
  token: "native-failure-assertion",
};
const headers = { "x-ontos-gateway-context": JSON.stringify(context) };
const period = { startsAt: "1970-01-01T00:00:00Z" };
const market = {
  associations: [
    {
      channel: "B2C",
      effectivePeriod: period,
      marketRef: { resourceId: marketId },
      sellingLegalEntityRef: { resourceId: legalEntityId },
      storefrontRef: { appId: "n1-storefront", tenantId },
    },
  ],
  markets: [
    {
      effectivePeriod: period,
      jurisdictions: [{ code: "CZ", kind: "COUNTRY" }],
      lifecycle: "ACTIVE",
      marketCode: "N1",
      marketRef: { resourceId: marketId },
      sellingLegalEntityRef: { resourceId: legalEntityId },
      supportedLocales: ["cs-CZ"],
    },
  ],
};
const Read = Schema.Struct({
  audience: Schema.String,
  query: Schema.Struct({
    view: Schema.optionalKey(
      Schema.Struct({ orderClientRequestId: Schema.optionalKey(Schema.String) }),
    ),
  }),
});
const backend = (phase: "read" | "mint" | "action", malformed = false) => {
  let reads = 0;
  let actions = 0;
  let mints = 0;
  const failure = () =>
    HttpServerResponse.text(malformed ? "not JSON" : "x".repeat(ERROR_BYTES + 1), { status: 503 });
  const read = HttpRouter.add(
    "POST",
    "/shell-super-app-api/auth/api-key/gateway-read",
    Effect.gen(function* ownerRead() {
      reads += 1;
      if (phase === "read") {
        return failure();
      }
      const request = yield* HttpServerRequest.HttpServerRequest;
      const input = yield* Schema.decodeUnknownEffect(Read)(yield* request.json);
      if (input.audience === "commerce-market-catalog") {
        return HttpServerResponse.jsonUnsafe(market, { headers });
      }
      if (input.query.view?.orderClientRequestId !== undefined) {
        return HttpServerResponse.jsonUnsafe({ orders: [] }, { headers });
      }
      return HttpServerResponse.jsonUnsafe(
        {
          checkout: {
            carrierTrackingAvailable: false,
            paymentAvailable: false,
            shippingMethods: [{ id: "PPL", priceMinor: 12_900, title: "PPL" }],
          },
          market: { configured: true, currency: "CZK", marketId },
          revision: 7,
        },
        { headers },
      );
    }).pipe(Effect.orDie),
  );
  const mint = HttpRouter.add(
    "POST",
    "/shell-super-app-api/auth/api-key/gateway-context",
    Effect.sync(() => {
      mints += 1;
      return phase === "mint" ? failure() : HttpServerResponse.jsonUnsafe(context);
    }),
  );
  const action = Effect.sync(() => {
    actions += 1;
    return failure();
  });
  return {
    actions: () => actions,
    layer: ownerServer(
      Layer.mergeAll(
        read,
        mint,
        HttpRouter.add(
          "POST",
          "/shell-super-app-api/gateway/merchandise/actions/place-storefront-order",
          action,
        ),
        HttpRouter.add(
          "POST",
          "/shell-super-app-api/gateway/work-tasks/actions/submit-storefront-inquiry",
          action,
        ),
      ),
      environment,
    ),
    mints: () => mints,
    reads: () => reads,
  };
};
const checkoutInput = (mode: "place" | "quote") => ({
  address: { city: "Praha", country: "CZ", postalCode: "11000", street: "Testovací 1" },
  clientRequestId: "71000000-0000-4000-8000-000000000096",
  contact: { email: "buyer@example.test", firstName: "Jan", lastName: "Novák" },
  expectedShippingPriceMinor: 12_900,
  lines: [{ expectedUnitPriceMinor: 1210, productId: "product-1", quantity: 2 }],
  locale: "cs",
  mode,
  scope: { currency: "CZK", legalEntityId, marketId, tenantId },
  shippingMethod: "PPL",
});
const request = (path: string, body: Schema.Json) =>
  new Request(`https://n1.example${path}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      host: "n1.example",
      origin: "https://n1.example",
    },
    method: "POST",
  });

describe("real native route failures retain dispatch evidence", () => {
  for (const phase of ["read", "mint", "action"] as const) {
    for (const mode of ["place", "quote"] as const) {
      it.live(
        `${mode}: oversized ${phase} is uncertain only after a placing Action may dispatch`,
        () => {
          const owner = backend(phase);
          return Effect.gen(function* checkoutFailure() {
            const response = yield* Effect.promise(() =>
              checkout(request("/api/checkout", checkoutInput(mode))),
            );
            const uncertain = phase === "action" && mode === "place";
            expect(response.status).toBe(503);
            expect(response.headers.get("cache-control")).toBe("no-store");
            const problem = yield* Effect.promise(() => response.json());
            expect(
              Predicate.isTagged(
                problem,
                uncertain ? "CheckoutUncertainProblem" : "CheckoutUnavailableProblem",
              ),
            ).toBe(true);
            expect(problem).toMatchObject({
              state: uncertain ? "uncertain" : "unavailable",
            });
            expect(owner.actions()).toBe(phase === "action" ? 1 : 0);
          }).pipe(Effect.provide(owner.layer));
        },
      );
    }
  }
  for (const phase of ["mint", "action"] as const) {
    it.live(`inquiry: oversized ${phase} preserves actual dispatch uncertainty`, () => {
      const owner = backend(phase);
      return Effect.gen(function* inquiryFailure() {
        const response = yield* Effect.promise(() =>
          inquiry(
            request("/api/inquiries", {
              email: "buyer@example.test",
              locale: "cs",
              message: "Please contact me",
              name: "Buyer",
              phone: "",
              requestId: "71000000-0000-4000-8000-000000000096",
            }),
          ),
        );
        expect(response.status).toBe(503);
        const problem = yield* Effect.promise(() => response.json());
        expect(
          Predicate.isTagged(
            problem,
            phase === "action" ? "InquiryUnconfirmed" : "InquiryUnavailable",
          ),
        ).toBe(true);
        expect(owner.mints()).toBe(1);
        expect(owner.actions()).toBe(phase === "action" ? 1 : 0);
      }).pipe(Effect.provide(owner.layer));
    });
  }
  for (const mode of ["place", "quote"] as const) {
    it.live(
      `${mode}: malformed Action reply retains the same dispatch semantics without replay`,
      () => {
        const owner = backend("action", true);
        return Effect.gen(function* malformedActionReply() {
          const response = yield* Effect.promise(() =>
            checkout(request("/api/checkout", checkoutInput(mode))),
          );
          expect(yield* Effect.promise(() => response.json())).toMatchObject({
            state: mode === "place" ? "uncertain" : "unavailable",
          });
          expect(owner.actions()).toBe(1);
        }).pipe(Effect.provide(owner.layer));
      },
    );
  }
});

describe("actual product image route retains owner status through bounded decoding", () => {
  for (const status of [403, 404]) {
    for (const body of ["oversized", "truncated"] as const) {
      it.live(`owner ${status} with ${body} body is terminal before consuming bytes`, () =>
        Effect.gen(function* terminalImageHeaders() {
          let dispatches = 0;
          const closed = yield* Deferred.make<boolean>();
          const chunks =
            body === "oversized"
              ? Stream.concat(Stream.make(new Uint8Array(ERROR_BYTES + 1)), Stream.never)
              : Stream.concat(
                  Stream.make(new TextEncoder().encode("not-json")),
                  Stream.fromEffect(
                    Effect.sleep("20 millis").pipe(Effect.andThen(Effect.fail("owner body ended"))),
                  ),
                );
          const owner = HttpRouter.add(
            "POST",
            "/shell-super-app-api/auth/api-key/gateway-read",
            Effect.sync(() => {
              dispatches += 1;
              return HttpServerResponse.stream(
                chunks.pipe(Stream.ensuring(Deferred.succeed(closed, true))),
                {
                  contentType: "text/plain",
                  status,
                },
              );
            }),
          );
          yield* Effect.gen(function* readMissingImage() {
            const asset = "a973f79c-0f97-476f-a003-f6db822156fb";
            const product = "product-20532";
            const response = yield* Effect.promise(() =>
              image(new Request(`https://n1.example/obrazky/${product}/${asset}`), {
                params: Promise.resolve({ asset, product }),
              }),
            );
            expect(response.status).toBe(404);
            expect(response.headers.get("retry-after")).toBe(null);
            expect(dispatches).toBe(1);
            expect(yield* Deferred.await(closed).pipe(Effect.timeout("1 second"))).toBe(true);
          }).pipe(Effect.provide(ownerServer(owner, environment)));
        }),
      );
    }
  }
  for (const status of [403, 404, 503, 200]) {
    it.live(`text/plain owner ${status} retains missing-image versus outage semantics`, () => {
      let reads = 0;
      const owner = HttpRouter.add(
        "POST",
        "/shell-super-app-api/auth/api-key/gateway-read",
        Effect.sync(() => {
          reads += 1;
          return HttpServerResponse.text("Not an image response", { status });
        }),
      );
      return Effect.gen(function* imageFailure() {
        const asset = "a973f79c-0f97-476f-a003-f6db822156fb";
        const product = "product-20532";
        const response = yield* Effect.promise(() =>
          image(new Request(`https://n1.example/obrazky/${product}/${asset}`), {
            params: Promise.resolve({ asset, product }),
          }),
        );
        expect(response.status).toBe(status === 403 || status === 404 ? 404 : 503);
        expect(response.headers.get("retry-after")).toBe(
          status === 403 || status === 404 ? null : "5",
        );
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(reads).toBe(1);
      }).pipe(Effect.provide(ownerServer(owner, environment)));
    });
  }
});
