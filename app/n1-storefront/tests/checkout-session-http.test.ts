import { describe, expect } from "@rstest/core";
import { it } from "effect-rstest";
import { Clock, Context, Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { makeCheckoutWeb } from "../src/ontos/checkout-http";
import { CheckoutFailure } from "../src/ontos/checkout-context";
import type { CheckoutRecoveryRequest, CheckoutRequest } from "../src/ontos/checkout";
import type { PortalRequestContext } from "../src/ontos/portal-server";

type CheckoutServices = Required<NonNullable<Parameters<typeof makeCheckoutWeb>[0]>>;

const scope = {
  currency: "CZK",
  legalEntityId: "71000000-0000-4000-8000-000000000099",
  marketId: "71000000-0000-4000-8000-000000000097",
  tenantId: "71000000-0000-4000-8000-000000000098",
};
const intent = {
  clientRequestId: "71000000-0000-4000-8000-000000000096",
  locale: "cs",
  scope,
};
const input = {
  ...intent,
  address: { city: "Praha", country: "CZ", postalCode: "11000", street: "Testovací 1" },
  contact: { email: "buyer@example.test", firstName: "Jan", lastName: "Novák" },
  expectedShippingPriceMinor: 12_900,
  lines: [{ expectedUnitPriceMinor: 1210, productId: "product-1", quantity: 2 }],
  mode: "place",
  shippingMethod: "PPL",
};
const refuse = (
  _input: CheckoutRequest | CheckoutRecoveryRequest,
  context?: PortalRequestContext,
) => {
  expect(context?.origin).toBe("https://n1.example");
  expect(context?.cookie).toBe("commerce-portal.session=customer-session");
  context?.setCookies.push("commerce-portal.session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");
  return Effect.fail(new CheckoutFailure({ state: "forbidden" }));
};

describe("checkout Portal request boundary", () => {
  it.effect(
    "retains admission cookie deletion when later native dispatch exceeds its deadline",
    () =>
      Effect.gen(function* deadlineKeepsPortalCookieUpdate() {
        const admitted = yield* Deferred.make<null>();
        const submissions: CheckoutRequest[] = [];
        const recoveries: CheckoutRecoveryRequest[] = [];
        const submit: CheckoutServices["submit"] = (request, context) => {
          submissions.push(request);
          context?.setCookies.push(
            "commerce-portal.session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
          );
          return Deferred.succeed(admitted, null).pipe(Effect.andThen(Effect.never));
        };
        const recover: CheckoutServices["recover"] = (request, context) => {
          recoveries.push(request);
          return refuse(request, context);
        };
        const checkoutWeb = yield* Effect.acquireRelease(
          Effect.sync(() => makeCheckoutWeb({ recover, submit })),
          (handler) => Effect.promise(() => handler.dispose()),
        );
        const clock = yield* Clock.Clock;
        const fiber = yield* Effect.promise(() =>
          checkoutWeb.handler(
            new Request("https://n1.example/api/checkout", {
              body: JSON.stringify(input),
              headers: {
                "content-type": "application/json",
                cookie: "commerce-portal.session=customer-session",
                origin: "https://n1.example",
              },
              method: "POST",
            }),
            Context.make(Clock.Clock, clock),
          ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(admitted);
        yield* TestClock.adjust("55 seconds");
        const response = yield* Fiber.join(fiber);
        expect(response.status).toBe(503);
        expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
        expect(response.headers.get("set-cookie")).toContain("commerce-portal.session=");
        const body = yield* Effect.promise(() => response.json());
        expect(body.state).toBe("uncertain");
        expect(submissions).toHaveLength(1);
        expect(recoveries).toHaveLength(0);
      }).pipe(Effect.scoped),
  );
  for (const status of [false, true]) {
    it.effect(
      `preserves filtered Portal context and cookie deletion on ${status ? "status" : "execute"} refusal`,
      () =>
        Effect.gen(function* portalCookieBoundary() {
          const submissions: CheckoutRequest[] = [];
          const recoveries: CheckoutRecoveryRequest[] = [];
          const submit: CheckoutServices["submit"] = (request, context) => {
            submissions.push(request);
            return refuse(request, context);
          };
          const recover: CheckoutServices["recover"] = (request, context) => {
            recoveries.push(request);
            return refuse(request, context);
          };
          const checkoutWeb = yield* Effect.acquireRelease(
            Effect.sync(() => makeCheckoutWeb({ recover, submit })),
            (handler) => Effect.promise(() => handler.dispose()),
          );
          const response = yield* Effect.promise(() =>
            checkoutWeb.handler(
              new Request(`https://n1.example/api/checkout${status ? "/status" : ""}`, {
                body: JSON.stringify(status ? intent : input),
                headers: {
                  "content-type": "application/json",
                  cookie: "staff.session=private-staff; commerce-portal.session=customer-session",
                  origin: "https://n1.example",
                },
                method: "POST",
              }),
            ),
          );
          expect(response.status).toBe(403);
          expect(response.headers.get("cache-control")).toBe("no-store");
          expect(response.headers.get("set-cookie")).toContain("commerce-portal.session=");
          expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
          expect(response.headers.get("set-cookie")).not.toContain("staff.session");
          const body = yield* Effect.promise(() => response.json());
          expect(body.state).toBe("forbidden");
          expect(JSON.stringify(body)).not.toContain("customer-session");
          expect(status ? recoveries : submissions).toHaveLength(1);
        }).pipe(Effect.scoped),
    );
  }
});
