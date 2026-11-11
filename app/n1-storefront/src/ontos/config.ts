import { Effect, Schema } from "effect";

class StorefrontConfigurationUnavailable extends Schema.TaggedError<StorefrontConfigurationUnavailable>()(
  "StorefrontConfigurationUnavailable",
  { field: Schema.String },
) {}

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);
/**
 * Plain-http Shell origins outside loopback: only the Zerops project-internal `app` service on its pinned port, the
 * address the AKROS and shop storefronts already use. Compared as a whole parsed origin, so a look-alike host, another
 * port or userinfo never matches. URL parsing lower-cases the host, so `http://APP:3000` is the same service.
 */
const PLAIN_HTTP_SCHEME = "http";
/** Parts of each allowed plain-http service: exact hostname and explicit port of the parsed URL, no patterns. */
const INTERNAL_HTTP_SERVICES = [{ hostname: "app", port: "3000" }] as const;
/** The one internal origin N1 reaches the Shell on, built from the parts above. */
export const internalShellOrigin = `${PLAIN_HTTP_SCHEME}://${INTERNAL_HTTP_SERVICES[0].hostname}:${INTERNAL_HTTP_SERVICES[0].port}`;
const isInternalHttpService = (url: URL): boolean =>
  INTERNAL_HTTP_SERVICES.some(
    (service) => url.hostname === service.hostname && url.port === service.port,
  );

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
    const plainHttpAllowed =
      LOOPBACK_HOSTNAMES.has(shellUrl.hostname) || isInternalHttpService(shellUrl);
    if (
      (shellUrl.protocol !== "https:" && !(shellUrl.protocol === "http:" && plainHttpAllowed)) ||
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
