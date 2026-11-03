import { rs } from "@rstest/core";
import { Effect } from "effect";
import { describe, expect, it } from "effect-rstest";

import { portalHandler } from "../src/ontos/portal-http";

rs.mock("server-only", () => ({}));

const origin = "https://n1.example";
const secret = "a".repeat(6);
const loginUrl = `${origin}/api/account/login`;

describe("email verification callback", () => {
  for (const query of [
    "",
    "?token=",
    "?token=one&token=two",
    "?token=one&callbackURL=first&callbackURL=second",
    "?token=one&unknown=attacker",
    `?token=one&callbackURL=${"a".repeat(2049)}`,
    `?token=${"a".repeat(2049)}`,
  ]) {
    it.effect(
      `rejects invalid verification query without relaying its values (${query.length})`,
      () =>
        Effect.gen(function* verificationQueryBoundary() {
          const response = yield* Effect.promise(
            async () =>
              await portalHandler(
                new Request(
                  `${origin}/commerce-customer-context-api/api/portal-auth/verify-email${query}`,
                  { headers: { cookie: "staff.session=private", host: "n1.example" } },
                ),
              ),
          );
          expect(response.status).toBe(303);
          expect(response.headers.get("location")).toBe("/cs/prihlaseni?verification=invalid");
          expect(response.headers.get("cache-control")).toBe("no-store");
          expect(response.headers.get("referrer-policy")).toBe("no-referrer");
          expect(response.headers.get("set-cookie")).toBeNull();
          const body = yield* Effect.promise(async () => await response.text());
          expect(body).not.toContain("token=");
        }),
    );
  }
});

describe("portal credential HTTP boundary", () => {
  it.effect("rejects foreign origins before attempting to decode credentials", () =>
    Effect.gen(function* guardsBeforeDecode() {
      const response = yield* Effect.promise(
        async () =>
          await portalHandler(
            new Request(loginUrl, {
              body: "not-json",
              headers: {
                "content-type": "application/json",
                host: "n1.example",
                origin: "https://foreign.example",
              },
              method: "POST",
            }),
          ),
      );
      expect(response.status).toBe(403);
      const body = yield* Effect.promise(async () => await response.text());
      expect(body).not.toContain("not-json");
    }),
  );
  it.effect("does not echo malformed password input in schema problems", () =>
    Effect.gen(function* sanitizesSchemaFailure() {
      const response = yield* Effect.promise(
        async () =>
          await portalHandler(
            new Request(loginUrl, {
              body: JSON.stringify({
                email: "shopper@example.com",
                password: secret,
                rememberMe: false,
              }),
              headers: { "content-type": "application/json", host: "n1.example", origin },
              method: "POST",
            }),
          ),
      );
      expect(response.status).toBe(400);
      const body = yield* Effect.promise(async () => await response.text());
      expect(body).not.toContain(secret);
      expect(body).not.toContain("shopper@example.com");
      expect(body).not.toContain("issues");
    }),
  );
  it.effect("fails native credential forms without echoing or redirecting passwords", () =>
    Effect.gen(function* rejectsNativeForm() {
      const response = yield* Effect.promise(
        async () =>
          await portalHandler(
            new Request(loginUrl, {
              body: new URLSearchParams({ email: "shopper@example.com", password: secret }),
              headers: {
                "content-type": "application/x-www-form-urlencoded",
                host: "n1.example",
                origin,
              },
              method: "POST",
            }),
          ),
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.headers.get("location")).toBeNull();
      const body = yield* Effect.promise(async () => await response.text());
      expect(body).not.toContain(secret);
      expect(body).not.toContain("shopper@example.com");
    }),
  );
  it.effect("refuses account identifiers in the query before any owner request", () =>
    Effect.gen(function* rejectsAccountQuery() {
      const response = yield* Effect.promise(
        async () =>
          await portalHandler(
            new Request(`${origin}/api/account?customerId=attacker`, {
              headers: { host: "n1.example" },
            }),
          ),
      );
      expect(response.status).toBe(400);
      const body = yield* Effect.promise(async () => await response.text());
      expect(body).not.toContain("attacker");
    }),
  );
});

it.effect("rejects unknown seller fields at the real HTTP decoder", () =>
  Effect.gen(function* rejectsSellerAtHttpBoundary() {
    const response = yield* Effect.promise(
      async () =>
        await portalHandler(
          new Request(loginUrl, {
            body: JSON.stringify({
              email: "shopper@example.com",
              password: secret.repeat(2),
              rememberMe: false,
              sellingLegalEntityId: "attacker",
            }),
            headers: { "content-type": "application/json", host: "n1.example", origin },
            method: "POST",
          }),
        ),
    );
    expect(response.status).toBe(400);
    const body = yield* Effect.promise(async () => await response.text());
    expect(body).not.toContain(secret);
    expect(body).not.toContain("attacker");
  }),
);

for (const [requestOrigin, expected] of [
  ["http://127.0.0.1:3071", 400],
  ["http://localhost:3071", 403],
  ["https://127.0.0.1:3071", 403],
  ["http://127.0.0.1:3072", 403],
] as const) {
  it.effect(
    `uses actual Host authority rather than normalized framework hostname for ${requestOrigin}`,
    () =>
      Effect.gen(function* actualHostOriginBoundary() {
        const response = yield* Effect.promise(
          async () =>
            await portalHandler(
              new Request("http://localhost:3071/api/account/login", {
                body: JSON.stringify({
                  email: "invalid",
                  password: secret.repeat(2),
                  rememberMe: false,
                }),
                headers: {
                  "content-type": "application/json",
                  host: "127.0.0.1:3071",
                  origin: requestOrigin,
                },
                method: "POST",
              }),
            ),
        );
        expect(response.status).toBe(expected);
        const body = yield* Effect.promise(async () => await response.text());
        expect(body).not.toContain(secret);
      }),
  );
}
