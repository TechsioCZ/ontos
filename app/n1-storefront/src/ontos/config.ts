import { Effect, Schema } from "effect";

export class StorefrontConfigurationUnavailable extends Schema.TaggedError<StorefrontConfigurationUnavailable>()(
  "StorefrontConfigurationUnavailable",
  { field: Schema.String },
) {}

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

/** N1 has no implicit AKROS identity, credential, seller or market. */
export const readConfiguration = (env: Readonly<Record<string, string | undefined>>) =>
  Effect.gen(function* readConfigurationProgram() {
    const apiKey = env.ONTOS_N1_STOREFRONT_API_KEY?.trim();
    const legalEntityId = env.ONTOS_STOREFRONT_LEGAL_ENTITY_ID?.trim();
    const tenantId = env.ONTOS_STOREFRONT_TENANT_ID?.trim();
    if (apiKey === undefined || apiKey.length === 0) {
      return yield* new StorefrontConfigurationUnavailable({
        field: "ONTOS_N1_STOREFRONT_API_KEY",
      });
    }
    if (legalEntityId === undefined || !uuid.test(legalEntityId)) {
      return yield* new StorefrontConfigurationUnavailable({
        field: "ONTOS_STOREFRONT_LEGAL_ENTITY_ID",
      });
    }
    if (tenantId === undefined || !uuid.test(tenantId)) {
      return yield* new StorefrontConfigurationUnavailable({ field: "ONTOS_STOREFRONT_TENANT_ID" });
    }
    const shellUrl = yield* Effect.try({
      catch: () => new StorefrontConfigurationUnavailable({ field: "ONTOS_SHELL_URL" }),
      try: () => new URL(env.ONTOS_SHELL_URL ?? "http://localhost:3020"),
    });
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(shellUrl.hostname);
    if (
      (shellUrl.protocol !== "https:" && !(shellUrl.protocol === "http:" && loopback)) ||
      shellUrl.username ||
      shellUrl.password ||
      shellUrl.search ||
      shellUrl.hash ||
      shellUrl.pathname !== "/"
    ) {
      return yield* new StorefrontConfigurationUnavailable({ field: "ONTOS_SHELL_URL" });
    }
    return { apiKey, appId: "n1-storefront", legalEntityId, shellUrl: shellUrl.origin, tenantId };
  });

export type StorefrontConfiguration = Effect.Success<ReturnType<typeof readConfiguration>>;
