import { expect } from "@rstest/core";
import { it } from "effect-rstest";
import { Clock, Context, Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { makeCustomerProfileWeb } from "../src/ontos/customer-profile-http";
import { CustomerProfileFailure } from "../src/ontos/customer-profile-server";
import type {
  changeCustomerAddress,
  readCustomerAddresses,
} from "../src/ontos/customer-addresses-server";
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
            revision: 1,
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

const removeCommand = {
  addressId: "own-address",
  operation: "remove",
  operationId: "00000000-0000-4000-8000-000000000010",
  revision: 2,
} as const;

it.effect("preserves the address revision and operation identity on an own-address mutation", () =>
  Effect.gen(function* changeAddresses() {
    const calls: unknown[] = [];
    const changeAddress: typeof changeCustomerAddress = (command, context) =>
      Effect.sync(() => {
        calls.push(command);
        expect(context.cookie).toBe("commerce-portal.session=customer-session");
        return { outcome: "SAVED" as const };
      });
    const web = yield* Effect.acquireRelease(
      Effect.sync(() => makeCustomerProfileWeb({ changeAddress })),
      (handler) => Effect.promise(() => handler.dispose()),
    );
    const send = (origin: string, body: typeof removeCommand & { profileId?: string }) =>
      Effect.promise(() =>
        web.handler(
          new Request(request(), {
            body: JSON.stringify(body),
            headers: {
              ...Object.fromEntries(request().headers),
              "content-type": "application/json",
              origin,
            },
            method: "POST",
          }),
        ),
      );
    const invalidSubject = yield* send("https://n1.example", {
      ...removeCommand,
      profileId: "foreign",
    });
    const invalidOrigin = yield* send("https://other.example", removeCommand);
    expect(invalidSubject.status).toBe(400);
    expect(invalidOrigin.status).toBe(403);
    expect(calls).toEqual([]);
    const accepted = yield* send("https://n1.example", removeCommand);
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("cache-control")).toBe("no-store");
    expect(yield* Effect.promise(() => accepted.json())).toEqual({ outcome: "SAVED" });
    expect(calls).toEqual([removeCommand]);
  }).pipe(Effect.scoped),
);
