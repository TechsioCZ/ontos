import { ConfigProvider, Effect, Layer, Redacted } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeCommercialContextGatewayCredentialIssuer,
  makeCommercialContextGatewayCredentialLayer,
} from '../../api/commercial-context-gateway-credential.ts';
import { CommercialContextGatewayCredentialService } from '../../shared/domain/commercial-context-gateway-credential.ts';

const legalEntityId = '20000000-0000-4000-8000-000000000001';
const requestCorrelation = 'commercial-context-credential-test';

it.layer(
  makeCommercialContextGatewayCredentialLayer().pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}, { preserveEmptyStrings: true }))),
  ),
)('Commercial Context gateway with missing configuration', (testIt) => {
  testIt.effect('fails closed when server-owned Commerce Market Catalog configuration is unavailable', () =>
    Effect.gen(function* missingConfiguration() {
      const issuer = yield* CommercialContextGatewayCredentialService;
      const failure = yield* issuer
        .issue({ audience: 'commerce-market-catalog', legalEntityId, requestCorrelation })
        .pipe(Effect.flip);

      expect(failure).toMatchObject({
        code: 'pricing_commercial_context_unavailable',
        reason: 'Commerce Market Catalog gateway configuration is unavailable',
        retryable: true,
      });
    }),
  );
});

it.effect('issues a fresh exact-audience credential and keeps the owner base URL server-owned', () =>
  Effect.gen(function* freshCredential() {
    const requests: unknown[] = [];
    const issuer = makeCommercialContextGatewayCredentialIssuer(
      {
        apiKey: Redacted.make('dedicated-pricing-key'),
        commerceMarketCatalogBaseUrl: new URL('https://commerce-market-catalog.example.test'),
        shellBaseUrl: new URL('https://shell.example.test'),
      },
      (payload, options) =>
        Effect.sync(() => {
          requests.push({ options, payload });
          return { expiresAt: 1_700_000_300, token: `market-assertion-${requests.length}` };
        }),
    );

    const first = yield* issuer.issue({ audience: 'commerce-market-catalog', legalEntityId, requestCorrelation });
    const second = yield* issuer.issue({ audience: 'commerce-market-catalog', legalEntityId, requestCorrelation });

    expect(requests).toEqual([
      {
        options: {
          apiKey: expect.anything(),
          baseUrl: new URL('https://shell.example.test'),
          requestCorrelation,
        },
        payload: { audience: 'commerce-market-catalog', legalEntityId },
      },
      {
        options: {
          apiKey: expect.anything(),
          baseUrl: new URL('https://shell.example.test'),
          requestCorrelation,
        },
        payload: { audience: 'commerce-market-catalog', legalEntityId },
      },
    ]);
    expect(first.baseUrl).toEqual(new URL('https://commerce-market-catalog.example.test'));
    expect(second.baseUrl).toEqual(new URL('https://commerce-market-catalog.example.test'));
    expect(Redacted.value(first.credential)).toBe('Bearer market-assertion-1');
    expect(Redacted.value(second.credential)).toBe('Bearer market-assertion-2');
  }),
);
