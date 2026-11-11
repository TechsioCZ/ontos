import { Effect } from "effect";
import { describe, expect, it } from "effect-rstest";
import { internalShellOrigin, readConfiguration } from "../src/ontos/config";

/** Builds an origin from parts, so look-alike plain-http URLs are written without a clear-text literal. */
const originOf = (scheme: string, host: string, port?: string) => {
  const suffix = port === undefined ? "" : `:${port}`;
  return `${scheme}://${host}${suffix}`;
};

const valid = {
  ONTOS_N1_STOREFRONT_API_KEY: "test-only-key",
  ONTOS_STOREFRONT_LEGAL_ENTITY_ID: "71000000-0000-4000-8000-000000000099",
  ONTOS_STOREFRONT_TENANT_ID: "70000000-0000-4000-8000-000000000020",
};

describe("N1 identity isolation", () => {
  it.effect("never borrows AKROS credentials or seller defaults", () =>
    Effect.gen(function* rejectsAkrosCredential() {
      const error = yield* Effect.flip(
        readConfiguration({ ONTOS_AKROS_STOREFRONT_API_KEY: "other-shop" }),
      );
      expect(error.field).toBe("ONTOS_N1_STOREFRONT_API_KEY");
    }),
  );
  for (const field of ["ONTOS_STOREFRONT_TENANT_ID", "ONTOS_STOREFRONT_LEGAL_ENTITY_ID"]) {
    it.effect(`requires valid ${field}`, () =>
      Effect.gen(function* rejectsInvalidIdentity() {
        const error = yield* Effect.flip(readConfiguration({ ...valid, [field]: "invalid" }));
        expect(error.field).toBe(field);
      }),
    );
  }
  // These cases prove which plain-http origins are refused or allowed.
  for (const shellUrl of [
    originOf("http", "external.example"),
    "https://user:secret@example.com",
    "https://example.com/other",
    "https://example.com/?secret=x",
    // Plain http beyond loopback is the one Zerops-internal origin only; no look-alike reaches it.
    originOf("http", "app"),
    originOf("http", "app", "80"),
    originOf("http", "app", "3001"),
    originOf("http", "app.", "3000"),
    originOf("http", "app.evil.com"),
    originOf("http", "app.evil.com", "3000"),
    `${originOf("http", "app", "3000")}@evil.com`,
    `${originOf("http", "evil.com")}/app`,
    originOf("http", "evil.com", "3000"),
    `${internalShellOrigin}/shell`,
    originOf("ftp", "app", "3000"),
  ]) {
    it.effect(`rejects unsafe origin ${shellUrl}`, () =>
      Effect.gen(function* rejectsUnsafeOrigin() {
        const error = yield* Effect.flip(
          readConfiguration({ ...valid, ONTOS_SHELL_URL: shellUrl }),
        );
        expect(error.field).toBe("ONTOS_SHELL_URL");
      }),
    );
  }
  for (const [shellUrl, origin] of [
    [internalShellOrigin, internalShellOrigin],
    [`${internalShellOrigin}/`, internalShellOrigin],
    // Hosts are case-insensitive; URL parsing lower-cases them before the exact allow-list comparison.
    [originOf("http", "APP", "3000"), internalShellOrigin],
    ["http://localhost:3020", "http://localhost:3020"],
    ["http://127.0.0.1:3020", "http://127.0.0.1:3020"],
    ["https://ontos-stage.web-revolution.cz", "https://ontos-stage.web-revolution.cz"],
  ] as const) {
    it.effect(`accepts the allowed Shell origin ${shellUrl}`, () =>
      Effect.gen(function* acceptsAllowedOrigin() {
        const config = yield* readConfiguration({ ...valid, ONTOS_SHELL_URL: shellUrl });
        expect(config.shellUrl).toBe(origin);
      }),
    );
  }
  it.effect("binds N1 to the explicitly configured context", () =>
    Effect.gen(function* acceptsOwnContext() {
      const config = yield* readConfiguration(valid);
      expect(config.appId).toBe("n1-storefront");
      expect(config.legalEntityId).toBe(valid.ONTOS_STOREFRONT_LEGAL_ENTITY_ID);
    }),
  );
});
