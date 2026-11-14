import { afterEach, describe, expect, rs } from "@rstest/core";
import { it } from "effect-rstest";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import {
  recoverConfirmedCheckoutProgram,
  submitCheckoutProgram,
} from "../src/features/use-checkout";
import { CheckoutResultSchema } from "../src/ontos/checkout";
import {
  cartLineSnapshot,
  checkoutGuardKey,
  readCheckoutGuard,
  removeCheckoutGuard,
  saveCheckoutGuard,
} from "../src/features/checkout-guard" with { rstest: "importActual" };
import type { CartScope } from "../src/ontos/cart-quote";
import type { CheckoutGuard } from "../src/features/checkout-guard";
import type { CheckoutResult } from "../src/ontos/checkout";

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

const confirmedPlacement = () =>
  Schema.decodeUnknownSync(CheckoutResultSchema)({
    issues: [],
    lines: [
      {
        lineTotalMinor: 2420,
        name: "Item",
        productId: "product-1",
        quantity: 2,
        sku: "P1",
        unitPriceMinor: 1210,
      },
    ],
    orderId: "order-1",
    orderNumber: "OBJ-2026-0001",
    outcome: "PLACED",
    receipt: null,
    scope,
    shippingPriceMinor: 0,
    status: "NEW",
    totalMinor: 2420,
    totalVatMinor: 420,
  });
const receiptGuard = {
  clientRequestId: "71000000-0000-4000-8000-000000000001",
  lines: [{ expectedUnitPriceMinor: 1210, productId: "product-1", quantity: 2 }],
  scope,
  version: 1,
} satisfies CheckoutGuard;
const savedReceipt = () => ({
  ...confirmedPlacement(),
  outcome: "REPLAYED" as const,
  receipt: {
    contact: { email: "buyer@example.test", name: "Jan Novák" },
    createdAt: "2026-11-09T12:00:00.000Z",
    deliveryAddress: { city: "Praha", country: "CZ", postalCode: "11000", street: "Testovací 1" },
    shippingMethod: "OSOBNI_ODBER" as const,
  },
});

