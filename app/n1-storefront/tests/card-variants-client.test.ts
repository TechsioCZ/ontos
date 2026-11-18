import { Effect, Cache, Layer, Result } from "effect";
import { rs } from "@rstest/core";
import { FetchHttpClient } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "effect-rstest";
import { makeCardVariantsCache } from "../src/ontos/card-variants-client";

const query = { locale: "cs", productId: "owner", slug: "owner" };
describe("card variant HTTP boundary", () => {
  beforeAll(() => {
    rs.stubGlobal("location", new URL("https://n1.example/cs"));
  });
  afterAll(() => {
    rs.unstubAllGlobals();
  });
  it.effect("sends the exact product selector and decodes the owner's variant labels", () =>
    Effect.gen(function* readVariantLabels() {
      const requests: Request[] = [];
      const fetch: typeof globalThis.fetch = (url, init) => {
        requests.push(new Request(url, init));
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
      const result = yield* Cache.get(cache, JSON.stringify(query)).pipe(
        Effect.provide(
          FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
        ),
      );
      expect(result).toEqual({
        productId: "owner",
        slug: "owner",
        state: "ready",
        variants: [{ id: "v", name: "M" }],
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe("GET");
      const url = new URL(requests[0]?.url ?? "");
      expect(url.pathname).toBe("/api/card-variants");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        locale: "cs",
        productId: "owner",
        slug: "owner",
      });
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
      expect(Result.isFailure(failure)).toBe(true);
      expect(calls).toBe(1);
    }),
  );
});
