import { describe, expect, rs } from "@rstest/core";
import { Effect, Fiber, Logger, Schema } from "effect";
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
                "server-timing": `gateway;dur=${String(index + 1)}, owner;dur=7`,
                "x-ontos-gateway-context": JSON.stringify({
                  apiBaseUrl: "/shell-super-app-api/gateway/merchandise",
                  compositionRevision: "a".repeat(64),
                  expiresAt: 9_999_999_999,
                  token: `test-redeemed-context-${index}`,
                }),
              }
            : { "server-timing": "gateway;dur=2" },
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

/** A connection that never answers, like a stalled balancer connection; only the read's own deadline ends it. */
const stalled: typeof globalThis.fetch = async () =>
  await Promise.withResolvers<Response>().promise;

type CapturedReadLog = ReturnType<typeof Logger.formatStructured.log>;
const collectReadLogs = (logs: CapturedReadLog[]) =>
  Logger.layer([
    Logger.make((options) => {
      logs.push(Logger.formatStructured.log(options));
    }),
  ]);

describe("governed read timing log", () => {
  it.effect(
    "logs one Info line per attempt with its correlation id and the gateway Server-Timing",
    () =>
      Effect.gen(function* logsEveryAttempt() {
        const owner = scenario([503, 200]);
        const logs: CapturedReadLog[] = [];
        const fiber = yield* Effect.forkChild(
          owner.program.pipe(Effect.provide(collectReadLogs(logs))),
        );
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(fiber);
        expect(logs).toHaveLength(2);
        expect(logs.map((log) => [log.message, log.level])).toEqual([
          ["N1 gateway read", "INFO"],
          ["N1 gateway read", "INFO"],
        ]);
        expect(logs.map((log) => log.annotations)).toEqual(
          owner.calls.map((call, index) => ({
            attempt: index + 1,
            audience: "commerce-market-catalog",
            correlationId: call.headers.get("x-correlation-id"),
            durationMs: 0,
            readName: "current-market-catalog",
            serverTiming: index === 0 ? "gateway;dur=2" : "gateway;dur=2, owner;dur=7",
            status: index === 0 ? 503 : 200,
          })),
        );
        const text = JSON.stringify(logs);
        for (const value of [
          config.apiKey,
          config.legalEntityId,
          "2026-11-03T00:00:00Z",
          "real owner result",
        ]) {
          expect(text).not.toContain(value);
        }
      }),
  );

  it.effect("logs a stalled connection once, with its measured duration and no Server-Timing", () =>
    Effect.gen(function* logsStalledRead() {
      const logs: CapturedReadLog[] = [];
      const fiber = yield* Effect.forkChild(
        readOwner(
          config,
          "merchandise",
          "records",
          { at: "2026-11-03T00:00:00Z" },
          Schema.Struct({ message: Schema.String }),
        ).pipe(
          Effect.flip,
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.Fetch, stalled),
          Effect.provide(collectReadLogs(logs)),
        ),
      );
      yield* TestClock.adjust("10 seconds");
      const failure = yield* Fiber.join(fiber);
      expect(failure.reason).toBe("transport");
      expect(logs).toHaveLength(1);
      expect(logs[0]?.annotations).toMatchObject({
        attempt: 1,
        audience: "merchandise",
        durationMs: 10_000,
        readName: "records",
        serverTiming: "none",
        status: "transport",
      });
    }),
  );
});
