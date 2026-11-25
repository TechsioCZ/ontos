import { Effect, Fiber, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { describe, expect, it } from "effect-rstest";
import {
  createOperation,
  ERROR_BYTES,
  REQUEST_LIMIT,
  OWNER_WORK_LIMIT,
} from "@ontos/storefront-runtime";
import type { Operation } from "@ontos/storefront-runtime";
import { readOwner } from "../src/ontos/gateway";
import { storefrontHttpClientLayer, withOwnerOperation } from "../src/ontos/owner-operation";

const config = {
  apiKey: "test-key",
  appId: "n1-storefront",
  legalEntityId: "71000000-0000-4000-8000-000000000099",
  shellUrl: "https://shell.example",
  tenantId: "70000000-0000-4000-8000-000000000099",
};
const headers = {
  "content-type": "application/json",
  "x-ontos-gateway-context": JSON.stringify({
    apiBaseUrl: "/shell-super-app-api/module-api/owner",
    compositionRevision: "a".repeat(64),
    expiresAt: 99,
    token: "once",
  }),
};
const read = (operation?: Operation) =>
  readOwner(
    config,
    "merchandise",
    "records",
    { at: "2026-01-01" },
    Schema.Struct({ ok: Schema.Boolean }),
    { operation },
  );
const operationFixture = (options: Parameters<typeof createOperation>[0] = {}) =>
  Effect.acquireRelease(createOperation(options), (operation) => Effect.sync(operation.dispose));

const oversizedErrorFetch: typeof globalThis.fetch = async () =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(ERROR_BYTES)));
        controller.enqueue(new TextEncoder().encode("ž"));
        controller.close();
      },
    }),
    { status: 503 },
  );

// Real FetchHttpClient and streamed Web responses, with only the external fetch service substituted.
describe("native owner operation bounds", () => {
  it.effect(
    "interrupts native HttpClient body execution on the caller signal, and recovers",
    () => {
      const begun = Promise.withResolvers<null>();
      let slow = true;
      const fetch: typeof globalThis.fetch = async () =>
        slow
          ? new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{"ok":'));
                  begun.resolve(null);
                },
              }),
              { headers },
            )
          : Response.json({ ok: true }, { headers });
      return Effect.gen(function* cancelNativeBody() {
        const caller = new AbortController();
        const operation = yield* operationFixture({ signal: caller.signal });
        const pending = yield* Effect.forkChild(
          withOwnerOperation(read(), { operation }).pipe(Effect.flip),
        );
        yield* Effect.promise(() => begun.promise);
        caller.abort();
        expect(yield* Fiber.join(pending)).toMatchObject({ kind: "cancelled" });
        slow = false;
        expect(yield* read()).toEqual({ ok: true });
      }).pipe(
        Effect.scoped,
        Effect.provide(storefrontHttpClientLayer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      );
    },
  );

  it.effect("bounds chunked native error bodies before JSON retention", () =>
    Effect.gen(function* boundNativeError() {
      expect(yield* read().pipe(Effect.flip)).toMatchObject({ reason: "body_oversize" });
    }).pipe(
      Effect.provide(storefrontHttpClientLayer),
      Effect.provideService(FetchHttpClient.Fetch, oversizedErrorFetch),
    ),
  );

  it.effect(
    "admits 32 independent requests, refuses the next before dispatch, then releases on disposal",
    () => {
      const started = Promise.withResolvers<null>();
      let calls = 0;
      const fetch: typeof globalThis.fetch = async () => {
        calls += 1;
        if (calls === REQUEST_LIMIT) {
          started.resolve(null);
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"ok":'));
            },
          }),
          { headers },
        );
      };
      return Effect.gen(function* admissionLimit() {
        const operations = yield* Effect.forEach(
          Array.from({ length: REQUEST_LIMIT }),
          (_request) => operationFixture(),
        );
        const pending = yield* Effect.all(
          operations.map((operation) => Effect.forkChild(read(operation).pipe(Effect.flip))),
        );
        const extra = yield* operationFixture();
        yield* Effect.promise(() => started.promise);
        expect(yield* read(extra).pipe(Effect.flip)).toMatchObject({ reason: "overloaded" });
        expect(calls).toBe(REQUEST_LIMIT);
        for (const operation of operations) {
          operation.dispose();
        }
        for (const fiber of pending) {
          expect(yield* Fiber.join(fiber)).toMatchObject({ reason: "cancelled" });
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(storefrontHttpClientLayer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      );
    },
  );

  it.effect(
    "queues internal fanout even through nested holders instead of consuming request slots",
    () => {
      const full = Promise.withResolvers<null>();
      const release = Promise.withResolvers<null>();
      let calls = 0;
      let active = 0;
      let peak = 0;
      const fetch: typeof globalThis.fetch = async () => {
        calls += 1;
        active += 1;
        peak = Math.max(peak, active);
        if (active === OWNER_WORK_LIMIT) {
          full.resolve(null);
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              await release.promise;
              active -= 1;
              controller.enqueue(new TextEncoder().encode('{"ok":true}'));
              controller.close();
            },
          }),
          { headers },
        );
      };
      return Effect.gen(function* boundedFanout() {
        const operation = yield* operationFixture();
        const pending = yield* Effect.forkChild(
          withOwnerOperation(
            Effect.all(
              Array.from({ length: REQUEST_LIMIT + 1 }, () =>
                withOwnerOperation(read(), { signal: new AbortController().signal }),
              ),
              { concurrency: "unbounded" },
            ),
            { operation },
          ),
        );
        yield* Effect.promise(() => full.promise);
        expect(calls).toBe(OWNER_WORK_LIMIT);
        release.resolve(null);
        expect(yield* Fiber.join(pending)).toEqual(
          Array.from({ length: REQUEST_LIMIT + 1 }, () => ({ ok: true })),
        );
        expect(peak).toBe(OWNER_WORK_LIMIT);
      }).pipe(
        Effect.scoped,
        Effect.provide(storefrontHttpClientLayer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      );
    },
  );
});
