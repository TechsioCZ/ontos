import { Config, ConfigProvider, Effect, Option, Redacted, Schema } from 'effect';

/**
 * Market Catalog reaches other owners through a Shell API key, and every API key is bound to one company.
 * `ONTOS_COMMERCE_MARKET_CATALOG_COMPANY_GATEWAY_API_KEYS` holds a JSON object `{ "<legal entity id>": "<key>" }`
 * for companies with their own key; every other company uses `ONTOS_COMMERCE_MARKET_CATALOG_GATEWAY_API_KEY`.
 */
const CompanyKeysSchema = Schema.fromJsonString(Schema.Record(Schema.String, Schema.NonEmptyString));

const invalidCompanyKeys = new Config.ConfigError(
  new ConfigProvider.SourceError({
    message: 'ONTOS_COMMERCE_MARKET_CATALOG_COMPANY_GATEWAY_API_KEYS must be a JSON object of non-empty keys',
  }),
);

const companyKeys = Config.Redacted('ONTOS_COMMERCE_MARKET_CATALOG_COMPANY_GATEWAY_API_KEYS').pipe(
  Config.option,
  Config.mapEffect((configured) =>
    Option.match(configured, {
      onNone: () => Effect.succeed<Readonly<Record<string, string>>>({}),
      // The decoder's own message would quote the secret value, so only a fixed reason is reported.
      onSome: (json) =>
        Option.match(Schema.decodeUnknownOption(CompanyKeysSchema)(Redacted.value(json)), {
          onNone: () => Effect.fail(invalidCompanyKeys),
          onSome: (keys) => Effect.succeed<Readonly<Record<string, string>>>(keys),
        }),
    }),
  ),
);

/** The gateway API key bound to the company `legalEntityId`, or the default key. */
export const ownerGatewayApiKey = (legalEntityId: string | undefined): Config.Config<Redacted.Redacted> =>
  Config.all({ companyKeys, defaultKey: Config.Redacted('ONTOS_COMMERCE_MARKET_CATALOG_GATEWAY_API_KEY') }).pipe(
    Config.map(({ companyKeys: keys, defaultKey }) => {
      const companyKey = legalEntityId === undefined ? undefined : keys[legalEntityId];
      return companyKey === undefined ? defaultKey : Redacted.make(companyKey);
    }),
  );
