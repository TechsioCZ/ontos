import { PaymentTermCatalogGatewayCredentialService } from '../../shared/domain/payment-term-catalog-gateway-credential.ts';
import {
  makePaymentTermCatalogGatewayCredentialIssuer,
  makePaymentTermCatalogGatewayCredentialLayer,
} from '../../api/payment-term-catalog-gateway-credential.ts';
import { ConfigProvider, Effect, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { PaymentTermsDependencyUnavailable } from '../../shared/domain/payment-term-errors.ts';

const legalEntityId = '20000000-0000-4000-8000-000000000001';
const requestCorrelation = 'catalog-credential-correlation';
const configuration = {
  apiKey: Redacted.make('dedicated-customer-context-key'),
  baseUrl: new URL('https://shell.example.test/shell-super-app-api'),
};

it.effect('fails closed when the server-owned issuance configuration is absent', () =>
  Effect.gen(function* missingConfigurationTest() {
    const issuer = yield* PaymentTermCatalogGatewayCredentialService;
    const failure = yield* issuer
      .issue({ audience: 'payment-term-catalog', legalEntityId, requestCorrelation })
      .pipe(Effect.flip);

    expect(Schema.is(PaymentTermsDependencyUnavailable)(failure)).toBe(true);
    expect(failure.reason).toContain('No server-owned Payment Term Catalog');
  }).pipe(
    Effect.provide(makePaymentTermCatalogGatewayCredentialLayer()),
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({}, { preserveEmptyStrings: true })),
    ),
  ),
);

it.effect('maps denied or mismatched Shell issuance to a sanitized typed dependency failure', () =>
  Effect.gen(function* deniedIssuanceTest() {
    const issuer = makePaymentTermCatalogGatewayCredentialIssuer(configuration, () =>
      Effect.fail({
        _tag: 'GatewayForbiddenProblem',
        detail: 'private provider diagnostic',
        status: 403,
        title: 'Forbidden',
        type: 'https://ontos.dev/problems/gateway-forbidden',
      }),
    );
    const failure = yield* issuer
      .issue({ audience: 'payment-term-catalog', legalEntityId, requestCorrelation })
      .pipe(Effect.flip);

    expect(Schema.is(PaymentTermsDependencyUnavailable)(failure)).toBe(true);
    expect(failure).toMatchObject({
      code: 'payment_terms_dependency_unavailable',
      dependency: 'PAYMENT_TERM_CATALOG',
      reason: 'The server-owned Payment Term Catalog credential could not be issued',
    });
    expect(JSON.stringify(failure)).not.toContain('private provider diagnostic');
  }),
);

it.effect('requests a fresh audience and Legal-Entity-bound assertion for every call', () =>
  Effect.gen(function* freshIssuanceTest() {
    const requests: {
      readonly options: {
        readonly apiKey: Redacted.Redacted;
        readonly baseUrl: string | URL;
        readonly requestCorrelation: string;
      };
      readonly payload: {
        readonly audience: 'payment-term-catalog';
        readonly legalEntityId: string;
      };
    }[] = [];
    const issuer = makePaymentTermCatalogGatewayCredentialIssuer(
      configuration,
      (payload, options) =>
        Effect.sync(() => {
          requests.push({ options, payload });
          return {
            expiresAt: 1_700_000_300 + requests.length,
            token: `fresh-assertion-${requests.length}`,
          };
        }),
    );

    const first = yield* issuer.issue({
      audience: 'payment-term-catalog',
      legalEntityId,
      requestCorrelation,
    });
    const second = yield* issuer.issue({
      audience: 'payment-term-catalog',
      legalEntityId,
      requestCorrelation,
    });

    expect(requests).toHaveLength(2);
    expect(requests.map(({ payload }) => payload)).toEqual([
      { audience: 'payment-term-catalog', legalEntityId },
      { audience: 'payment-term-catalog', legalEntityId },
    ]);
    expect(requests.map(({ options }) => options.requestCorrelation)).toEqual([
      requestCorrelation,
      requestCorrelation,
    ]);
    expect(requests.every(({ options }) => options.apiKey === configuration.apiKey)).toBe(true);
    expect(Redacted.value(first)).toBe('Bearer fresh-assertion-1');
    expect(Redacted.value(second)).toBe('Bearer fresh-assertion-2');
  }),
);
