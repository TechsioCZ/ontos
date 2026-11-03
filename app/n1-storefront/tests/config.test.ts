import { Effect } from "effect";
import { describe, expect, it } from "effect-rstest";
import { readConfiguration } from "../src/ontos/config";

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
  for (const shellUrl of [
    "http://external.example",
    "https://user:secret@example.com",
    "https://example.com/other",
    "https://example.com/?secret=x",
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
  it.effect("binds N1 to the explicitly configured context", () =>
    Effect.gen(function* acceptsOwnContext() {
      const config = yield* readConfiguration(valid);
      expect(config.appId).toBe("n1-storefront");
      expect(config.legalEntityId).toBe(valid.ONTOS_STOREFRONT_LEGAL_ENTITY_ID);
    }),
  );
});
