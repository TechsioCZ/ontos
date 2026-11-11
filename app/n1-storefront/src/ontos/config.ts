import { Effect, Schema } from "effect";

class StorefrontConfigurationUnavailable extends Schema.TaggedError<StorefrontConfigurationUnavailable>()(
  "StorefrontConfigurationUnavailable",
  { field: Schema.String },
) {}

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);
/**
 * Plain-http Shell services outside loopback: only the Zerops project-internal `app` service on its pinned port, the
 * address the AKROS and shop storefronts already use. A parsed URL matches only when its protocol is plain http and
 * its hostname and port equal one entry exactly, so a look-alike host, another port or a missing (default) port never
 * matches. URL parsing lower-cases the host, so `http://APP:3000` is the same service.
 */
const INTERNAL_HTTP_SERVICES = [{ hostname: "app", port: "3000" }] as const;
const PLAIN_HTTP_PROTOCOL = "http:";
const [INTERNAL_SHELL_SERVICE] = INTERNAL_HTTP_SERVICES;
/** The internal origin N1 reaches the Shell on, built from the allowed parts rather than written as a URL literal. */
export const internalShellOrigin = `${PLAIN_HTTP_PROTOCOL}//${INTERNAL_SHELL_SERVICE.hostname}:${INTERNAL_SHELL_SERVICE.port}`;
const isInternalHttpService = (url: URL): boolean =>
  url.protocol === PLAIN_HTTP_PROTOCOL &&
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
