import { Effect, Cache, Layer } from "effect";
import { rs } from "@rstest/core";
import { FetchHttpClient } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "effect-rstest";
import { makeCardVariantsCache } from "../src/ontos/card-variants-client";

const query = { locale: "cs", productId: "owner", slug: "owner" };
describe("bounded intent-only variant cache", () => {
  beforeAll(() => {
    rs.stubGlobal("location", new URL("https://n1.example/cs"));
  });
  afterAll(() => {
    rs.unstubAllGlobals();
  });
  it.effect("is idle until intent and coalesces concurrent reads of the same product", () =>
    Effect.gen(function* coalesceIntent() {
      let calls = 0;
      const fetch: typeof globalThis.fetch = () => {
        calls += 1;
        return Promise.resolve(
          Response.json({
            productId: "owner",
            slug: "owner",
            state: "ready",
            variants: [{ id: "v", name: "M" }],
          }),
        );
      };
      const cache = yield* makeCardVariantsCache();
      expect(calls).toBe(0);
      const load = Cache.get(cache, JSON.stringify(query));
      const program = Effect.all([load, load], { concurrency: 2 }).pipe(
        Effect.provide(
          FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
        ),
      );
      const results = yield* program;
      expect(calls).toBe(1);
      expect(results[0]).toEqual(results[1]);
      yield* program;
      expect(calls).toBe(1);
    }),
  );
  it.effect("rejects malformed owner responses instead of constructing labels", () =>
    Effect.gen(function* rejectMalformed() {
      let calls = 0;
      const fetch: typeof globalThis.fetch = () => {
        calls += 1;
        return Promise.resolve(Response.json({ variants: ["invented"] }));
      };
      const cache = yield* makeCardVariantsCache();
      const failure = yield* Cache.get(cache, JSON.stringify(query)).pipe(
        Effect.provide(
          FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
        ),
        Effect.result,
      );
      expect(failure._tag).toBe("Failure");
      expect(calls).toBe(1);
    }),
  );
});
