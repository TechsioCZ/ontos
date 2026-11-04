import { describe, expect } from "@rstest/core";
import { it } from "effect-rstest";
import { Context, Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { customerProfileWeb } from "../src/ontos/customer-profile-http";

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
