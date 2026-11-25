import { describe, expect } from "@rstest/core";
import { it } from "effect-rstest";
import { Context, Deferred, Effect } from "effect";
import { createOperation, OperationError, REQUEST_LIMIT } from "@ontos/storefront-runtime";
import { FetchHttpClient } from "effect/http";
import { customerProfileWeb, makeCustomerProfileWeb } from "../src/ontos/customer-profile-http";
import { CurrentOperation, withOwnerOperation } from "../src/ontos/owner-operation";

const origin = "https://n1.example";
const profile = {
  contactEmail: "contact@example.test",
  displayName: "Jan Novák",
  phone: "",
  version: "a".repeat(64),
};
const updateRequest = (body: string, requestOrigin = origin) =>
  new Request(`${origin}/api/customer-profile`, {
    body,
    headers: { "content-type": "application/json", host: "n1.example", origin: requestOrigin },
    method: "POST",
  });
const noNetwork = () => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = () => {
    calls += 1;
    return Promise.resolve(Response.json({}, { status: 503 }));
  };
  return { context: Context.make(FetchHttpClient.Fetch, fetch), count: () => calls };
};

it.effect("preserves captured Portal deletion on an interrupted profile response", () =>
  Effect.gen(function* interruptedProfileCookie() {
    const web = yield* Effect.acquireRelease(
      Effect.sync(() =>
        makeCustomerProfileWeb({
          updateProfile: (_input, context) =>
            Effect.gen(function* interruptedWrite() {
              context.setCookies.push("better-auth.session_token=; Path=/; HttpOnly; Max-Age=0");
              const operation = yield* CurrentOperation;
              operation?.abort("deadline");
              return yield* Effect.never;
            }),
        }),
      ),
      (handler) => Effect.promise(() => handler.dispose()),
    );
    const response = yield* Effect.promise(() =>
      web.handler(updateRequest(JSON.stringify(profile))),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toContain("better-auth.session_token=");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  }).pipe(Effect.scoped),
);

for (const suffix of ["?profileId=foreign", "?tenantId=foreign"]) {
  it.effect(`refuses address subject selection ${suffix} before contacting the native owner`, () =>
    Effect.gen(function* rejectedAddressSubject() {
      const owner = noNetwork();
      const response = yield* Effect.promise(() =>
        customerProfileWeb.handler(
          new Request(`${origin}/api/customer-addresses${suffix}`, {
            headers: { host: "n1.example" },
          }),
          owner.context,
        ),
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(owner.count()).toBe(0);
    }),
  );
}

it.effect("refuses cross-origin address reads before contacting the native owner", () =>
  Effect.gen(function* rejectedAddressOrigin() {
    const owner = noNetwork();
    const response = yield* Effect.promise(() =>
      customerProfileWeb.handler(
        new Request(`${origin}/api/customer-addresses`, {
          headers: { host: "n1.example", origin: "https://foreign.example" },
        }),
        owner.context,
      ),
    );
    expect(response.status).toBe(403);
    expect(owner.count()).toBe(0);
  }),
);

describe("own profile HTTP contract", () => {
  for (const field of [
    "partyId",
    "customerAccountId",
    "tenantId",
    "loginEmail",
    "firstName",
    "lastName",
  ]) {
    it.effect(`rejects unsupported identity field ${field} without owner access`, () =>
      Effect.gen(function* rejectInjectedIdentity() {
        const owner = noNetwork();
        const response = yield* Effect.promise(() =>
          customerProfileWeb.handler(
            updateRequest(JSON.stringify({ ...profile, [field]: "not-an-authority" })),
            owner.context,
          ),
        );
        expect(response.status).toBe(400);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("content-type")).toContain("application/problem+json");
        const body = yield* Effect.promise(() => response.text());
        expect(body).not.toContain("not-an-authority");
        expect(body).not.toContain("contact@example.test");
        expect(owner.count()).toBe(0);
      }),
    );
  }
  it.effect("rejects a cross-origin update before decoding submitted profile data", () =>
    Effect.gen(function* sameOriginProfile() {
      const owner = noNetwork();
      const response = yield* Effect.promise(() =>
        customerProfileWeb.handler(
          updateRequest("not-json", "https://foreign.example"),
          owner.context,
        ),
      );
      expect(response.status).toBe(403);
      expect(owner.count()).toBe(0);
    }),
  );
  it.effect("rejects an explicitly cross-origin profile GET", () =>
    Effect.gen(function* crossOriginRead() {
      const owner = noNetwork();
      const request = new Request(`${origin}/api/customer-profile`, {
        headers: { host: "n1.example", origin: "https://foreign.example" },
      });
      const response = yield* Effect.promise(() =>
        customerProfileWeb.handler(request, owner.context),
      );
      expect(response.status).toBe(403);
      expect(owner.count()).toBe(0);
    }),
  );
  it.effect("does not accept a missing or malformed native CAS version", () =>
    Effect.gen(function* nativeVersionRequired() {
      const owner = noNetwork();
      const response = yield* Effect.promise(() =>
        customerProfileWeb.handler(
          updateRequest(JSON.stringify({ ...profile, version: "old" })),
          owner.context,
        ),
      );
      expect(response.status).toBe(400);
      expect(owner.count()).toBe(0);
    }),
  );
  it.effect("rejects unexpected query parameters and oversized input", () =>
    Effect.gen(function* boundedProfileBody() {
      const owner = noNetwork();
      const query = new Request(`${origin}/api/customer-profile?partyId=foreign`, {
        headers: { host: "n1.example" },
      });
      const read = yield* Effect.promise(() => customerProfileWeb.handler(query, owner.context));
      expect(read.status).toBe(400);
      const large = updateRequest(JSON.stringify(profile));
      large.headers.set("content-length", "16385");
      const update = yield* Effect.promise(() => customerProfileWeb.handler(large, owner.context));
      expect(update.status).toBe(400);
      expect(owner.count()).toBe(0);
    }),
  );
  it.effect("rejects a native HTML form rather than interpreting it as a profile update", () =>
    Effect.gen(function* jsonOnly() {
      const owner = noNetwork();
      const request = new Request(`${origin}/api/customer-profile`, {
        body: new URLSearchParams({ displayName: "not-json" }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          host: "n1.example",
          origin,
        },
        method: "POST",
      });
      const response = yield* Effect.promise(() =>
        customerProfileWeb.handler(request, owner.context),
      );
      expect(response.status).toBe(400);
      expect(owner.count()).toBe(0);
    }),
  );
});

for (const boundary of ["channel", "outer"] as const) {
  it.effect(`keeps a profile read deadline at the ${boundary} boundary unavailable`, () =>
    Effect.gen(function* unavailableRead() {
      const web = yield* Effect.acquireRelease(
        Effect.sync(() =>
          makeCustomerProfileWeb({
            readProfile: () =>
              Effect.gen(function* failedRead() {
                if (boundary === "channel") {
                  return yield* Effect.fail(new OperationError("deadline"));
                }
                const operation = yield* CurrentOperation;
                expect(operation).toBeDefined();
                operation?.abort("deadline");
                return yield* Effect.never;
              }),
          }),
        ),
        (handler) => Effect.promise(() => handler.dispose()),
      );
      const response = yield* Effect.promise(() =>
        web.handler(new Request(`${origin}/api/customer-profile`)),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        _tag: "CustomerProfileUnavailableProblem",
        state: "unavailable",
        status: 503,
      });
    }).pipe(Effect.scoped),
  );
  for (const kind of ["cancelled", "deadline", "body_oversize"] as const) {
    for (const path of ["customer-profile", "customer-addresses"] as const) {
      it.effect(
        `keeps a possibly committed ${path} ${kind} at the ${boundary} boundary unconfirmed`,
        () =>
          Effect.gen(function* uncertainWrite() {
            let writes = 0;
            const failWrite = () =>
              Effect.gen(function* dispatchedWrite() {
                writes += 1;
                if (boundary === "channel") {
                  return yield* Effect.fail(new OperationError(kind));
                }
                const operation = yield* CurrentOperation;
                expect(operation).toBeDefined();
                operation?.abort(kind);
                return yield* Effect.never;
              });
            const web = yield* Effect.acquireRelease(
              Effect.sync(() =>
                makeCustomerProfileWeb({
                  changeAddress: failWrite,
                  updateProfile: failWrite,
                }),
              ),
              (handler) => Effect.promise(() => handler.dispose()),
            );
            const response = yield* Effect.promise(() =>
              web.handler(
                new Request(`${origin}/api/${path}`, {
                  body: JSON.stringify(
                    path === "customer-profile"
                      ? profile
                      : {
                          addressId: "own-address",
                          operation: "remove",
                          operationId: "00000000-0000-4000-8000-000000000010",
                          revision: 2,
                        },
                  ),
                  headers: { "content-type": "application/json", origin },
                  method: "POST",
                }),
              ),
            );
            expect(response.status).toBe(503);
            expect(response.headers.get("content-type")).toContain("application/problem+json");
            expect(response.headers.get("cache-control")).toBe("no-store");
            expect(yield* Effect.promise(() => response.json())).toMatchObject({
              _tag: "CustomerProfileUnconfirmedProblem",
              state: "unconfirmed",
              status: 503,
            });
            expect(writes).toBe(1);
          }).pipe(Effect.scoped),
      );
    }
  }
}

