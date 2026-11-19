import { Effect, Cache, Result } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { describe, expect, it } from "effect-rstest";
import { makeCardVariantsCache } from "../src/ontos/card-variants-client";

const query = { locale: "cs", productId: "owner", slug: "owner" };
describe("card variant HTTP boundary", () => {
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
      const client = (yield* HttpClient.HttpClient.pipe(
        Effect.provide(FetchHttpClient.layer),
      )).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("https://n1.example")));
      const cache = yield* makeCardVariantsCache();
      const result = yield* Cache.get(cache, JSON.stringify(query)).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
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
      const client = (yield* HttpClient.HttpClient.pipe(
        Effect.provide(FetchHttpClient.layer),
      )).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("https://n1.example")));
      const cache = yield* makeCardVariantsCache();
      const failure = yield* Cache.get(cache, JSON.stringify(query)).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.result,
      );
      expect(Result.isFailure(failure)).toBe(true);
      expect(calls).toBe(1);
    }),
  );
});
