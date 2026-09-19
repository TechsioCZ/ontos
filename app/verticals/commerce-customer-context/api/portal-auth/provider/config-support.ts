import { Config, Effect, Option, Redacted, Schema } from 'effect';
import type { ConfigProvider } from 'effect';

export const HttpUrlSchema = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    url.protocol === 'http:' || url.protocol === 'https:' ? undefined : 'URL must use http or https',
  ),
);

/**
 * An operator-supplied endpoint carries no credential material of its own: a URL with userinfo, a
 * query or a fragment is rejected rather than silently normalised, so the configured endpoint is
 * exactly the origin-and-path the operator named.
 */
export const parseHttpUrl = <ConfigurationError>(
  value: string,
  malformed: () => ConfigurationError,
): Effect.Effect<URL, ConfigurationError> =>
  Schema.decodeEffect(HttpUrlSchema)(value.trim()).pipe(
    Effect.catchTag('SchemaError', () => Effect.fail(malformed())),
    Effect.filterOrFail(
      (url) =>
        url.username.length === 0 && url.password.length === 0 && url.search.length === 0 && url.hash.length === 0,
      () => malformed(),
    ),
  );

const declaredValue = (configured: Option.Option<Redacted.Redacted>): boolean =>
  Option.isSome(configured) && Redacted.value(configured.value).trim().length > 0;

/**
 * Reads an optional block of deployment configuration under one policy: a deployment that names
 * none of `keys` never opted in and answers `Option.none()`, while one that names some of them is a
 * misconfiguration — `parse` runs and reports it — not a partial opt-out that silently serves half
 * a realm. Keys are read as redacted options so an unread value never reaches a log.
 */
export const optionalConfigReader = <Value, ConfigurationError>(
  span: string,
  keys: readonly string[],
  parse: (provider: ConfigProvider.ConfigProvider) => Effect.Effect<Value, ConfigurationError>,
  malformed: () => ConfigurationError,
) => {
  const declaredKeys = Config.all(keys.map((key) => Config.option(Config.redacted(key))));
  return Effect.fn(span)(function* readOptionalConfig(
    provider: ConfigProvider.ConfigProvider,
  ): Effect.fn.Return<Option.Option<Value>, ConfigurationError> {
    const configured = yield* declaredKeys
      .parse(provider)
      .pipe(Effect.catchTag('ConfigError', () => Effect.fail(malformed())));
    return configured.some(declaredValue) ? Option.some(yield* parse(provider)) : Option.none();
  });
};
