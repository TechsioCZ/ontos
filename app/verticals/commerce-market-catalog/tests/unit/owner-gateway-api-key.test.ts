import { ConfigProvider, Effect, Redacted } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { ownerGatewayApiKey } from '../../src/integrations/owner-gateway-api-key.ts';

const akros = '71000000-0000-4000-8000-000000000024';
const kavarna = '71000000-0000-4000-8000-000000000023';

const keyFor = (legalEntityId: string | undefined, env: Readonly<Record<string, string>>) =>
  ownerGatewayApiKey(legalEntityId).parse(ConfigProvider.fromUnknown(env)).pipe(Effect.map(Redacted.value));

describe('owner gateway API key per company', () => {
  it.effect('uses the default key without company keys', () =>
    Effect.gen(function* defaultKey() {
      expect(yield* keyFor(akros, { ONTOS_COMMERCE_MARKET_CATALOG_GATEWAY_API_KEY: 'default-key' })).toBe(
        'default-key',
      );
    }),
  );

  it.effect("uses a company's own key and the default key for every other company", () =>
    Effect.gen(function* companyKey() {
      const env = {
        ONTOS_COMMERCE_MARKET_CATALOG_COMPANY_GATEWAY_API_KEYS: JSON.stringify({ [kavarna]: 'kavarna-key' }),
        ONTOS_COMMERCE_MARKET_CATALOG_GATEWAY_API_KEY: 'default-key',
      };
      expect(yield* keyFor(kavarna, env)).toBe('kavarna-key');
      expect(yield* keyFor(akros, env)).toBe('default-key');
      expect(yield* keyFor(undefined, env)).toBe('default-key');
    }),
  );

  it.effect('rejects malformed company keys without quoting them', () =>
    Effect.gen(function* malformedKeys() {
      const error = yield* keyFor(kavarna, {
        ONTOS_COMMERCE_MARKET_CATALOG_COMPANY_GATEWAY_API_KEYS: JSON.stringify({ [kavarna]: '' }),
        ONTOS_COMMERCE_MARKET_CATALOG_GATEWAY_API_KEY: 'default-key',
      }).pipe(Effect.flip);
      expect(error.message).toContain('COMPANY_GATEWAY_API_KEYS');
      expect(error.message).not.toContain(kavarna);
    }),
  );
});
