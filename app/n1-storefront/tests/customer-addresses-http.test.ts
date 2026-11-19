import { expect } from "@rstest/core";
import { it } from "effect-rstest";
import { Clock, Context, Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { makeCustomerProfileWeb } from "../src/ontos/customer-profile-http";
import { CustomerProfileFailure } from "../src/ontos/customer-profile-server";
import type { readCustomerAddresses } from "../src/ontos/customer-addresses-server";
import type { CustomerAddressesRead } from "../src/ontos/customer-addresses";

const request = () =>
  new Request("https://n1.example/api/customer-addresses", {
    headers: { cookie: "staff.session=private; commerce-portal.session=customer-session" },
  });
const deletion = "commerce-portal.session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax";

it.effect("retains Portal cookie deletion on the typed address deadline response", () =>
  Effect.gen(function* addressDeadline() {
    const admitted = yield* Deferred.make<null>();
    const cookies: string[] = [];
    const readAddresses: typeof readCustomerAddresses = (context) =>
      Effect.gen(function* stalledAddressRead() {
        cookies.push(context.cookie);
        expect(context.cookie).toBe("commerce-portal.session=customer-session");
        context.setCookies.push(deletion);
        yield* Deferred.succeed(admitted, null);
        return yield* Effect.never;
      });
    const web = yield* Effect.acquireRelease(
      Effect.sync(() => makeCustomerProfileWeb({ readAddresses })),
      (handler) => Effect.promise(() => handler.dispose()),
    );
    const clock = yield* Clock.Clock;
    const fiber = yield* Effect.promise(() =>
      web.handler(request(), Context.make(Clock.Clock, clock)),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(admitted);
    yield* TestClock.adjust("55 seconds");
    const response = yield* Fiber.join(fiber);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("set-cookie")).not.toContain("staff.session");
    expect(yield* Effect.promise(() => response.json())).toMatchObject({
      state: "unavailable",
      status: 503,
    });
    expect(cookies).toEqual(["commerce-portal.session=customer-session"]);
  }).pipe(Effect.scoped),
);

for (const state of ["anonymous", "forbidden"] as const) {
  it.effect(`preserves cookie deletion and no-store on ${state} address refusal`, () =>
    Effect.gen(function* addressRefusal() {
      const readAddresses: typeof readCustomerAddresses = (context) =>
        Effect.gen(function* refusedAddressRead() {
          context.setCookies.push(deletion);
          return yield* Effect.fail(new CustomerProfileFailure({ state }));
        });
      const web = yield* Effect.acquireRelease(
        Effect.sync(() => makeCustomerProfileWeb({ readAddresses })),
        (handler) => Effect.promise(() => handler.dispose()),
      );
      const response = yield* Effect.promise(() => web.handler(request()));
      expect(response.status).toBe(state === "anonymous" ? 401 : 403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(yield* Effect.promise(() => response.json())).toMatchObject({ state });
    }).pipe(Effect.scoped),
  );
}

it.effect(
  "encodes the address endpoint with its own DTO schema and preserves optional postal fields",
  () =>
    Effect.gen(function* addressResponse() {
      const postal = {
        addressLine1: "Ulice 1",
        addressLine2: "Patro 2",
        city: "Praha",
        countryCode: "CZ",
        postalCode: "11000",
        region: "Praha",
      };
      const result = {
        addresses: [
          {
            id: "address-a",
            isBillingDefault: false,
            isDeliveryDefault: true,
            location: { address: postal, state: "available" },
            purposes: ["DELIVERY"],
          },
        ],
        state: "ready",
        viewerEmail: "owner@example.test",
      } satisfies CustomerAddressesRead;
      const readAddresses: typeof readCustomerAddresses = (context) =>
        Effect.sync(() => {
          context.setCookies.push(
            "commerce-portal.session=rotated; Path=/; HttpOnly; SameSite=Lax",
          );
          return result;
        });
      const web = yield* Effect.acquireRelease(
        Effect.sync(() => makeCustomerProfileWeb({ readAddresses })),
        (handler) => Effect.promise(() => handler.dispose()),
      );
      const response = yield* Effect.promise(() => web.handler(request()));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("set-cookie")).toContain("commerce-portal.session=rotated");
      const body = yield* Effect.promise(() => response.json());
      expect(body).toEqual(result);
      expect(JSON.stringify(body)).not.toContain("profileRef");
      expect(JSON.stringify(body)).not.toContain("partyRef");
    }).pipe(Effect.scoped),
);