describe("one guarded receipt read after confirmed placement", () => {
  for (const failure of [false, true]) {
    it.effect(
      failure
        ? "keeps PLACED when the owner read fails, without retrying placement or the read"
        : "enriches the same confirmed order with exactly one status read",
      () =>
        Effect.gen(function* confirmedOwnerRead() {
          const requests: string[] = [];
          const expected = confirmedPlacement();
          const accepted: CheckoutResult[] = [];
          let unavailable = 0;
          const client = HttpClient.make((request) => {
            requests.push(request.url);
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json(
                  failure
                    ? {
                        _tag: "CheckoutUnavailableProblem",
                        detail: "Receipt unavailable.",
                        state: "unavailable",
                        status: 503,
                        title: "Checkout",
                        type: "urn:n1:checkout",
                      }
                    : { result: savedReceipt(), state: "confirmed" },
                  { status: failure ? 503 : 200 },
                ),
              ),
            );
          }).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("https://n1.example")));
          yield* recoverConfirmedCheckoutProgram({
            expected,
            guard: receiptGuard,
            isCurrent: () => true,
            locale: "cs",
            onConfirmed: (result) => {
              accepted.push(result);
            },
            onUnavailable: () => {
              unavailable += 1;
            },
          }).pipe(Effect.provideService(HttpClient.HttpClient, client));
          expect(requests).toEqual(["https://n1.example/api/checkout/status"]);
          expect(accepted).toHaveLength(failure ? 0 : 1);
          expect(unavailable).toBe(failure ? 1 : 0);
          expect(expected.outcome).toBe("PLACED");
          expect(expected.receipt).toBeNull();
          if (!failure) {
            expect(accepted[0]?.orderId).toBe(expected.orderId);
            expect(accepted[0]?.receipt?.contact?.name).toBe("Jan Novák");
          }
        }),
    );
  }

  it.effect(
    "allows one explicit receipt retry after a failed automatic read without replacing PLACED",
    () =>
      Effect.gen(function* explicitConfirmedReceiptRetry() {
        const expected = confirmedPlacement();
        const requests: string[] = [];
        const accepted: CheckoutResult[] = [];
        const client = HttpClient.make((request) => {
          requests.push(request.url);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(
                requests.length === 1
                  ? {
                      _tag: "CheckoutUnavailableProblem",
                      detail: "Receipt unavailable.",
                      state: "unavailable",
                      status: 503,
                      title: "Checkout",
                      type: "urn:n1:checkout",
                    }
                  : { result: savedReceipt(), state: "confirmed" },
                { status: requests.length === 1 ? 503 : 200 },
              ),
            ),
          );
        }).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("https://n1.example")));
        const program = recoverConfirmedCheckoutProgram({
          expected,
          guard: receiptGuard,
          isCurrent: () => true,
          locale: "cs",
          onConfirmed: (result) => {
            accepted.push(result);
          },
          onUnavailable: () => {},
        }).pipe(Effect.provideService(HttpClient.HttpClient, client));
        yield* program;
        expect(requests).toEqual(["https://n1.example/api/checkout/status"]);
        expect(accepted).toHaveLength(0);
        expect(expected.outcome).toBe("PLACED");
        // An explicit second invocation represents the user's retry, not an automatic retry loop.
        yield* program;
        expect(requests).toEqual([
          "https://n1.example/api/checkout/status",
          "https://n1.example/api/checkout/status",
        ]);
        expect(accepted).toHaveLength(1);
        expect(accepted[0]?.orderId).toBe(expected.orderId);
        expect(expected.outcome).toBe("PLACED");
      }),
  );

  // The caller's fence covers unmount, session, scope and active receipt guard. Exercise both
  // response channels after that fence expires; this is an IO-program test, not client React E2E.
  for (const status of [200, 503]) {
    it.effect(`ignores a deferred ${status} owner response after the caller fence expires`, () =>
      Effect.gen(function* staleConfirmedOwnerRead() {
        const dispatched = yield* Deferred.make<null>();
        const respond = yield* Deferred.make<null>();
        let current = true;
        let requests = 0;
        const accept = rs.fn();
        const unavailable = rs.fn();
        const client = HttpClient.make((request) =>
          Effect.gen(function* deferredOwnerRead() {
            requests += 1;
            yield* Deferred.succeed(dispatched, null);
            yield* Deferred.await(respond);
            return HttpClientResponse.fromWeb(
              request,
              Response.json(
                status === 200
                  ? { result: savedReceipt(), state: "confirmed" }
                  : {
                      _tag: "CheckoutUnavailableProblem",
                      detail: "Receipt unavailable.",
                      state: "unavailable",
                      status: 503,
                      title: "Checkout",
                      type: "urn:n1:checkout",
                    },
                { status },
              ),
            );
          }),
        ).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("https://n1.example")));
        const fiber = yield* recoverConfirmedCheckoutProgram({
          expected: confirmedPlacement(),
          guard: receiptGuard,
          isCurrent: () => current,
          locale: "cs",
          onConfirmed: (result) => {
            accept(result);
          },
          onUnavailable: () => {
            unavailable();
          },
        }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.forkChild);
        yield* Deferred.await(dispatched);
        current = false;
        yield* Deferred.succeed(respond, null);
        yield* Fiber.join(fiber);
        expect(requests).toBe(1);
        expect(accept).not.toHaveBeenCalled();
        expect(unavailable).not.toHaveBeenCalled();
      }),
    );
  }

  for (const mismatch of ["orderId", "orderNumber", "scope"] as const) {
    it.effect(
      `does not start a stale read and rejects a receipt with a different ${mismatch}`,
      () =>
        Effect.gen(function* guardConfirmedOwnerRead() {
          let current = false;
          let requests = 0;
          const accept = rs.fn();
          const unavailable = rs.fn();
          const client = HttpClient.make((request) => {
            requests += 1;
            const wrong = { ...savedReceipt() };
            if (mismatch === "orderId") {
              wrong.orderId = "another-order";
            }
            if (mismatch === "orderNumber") {
              wrong.orderNumber = "OBJ-2026-9999";
            }
            if (mismatch === "scope") {
              wrong.scope = { ...scope, marketId: "another-market" };
            }
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  result: wrong,
                  state: "confirmed",
                }),
              ),
            );
          }).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("https://n1.example")));
          const program = recoverConfirmedCheckoutProgram({
            expected: confirmedPlacement(),
            guard: receiptGuard,
            isCurrent: () => current,
            locale: "cs",
            onConfirmed: (result) => {
              accept(result);
            },
            onUnavailable: () => {
              unavailable();
            },
          }).pipe(Effect.provideService(HttpClient.HttpClient, client));
          yield* program;
          expect(requests).toBe(0);
          current = true;
          yield* program;
          expect(requests).toBe(1);
          expect(accept).not.toHaveBeenCalled();
          expect(unavailable).toHaveBeenCalledTimes(1);
        }),
    );
  }
});
