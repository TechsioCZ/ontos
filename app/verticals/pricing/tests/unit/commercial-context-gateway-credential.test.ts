import { ConfigProvider, Effect, Layer, Redacted } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeCommercialContextGatewayCredentialIssuer,
  makeCommercialContextGatewayCredentialLayer,
} from '../../api/commercial-context-gateway-credential.ts';
import { CommercialContextGatewayCredentialService } from '../../shared/domain/commercial-context-gateway-credential.ts';

const compositionRevision = '1'.repeat(64);

const legalEntityId = '20000000-0000-4000-8000-000000000001';
const requestCorrelation = 'commercial-context-credential-test';

it.effect('keeps the admitted revision and rejects a credential minted for a later revision', () =>
  Effect.gen(function* rejectRevisionPromotion() {
    const admittedRevision = 'a'.repeat(64);
    const laterRevision = 'b'.repeat(64);
    const requests: unknown[] = [];
    const issuer = makeCommercialContextGatewayCredentialIssuer(
      {
        apiKey: Redacted.make('dedicated-pricing-key'),
        shellBaseUrl: new URL('https://shell.example.test'),
      },
      (payload) =>
        Effect.sync(() => {
          requests.push(payload);
          return {
            apiBaseUrl: '/api/commerce-market-catalog',
            compositionRevision: laterRevision,
            expiresAt: 1_700_000_300,
            token: 'later-release-assertion',
          };
        }),
    );
    const failure = yield* issuer
      .issue({
        audience: 'commerce-market-catalog',
        compositionRevision: admittedRevision,
        legalEntityId,
        requestCorrelation,
      })
      .pipe(Effect.flip);
    expect(requests).toEqual([
      { audience: 'commerce-market-catalog', compositionRevision: admittedRevision, legalEntityId },
    ]);
    expect(failure).toMatchObject({
      code: 'pricing_commercial_context_unavailable',
      reason: 'Commerce Market gateway returned a credential for a different composition revision',
    });
  }),
);

it.layer(
  makeCommercialContextGatewayCredentialLayer().pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}, { preserveEmptyStrings: true }))),
  ),
)('Commercial Context gateway with missing configuration', (testIt) => {
  testIt.effect('fails closed when server-owned Commerce Market Catalog configuration is unavailable', () =>
    Effect.gen(function* missingConfiguration() {
      const issuer = yield* CommercialContextGatewayCredentialService;
      const failure = yield* issuer
        .issue({ audience: 'commerce-market-catalog', compositionRevision, legalEntityId, requestCorrelation })
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
        shellBaseUrl: new URL('https://shell.example.test'),
      },
      (payload, options) =>
        Effect.sync(() => {
          requests.push({ options, payload });
          return {
            apiBaseUrl: '/api/testing',
            compositionRevision,
            expiresAt: 1_700_000_300,
            token: `market-assertion-${requests.length}`,
          };
        }),
    );

    const first = yield* issuer.issue({
      audience: 'commerce-market-catalog',
      compositionRevision,
      legalEntityId,
      requestCorrelation,
    });
    const second = yield* issuer.issue({
      audience: 'commerce-market-catalog',
      compositionRevision,
      legalEntityId,
      requestCorrelation,
    });

    expect(requests).toEqual([
      {
        options: {
          apiKey: expect.anything(),
          baseUrl: new URL('https://shell.example.test'),
          requestCorrelation,
        },
        payload: { audience: 'commerce-market-catalog', compositionRevision, legalEntityId },
      },
      {
        options: {
          apiKey: expect.anything(),
          baseUrl: new URL('https://shell.example.test'),
          requestCorrelation,
        },
        payload: { audience: 'commerce-market-catalog', compositionRevision, legalEntityId },
      },
    ]);
    expect(first.baseUrl).toEqual(new URL('https://shell.example.test/api/testing'));
    expect(second.baseUrl).toEqual(new URL('https://shell.example.test/api/testing'));
    expect(Redacted.value(first.credential)).toBe('Bearer market-assertion-1');
    expect(Redacted.value(second.credential)).toBe('Bearer market-assertion-2');
  }),
);
