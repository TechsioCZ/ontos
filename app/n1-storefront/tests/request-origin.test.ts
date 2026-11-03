import { Effect, Schema } from "effect";
import { describe, expect, it } from "effect-rstest";
import { normalizePublicRequest, RequestOriginInvalid } from "../src/ontos/request-origin";

describe("public request authority normalization", () => {
  it.effect("preserves a streaming POST body while replacing only authority", () =>
    Effect.gen(function* nativeStreamingBody() {
      const original = new Request("http://localhost:3071/api/account/login", {
        body: JSON.stringify({ email: "invalid" }),
        headers: { host: "127.0.0.1:3071" },
        method: "POST",
      });
      const normalized = yield* normalizePublicRequest(original);
      expect(normalized.url).toBe("http://127.0.0.1:3071/api/account/login");
      expect(normalized.method).toBe("POST");
      const body = yield* Effect.promise(async () => await normalized.text());
      expect(body).toBe(JSON.stringify({ email: "invalid" }));
    }),
  );
  it.effect("preserves HTTPS, IPv6 authority, port, path and query", () =>
    Effect.gen(function* ipv6PublicAuthority() {
      const normalized = yield* normalizePublicRequest(
        new Request("https://localhost:3071/api/account?customerId=x", {
          headers: { host: "[::1]:4443" },
        }),
      );
      expect(normalized.url).toBe("https://[::1]:4443/api/account?customerId=x");
    }),
  );
  for (const authority of [
    undefined,
    "user@example.com",
    "example.com/path",
    "example.com?x=y",
    "example.com#hash",
    "example.com,attacker.example",
    "example.com:70000",
    String.raw`example.com\path`,
  ]) {
    it.effect(`rejects invalid public authority ${authority ?? "missing"}`, () =>
      Effect.gen(function* invalidAuthority() {
        const headers = new Headers();
        if (authority !== undefined) {
          headers.set("host", authority);
        }
        const failure = yield* Effect.flip(
          normalizePublicRequest(new Request("https://localhost/api/account", { headers })),
        );
        expect(Schema.is(RequestOriginInvalid)(failure)).toBe(true);
      }),
    );
  }
});
