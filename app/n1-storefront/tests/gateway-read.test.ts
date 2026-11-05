import { describe, expect, rs } from "@rstest/core";
import { Effect, Fiber, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { it } from "effect-rstest";
import { readOwner } from "../src/ontos/gateway";

rs.mock("server-only", () => ({}));

const config = {
  apiKey: "test-only-service-credential",
  appId: "n1-storefront",
  legalEntityId: "71000000-0000-4000-8000-000000000099",
  shellUrl: "https://shell.example",
  tenantId: "70000000-0000-4000-8000-000000000099",
};

const scenario = (statuses: readonly number[], validContract = true) => {
  const calls: Request[] = [];
  const fetch: typeof globalThis.fetch = (url, init) => {
    const request = new Request(url, init);
    const index = calls.length;
    calls.push(request);
    const status = statuses[index] ?? statuses.at(-1) ?? 503;
    return Promise.resolve(
      Response.json(status === 200 && validContract ? { message: "real owner result" } : {}, {
        headers:
          status === 200
            ? {
                "x-ontos-gateway-context": JSON.stringify({
                  apiBaseUrl: "/shell-super-app-api/gateway/merchandise",
                  compositionRevision: "a".repeat(64),
                  expiresAt: 9_999_999_999,
                  token: `test-redeemed-context-${index}`,
                }),
              }
            : {},
        status,
      }),
    );
  };
  const program = readOwner(
    config,
    "commerce-market-catalog",
    "current-market-catalog",
    { at: "2026-11-03T00:00:00Z" },
    Schema.Struct({ message: Schema.String }),
  ).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  );
  return { calls, program };
};

describe("governed read recovery", () => {
  it.effect.each([409, 502, 503])("reissues the combined read after transient HTTP %s", (status) =>
    Effect.gen(function* recoverTransientRead() {
      const owner = scenario([status, 200]);
      const fiber = yield* Effect.forkChild(owner.program);
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(fiber)).toEqual({ message: "real owner result" });
      expect(owner.calls).toHaveLength(2);
      expect(new Set(owner.calls.map((call) => call.headers.get("x-correlation-id"))).size).toBe(2);
      for (const call of owner.calls) {
        expect(call.url).toBe(
          "https://shell.example/shell-super-app-api/auth/api-key/gateway-read",
        );
        expect(call.headers.get("authorization")).toBeNull();
        expect(call.headers.get("x-api-key")).toBe(config.apiKey);
      }
    }),
  );

  it.effect("stops after three unavailable responses and preserves the failure", () =>
    Effect.gen(function* stopUnavailableRead() {
      const owner = scenario([503]);
      const fiber = yield* Effect.forkChild(Effect.flip(owner.program));
      yield* TestClock.adjust("1 second");
      const failure = yield* Fiber.join(fiber);
      expect(failure).toMatchObject({ reason: "response", status: 503 });
      expect(owner.calls).toHaveLength(3);
    }),
  );

  it.effect.each([401, 403, 500])("does not retry definite or unrelated HTTP %s", (status) =>
    Effect.gen(function* preserveDefiniteFailure() {
      const owner = scenario([status]);
      const failure = yield* Effect.flip(owner.program);
      expect(failure.status).toBe(status);
      expect(owner.calls).toHaveLength(1);
    }),
  );

  it.effect("does not hide a successful response with an invalid owner contract", () =>
    Effect.gen(function* preserveInvalidContract() {
      const owner = scenario([200], false);
      const failure = yield* Effect.flip(owner.program);
      expect(failure.reason).toBe("contract");
      expect(owner.calls).toHaveLength(1);
    }),
  );
});