it.effect(
  "reports saturated admission as typed unavailable without dispatching a profile write",
  () =>
    Effect.gen(function* unavailableBeforeDispatch() {
      const full = yield* Deferred.make<null>();
      let admitted = 0;
      yield* Effect.all(
        Array.from({ length: REQUEST_LIMIT }, () =>
          Effect.acquireUseRelease(
            createOperation(),
            (operation) =>
              withOwnerOperation(
                Effect.gen(function* holdAdmission() {
                  admitted += 1;
                  if (admitted === REQUEST_LIMIT) {
                    yield* Deferred.succeed(full, null);
                  }
                  return yield* Effect.never;
                }),
                { operation },
              ),
            (operation) => Effect.sync(() => operation.dispose()),
          ),
        ),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* Deferred.await(full);
      let writes = 0;
      const web = yield* Effect.acquireRelease(
        Effect.sync(() =>
          makeCustomerProfileWeb({
            updateProfile: () =>
              Effect.sync(() => {
                writes += 1;
                return { profile, state: "ready" as const };
              }),
          }),
        ),
        (handler) => Effect.promise(() => handler.dispose()),
      );
      const response = yield* Effect.promise(() =>
        web.handler(updateRequest(JSON.stringify(profile))),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        _tag: "CustomerProfileUnavailableProblem",
        state: "unavailable",
        status: 503,
      });
      expect(writes).toBe(0);
    }).pipe(Effect.scoped),
);
