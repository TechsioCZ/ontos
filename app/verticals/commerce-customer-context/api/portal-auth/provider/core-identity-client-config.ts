import { Config, ConfigProvider, Context, Effect, Layer, Option, Redacted, Schema } from 'effect';
import type { ExternalIdentityClientOptions } from '@app/shared-contracts/server/external-identity-client';

import { CommerceCoreIdentityClientConfigError } from './core-identity-config-error.ts';

/**
 * The Core identity transport Commerce enrollment reaches for a Tenant-scoped Principal Auth
 * Binding. It is deliberately separate from `COMMERCE_PORTAL_AUTH_*`: the portal realm is the
 * provider (Better Auth) half of enrollment, whereas these two values name the provider-neutral
 * Core identity endpoint and the server-owned service credential presented to it. A deployment
 * rotates them independently.
 *
 * Both are optional in exactly the way the portal realm is optional: a deployment that names
 * neither never opted in, and every Core identity owner transition stays the fail-closed
 * unavailable port rather than reaching an unconfigured endpoint. Naming only one of them is a
 * misconfiguration, not an opt-out, and is reported as one.
 */

const CORE_IDENTITY_BASE_URL_KEY = 'COMMERCE_CORE_IDENTITY_BASE_URL';
const CORE_IDENTITY_API_KEY_KEY = 'COMMERCE_CORE_IDENTITY_API_KEY';

/**
 * The resolved transport. `apiKey` stays `Redacted` from the moment it is read: nothing in this
 * module, and nothing that consumes the value, ever renders it into a log, a span attribute or an
 * error body.
 */
export interface CommerceCoreIdentityClientConfigValue {
  readonly apiKey: Redacted.Redacted;
  readonly baseUrl: string;
}

export class CommerceCoreIdentityClientConfig extends Context.Service<
  CommerceCoreIdentityClientConfig,
  CommerceCoreIdentityClientConfigValue
>()(
  '@app/commerce-customer-context/api/portal-auth/provider/core-identity-client-config/CommerceCoreIdentityClientConfig',
) {}

const malformedConfiguration = (): CommerceCoreIdentityClientConfigError =>
  new CommerceCoreIdentityClientConfigError({
    reason: 'Commerce Core identity client configuration is missing or malformed',
  });

const HttpUrlSchema = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    url.protocol === 'http:' || url.protocol === 'https:' ? undefined : 'URL must use http or https',
  ),
);

/**
 * The base URL carries no credential material of its own: a URL with userinfo, a query or a
 * fragment is rejected rather than silently normalised, so the configured endpoint is exactly the
 * origin-and-path the operator named.
 */
const parseBaseUrl = (value: string): Effect.Effect<string, CommerceCoreIdentityClientConfigError> =>
  Schema.decodeEffect(HttpUrlSchema)(value.trim()).pipe(
    Effect.catchTag('SchemaError', () => Effect.fail(malformedConfiguration())),
    Effect.filterOrFail(
      (url) =>
        url.username.length === 0 && url.password.length === 0 && url.search.length === 0 && url.hash.length === 0,
      () => malformedConfiguration(),
    ),
    Effect.map((url) => url.href.replace(/\/+$/u, '')),
  );

const configSource = Config.all({
  apiKey: Config.redacted(CORE_IDENTITY_API_KEY_KEY),
  baseUrl: Config.string(CORE_IDENTITY_BASE_URL_KEY),
});

const parseFromProvider = Effect.fn('CommerceCoreIdentityClientConfig.parse')(function* parseCoreIdentityConfig(
  provider: ConfigProvider.ConfigProvider,
): Effect.fn.Return<CommerceCoreIdentityClientConfigValue, CommerceCoreIdentityClientConfigError> {
  const source = yield* configSource
    .parse(provider)
    .pipe(Effect.catchTag('ConfigError', () => Effect.fail(malformedConfiguration())));
  const apiKeyValue = Redacted.value(source.apiKey).trim();
  if (apiKeyValue.length < 16) {
    return yield* malformedConfiguration();
  }
  const baseUrl = yield* parseBaseUrl(source.baseUrl);
  return Object.freeze({ apiKey: Redacted.make(apiKeyValue), baseUrl });
});

const optionalKeys = Config.all({
  apiKey: Config.option(Config.redacted(CORE_IDENTITY_API_KEY_KEY)),
  baseUrl: Config.option(Config.redacted(CORE_IDENTITY_BASE_URL_KEY)),
});

const declaredValue = (configured: Option.Option<Redacted.Redacted>): boolean =>
  Option.isSome(configured) && Redacted.value(configured.value).trim().length > 0;

const parseOptionalFromProvider = Effect.fn('CommerceCoreIdentityClientConfig.parseOptional')(
  function* parseOptionalCoreIdentityConfig(
    provider: ConfigProvider.ConfigProvider,
  ): Effect.fn.Return<Option.Option<CommerceCoreIdentityClientConfigValue>, CommerceCoreIdentityClientConfigError> {
    const configured = yield* optionalKeys
      .parse(provider)
      .pipe(Effect.catchTag('ConfigError', () => Effect.fail(malformedConfiguration())));
    const declared = [configured.apiKey, configured.baseUrl].filter(declaredValue);
    if (declared.length === 0) {
      return Option.none();
    }
    return Option.some(yield* parseFromProvider(provider));
  },
);

/** The composition root's single availability read for the optional Core identity transport. */
export const optionalCommerceCoreIdentityClientConfig: Effect.Effect<
  Option.Option<CommerceCoreIdentityClientConfigValue>,
  CommerceCoreIdentityClientConfigError
> = parseOptionalFromProvider(ConfigProvider.fromEnv({ preserveEmptyStrings: true }));

export const CommerceCoreIdentityClientConfigLive = Layer.effect(
  CommerceCoreIdentityClientConfig,
  parseFromProvider(ConfigProvider.fromEnv({ preserveEmptyStrings: true })),
);

/**
 * Build the per-call transport options the `@app/shared-contracts` Core identity client expects.
 * The correlation is supplied by the caller for the exact owner transition it is dispatching, so
 * two transitions of the same Attempt never share one correlation and a replay is traceable to the
 * invocation that produced it.
 */
export const commerceCoreIdentityClientOptions = (
  configuration: CommerceCoreIdentityClientConfigValue,
  requestCorrelation: string,
): ExternalIdentityClientOptions => ({
  apiKey: configuration.apiKey,
  baseUrl: configuration.baseUrl,
  requestCorrelation,
});

export { CommerceCoreIdentityClientConfigError } from './core-identity-config-error.ts';
