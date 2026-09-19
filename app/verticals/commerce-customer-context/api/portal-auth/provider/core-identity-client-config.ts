import { Config, ConfigProvider, Context, Effect, Layer, Option, Redacted } from 'effect';
import type { ExternalIdentityClientOptions } from '@app/shared-contracts/server/external-identity-client';

import { optionalConfigReader, parseHttpUrl } from './config-support.ts';
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

const parseBaseUrl = (value: string): Effect.Effect<string, CommerceCoreIdentityClientConfigError> =>
  Effect.map(parseHttpUrl(value, malformedConfiguration), (url) => url.href.replace(/\/+$/u, ''));

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

const parseOptionalFromProvider = optionalConfigReader(
  'CommerceCoreIdentityClientConfig.parseOptional',
  [CORE_IDENTITY_API_KEY_KEY, CORE_IDENTITY_BASE_URL_KEY],
  parseFromProvider,
  malformedConfiguration,
);

/** The availability read that keeps a misconfiguration an error, for a consumer that may refuse. */
export const optionalCommerceCoreIdentityClientConfig: Effect.Effect<
  Option.Option<CommerceCoreIdentityClientConfigValue>,
  CommerceCoreIdentityClientConfigError
> = parseOptionalFromProvider(ConfigProvider.fromEnv({ preserveEmptyStrings: true }));

/**
 * The one fail-closed availability read every consumer that must keep serving shares. Naming only
 * one `COMMERCE_CORE_IDENTITY_*` value is a misconfiguration, not an opt-out, and
 * `optionalCommerceCoreIdentityClientConfig` reports it as one — but a consumer inside the runtime
 * every governed business route is served from must not be taken down by an unreadable transport,
 * so the error folds to "not configured" with one warning and the fail-closed leaf answers.
 */
export const coreIdentityTransportConfigured: Effect.Effect<boolean> = optionalCommerceCoreIdentityClientConfig.pipe(
  Effect.map(Option.isSome),
  Effect.catchTag('CommerceCoreIdentityClientConfigError', (failure) =>
    Effect.annotateLogs(
      Effect.logWarning('Commerce Core identity transport is unreadable; enrollment owner evidence fails closed'),
      { reason: failure.reason },
    ).pipe(Effect.as(false)),
  ),
);

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
