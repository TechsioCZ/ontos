import { afterEach, describe, expect, rs } from "@rstest/core";
import { it } from "effect-rstest";
import { Deferred, Effect, Fiber } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { submitCheckoutProgram } from "../src/features/use-checkout";
import {
  cartLineSnapshot,
  checkoutGuardKey,
  readCheckoutGuard,
  removeCheckoutGuard,
  saveCheckoutGuard,
} from "../src/features/checkout-guard" with { rstest: "importActual" };
import type { CartScope } from "../src/ontos/cart-quote";

// Exercise the actual submission and durable guard logic. Only the browser Web Lock edge is replaced.
rs.mock("../src/features/checkout-guard", () => ({
  cartLineSnapshot,
  checkoutGuardKey,
  readCheckoutGuard,
  removeCheckoutGuard,
  saveCheckoutGuard,
  withCheckoutLock: <A, E, R>(_scope: CartScope, program: Effect.Effect<A, E, R>) => program,
}));
rs.mock("../src/features/auth-view", () => ({ usePortalAuth: rs.fn() }));
rs.mock("../src/features/cart-provider", () => ({ useCart: rs.fn() }));

const scope = {
  currency: "CZK" as const,
  legalEntityId: "71000000-0000-4000-8000-000000000099",
  marketId: "71000000-0000-4000-8000-000000000097",
  tenantId: "71000000-0000-4000-8000-000000000098",
};
const fields = () => {
  const value = new FormData();
  for (const [name, field] of Object.entries({
    city: "Praha",
    country: "CZ",
    email: "buyer@example.test",
    firstName: "Jan",
    lastName: "Novák",
    phone: "",
    postalCode: "11000",
    street: "Testovací 1",
  })) {
    value.set(name, field);
  }
  return value;
};
const rejected = {
  issues: [],
  lines: [],
  orderId: null,
  orderNumber: null,
  outcome: "REJECTED",
  receipt: null,
  scope,
  shippingPriceMinor: null,
  status: null,
  totalMinor: null,
  totalVatMinor: null,
};
afterEach(() => {
  rs.unstubAllGlobals();
});

describe("session changes while a placement is pending", () => {
  for (const responseStatus of [200, 403]) {
    for (const sessionChanged of [true, false]) {
      it.effect(
        `keeps the nonce after ${responseStatus} iff session changed=${sessionChanged}`,
        () =>
          Effect.gen(function* deferredSessionResponse() {
            const storage = new Map<string, string>();
            rs.stubGlobal("window", {
              localStorage: {
                getItem: (key: string) => storage.get(key) ?? null,
                removeItem: (key: string) => storage.delete(key),
                setItem: (key: string, value: string) => storage.set(key, value),
              },
            });
            const dispatched = yield* Deferred.make<null>();
            const respond = yield* Deferred.make<null>();
            let requests = 0;
            let current = true;
            const client = HttpClient.make((request) =>
              Effect.gen(function* deferredNativeResponse() {
                requests += 1;
                yield* Deferred.succeed(dispatched, null);
                yield* Deferred.await(respond);
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json(
                    responseStatus === 200
                      ? rejected
                      : {
                          _tag: "CheckoutForbiddenProblem",
                          detail: "Checkout could not be confirmed.",
                          state: "forbidden",
                          status: 403,
                          title: "Checkout",
                          type: "urn:n1:checkout",
                        },
                    {
                      headers: {
                        "content-type":
                          responseStatus === 200 ? "application/json" : "application/problem+json",
                      },
                      status: responseStatus,
                    },
                  ),
                );
              }),
            ).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("https://n1.example")));
            const fiber = yield* submitCheckoutProgram({
              fields: fields(),
              isCurrentSession: () => current,
              lines: [{ expectedUnitPriceMinor: 1210, productId: "product-1", quantity: 2 }],
              locale: "cs",
              method: { id: "PPL", priceMinor: 12_900, title: "PPL" },
              placing: true,
              scope,
            }).pipe(
              Effect.provideService(HttpClient.HttpClient, client),
              Effect.result,
              Effect.forkChild,
            );
            yield* Deferred.await(dispatched);
            const saved = storage.get(checkoutGuardKey(scope));
            expect(saved).toBeDefined();
            current = !sessionChanged;
            yield* Deferred.succeed(respond, null);
            yield* Fiber.join(fiber);
            expect(requests).toBe(1);
            if (sessionChanged) {
              expect(storage.get(checkoutGuardKey(scope))).toBe(saved);
            } else {
              expect(storage.has(checkoutGuardKey(scope))).toBe(false);
            }
          }),
      );
    }
  }
});
