import { Config, Effect, Option, Redacted, Schema } from 'effect';

/**
 * The deployment configuration the Portal Auth communication relay needs once a worker host enabled it (#1406 D1). The relay is
 * enabled by the realm's own configuration plus the relay credential (`request-relay.ts#portalAuthCommunicationRelayAdopted`);
 * from then on all four values are required and an incomplete set fails closed: the relay does not start, nothing is relayed and
 * the typed error names the missing keys, never a value. A deployment that does not enable the relay (no Portal Auth realm, no
 * Communications) reads none of them.
 *
 * - `COMMERCE_PORTAL_AUTH_COMMUNICATION_RELAY_API_KEY`: the one managed API key the operator binds to one principal of the
 *   realm's trusted Tenant for the `commerce.customer-context.portal-auth-communication-relay` workload. One key per Tenant: the
 *   relay presents it only for requests of that Tenant (`relay-transport.ts`);
 * - `ONTOS_SHELL_GATEWAY_BASE_URL`: the Shell gateway that turns the key into a fresh audience-scoped assertion;
 * - `ONTOS_COMMERCE_CUSTOMER_CONTEXT_API_BASE_URL`: this module's own API, whose relay Action queues the request;
 * - `ONTOS_COMMUNICATIONS_API_BASE_URL`: the Communications API the module's source worker submits the request to.
 */
export const PORTAL_AUTH_COMMUNICATION_RELAY_VARIABLES = {
  apiKey: 'COMMERCE_PORTAL_AUTH_COMMUNICATION_RELAY_API_KEY',
  communicationsBaseUrl: 'ONTOS_COMMUNICATIONS_API_BASE_URL',
  ownerBaseUrl: 'ONTOS_COMMERCE_CUSTOMER_CONTEXT_API_BASE_URL',
  shellBaseUrl: 'ONTOS_SHELL_GATEWAY_BASE_URL',
} as const;

/** An HTTP(S) origin of a governed gateway or owner API: no credentials, query or fragment. */
export const GatewayHttpUrlSchema = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.search.length === 0 &&
    url.hash.length === 0
      ? undefined
      : 'Gateway URL must be HTTP(S) without credentials, query, or fragment',
  ),
);

/** Expected failure: the relay is enabled but its configuration is incomplete. It names the keys only, never a value. */
export class PortalAuthCommunicationRelayConfigurationError extends Schema.TaggedError<PortalAuthCommunicationRelayConfigurationError>()(
  'PortalAuthCommunicationRelayConfigurationError',
  { keys: Schema.Array(Schema.String) },
) {}

export interface PortalAuthCommunicationRelayConfiguration {
  readonly apiKey: Redacted.Redacted;
  readonly communicationsBaseUrl: URL;
  readonly ownerBaseUrl: URL;
  readonly shellBaseUrl: URL;
}

/** The relay credential, unless it is unset or blank: a blank value names no credential. */
export const relayCredential: Effect.Effect<Option.Option<Redacted.Redacted>> = Config.Redacted(
  PORTAL_AUTH_COMMUNICATION_RELAY_VARIABLES.apiKey,
).pipe(Effect.option, Effect.map(Option.filter((apiKey) => Redacted.value(apiKey).trim().length > 0)));

const gatewayUrl = (key: string) => Config.schema(GatewayHttpUrlSchema, key).pipe(Effect.option);

/** All four values, or the names of every key that is unset, blank or malformed. */
export const portalAuthCommunicationRelayConfiguration: Effect.Effect<
  PortalAuthCommunicationRelayConfiguration,
  PortalAuthCommunicationRelayConfigurationError
> = Effect.gen(function* readPortalAuthCommunicationRelayConfiguration() {
  const keys = PORTAL_AUTH_COMMUNICATION_RELAY_VARIABLES;
  const [apiKey, communicationsBaseUrl, ownerBaseUrl, shellBaseUrl] = yield* Effect.all(
    [
      relayCredential,
      gatewayUrl(keys.communicationsBaseUrl),
      gatewayUrl(keys.ownerBaseUrl),
      gatewayUrl(keys.shellBaseUrl),
    ],
    { concurrency: 1 },
  );
  if (
    Option.isSome(apiKey) &&
    Option.isSome(communicationsBaseUrl) &&
    Option.isSome(ownerBaseUrl) &&
    Option.isSome(shellBaseUrl)
  ) {
    return {
      apiKey: apiKey.value,
      communicationsBaseUrl: communicationsBaseUrl.value,
      ownerBaseUrl: ownerBaseUrl.value,
      shellBaseUrl: shellBaseUrl.value,
    };
  }
  const read = [
    [keys.apiKey, Option.isSome(apiKey)],
    [keys.communicationsBaseUrl, Option.isSome(communicationsBaseUrl)],
    [keys.ownerBaseUrl, Option.isSome(ownerBaseUrl)],
    [keys.shellBaseUrl, Option.isSome(shellBaseUrl)],
  ] as const;
  return yield* new PortalAuthCommunicationRelayConfigurationError({
    keys: read.filter(([, present]) => !present).map(([key]) => key),
  });
});
