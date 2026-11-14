import { beforeEach, expect, rs } from "@rstest/core";
import { it } from "effect-rstest";
import { Clock, Context, Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { customerProfileWeb } from "../src/ontos/customer-profile-http";
import { CustomerProfileFailure } from "../src/ontos/customer-profile-server";
import { readCustomerAddresses } from "../src/ontos/customer-addresses-server";

rs.mock("../src/ontos/customer-addresses-server", () => ({ readCustomerAddresses: rs.fn() }));

const request = () =>
  new Request("https://n1.example/api/customer-addresses", {
    headers: { cookie: "staff.session=private; commerce-portal.session=customer-session" },
  });
const deletion = "commerce-portal.session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax";
beforeEach(() => {
  rs.clearAllMocks();
});

it.effect("retains Portal cookie deletion on the typed address deadline response", () =>
  Effect.gen(function* addressDeadline() {
    const admitted = yield* Deferred.make<null>();
    rs.mocked(readCustomerAddresses).mockImplementation((context) => {
      expect(context.cookie).toBe("commerce-portal.session=customer-session");
      context.setCookies.push(deletion);
      return Deferred.succeed(admitted, null).pipe(Effect.andThen(Effect.never));
    });
    const clock = yield* Clock.Clock;
    const fiber = yield* Effect.promise(() =>
      customerProfileWeb.handler(request(), Context.make(Clock.Clock, clock)),
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
    expect(readCustomerAddresses).toHaveBeenCalledTimes(1);
  }),
);

for (const state of ["anonymous", "forbidden"] as const) {
  it.effect(`preserves cookie deletion and no-store on ${state} address refusal`, () =>
    Effect.gen(function* addressRefusal() {
      rs.mocked(readCustomerAddresses).mockImplementation((context) => {
        context.setCookies.push(deletion);
        return Effect.fail(new CustomerProfileFailure({ state }));
      });
      const response = yield* Effect.promise(() => customerProfileWeb.handler(request()));
      expect(response.status).toBe(state === "anonymous" ? 401 : 403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(yield* Effect.promise(() => response.json())).toMatchObject({ state });
    }),
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
            location: { address: postal, state: "available" as const },
            purposes: ["DELIVERY" as const],
          },
        ],
        state: "ready" as const,
        viewerEmail: "owner@example.test",
      };
      rs.mocked(readCustomerAddresses).mockImplementation((context) => {
        context.setCookies.push("commerce-portal.session=rotated; Path=/; HttpOnly; SameSite=Lax");
        return Effect.succeed(result);
      });
      const response = yield* Effect.promise(() => customerProfileWeb.handler(request()));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("set-cookie")).toContain("commerce-portal.session=rotated");
      const body = yield* Effect.promise(() => response.json());
      expect(body).toEqual(result);
      expect(JSON.stringify(body)).not.toContain("profileRef");
      expect(JSON.stringify(body)).not.toContain("partyRef");
    }),
);
