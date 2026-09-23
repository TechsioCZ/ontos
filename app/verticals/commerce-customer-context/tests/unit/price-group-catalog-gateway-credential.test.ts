import { PriceGroupCatalogGatewayCredentialService } from '../../shared/domain/price-group-catalog-gateway-credential.ts';
import {
  makePriceGroupCatalogGatewayCredentialIssuer,
  makePriceGroupCatalogGatewayCredentialLayer,
} from '../../api/price-group-catalog-gateway-credential.ts';
import { ConfigProvider, Effect, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { expect, it } from 'effect-rstest';

import { CustomerPriceGroupCatalogUnavailable } from '../../shared/domain/price-group-errors.ts';

const requestCorrelation = 'price-group-catalog-credential-correlation';
const configuration = {
  apiKey: Redacted.make('dedicated-customer-context-key'),
  baseUrl: new URL('https://shell.example.test/shell-super-app-api'),
};

it.effect('fails closed when the server-owned issuance configuration is absent', () =>
  Effect.gen(function* missingConfigurationTest() {
    const issuer = yield* PriceGroupCatalogGatewayCredentialService;
    const failure = yield* issuer.issue({ audience: 'price-group-catalog', requestCorrelation }).pipe(Effect.flip);

    expect(Schema.is(CustomerPriceGroupCatalogUnavailable)(failure)).toBe(true);
    expect(failure.reason).toContain('No server-owned Price Group Catalog');
  }).pipe(
    Effect.provide(makePriceGroupCatalogGatewayCredentialLayer()),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}, { preserveEmptyStrings: true }))),
  ),
);

it.effect('maps denied or mismatched Shell issuance to a sanitized typed dependency failure', () =>
  Effect.gen(function* deniedIssuanceTest() {
    const issuer = makePriceGroupCatalogGatewayCredentialIssuer(configuration, () =>
      Effect.fail({
        _tag: 'GatewayForbiddenProblem',
        detail: 'private provider diagnostic',
        status: 403,
        title: 'Forbidden',
        type: 'https://ontos.dev/problems/gateway-forbidden',
      }),
    );
    const failure = yield* issuer.issue({ audience: 'price-group-catalog', requestCorrelation }).pipe(Effect.flip);

    expect(Schema.is(CustomerPriceGroupCatalogUnavailable)(failure)).toBe(true);
    expect(failure).toMatchObject({
      code: 'customer_price_group_catalog_unavailable',
      reason: 'The server-owned Price Group Catalog credential could not be issued',
    });
    expect(JSON.stringify(failure)).not.toContain('private provider diagnostic');
  }),
);

it.effect('requests a fresh tenant-only assertion without a Legal Entity for every call', () =>
  Effect.gen(function* freshIssuanceTest() {
    const requests: {
      readonly options: {
        readonly apiKey: Redacted.Redacted;
        readonly baseUrl: string | URL;
        readonly requestCorrelation: string;
      };
      readonly payload: {
        readonly audience: 'price-group-catalog';
      };
    }[] = [];
    const issuer = makePriceGroupCatalogGatewayCredentialIssuer(configuration, (payload, options) =>
      Effect.sync(() => {
        requests.push({ options, payload });
        return {
          expiresAt: 1_700_000_300 + requests.length,
          token: `fresh-assertion-${requests.length}`,
        };
      }),
    );

    const first = yield* issuer.issue({
      audience: 'price-group-catalog',
      requestCorrelation,
    });
    const second = yield* issuer.issue({
      audience: 'price-group-catalog',
      requestCorrelation,
    });

    expect(requests).toHaveLength(2);
    expect(requests.map(({ payload }) => payload)).toEqual([
      { audience: 'price-group-catalog' },
      { audience: 'price-group-catalog' },
    ]);
    expect(requests.every(({ payload }) => !('legalEntityId' in payload))).toBe(true);
    expect(requests.map(({ options }) => options.requestCorrelation)).toEqual([requestCorrelation, requestCorrelation]);
    expect(requests.every(({ options }) => options.apiKey === configuration.apiKey)).toBe(true);
    expect(Redacted.value(first)).toBe('Bearer fresh-assertion-1');
    expect(Redacted.value(second)).toBe('Bearer fresh-assertion-2');
  }),
);

it.effect('sends the tenant-only assertion request through the server API-key client boundary', () =>
  Effect.gen(function* serverClientBoundaryTest() {
    const requests: Request[] = [];
    const fakeFetch: typeof fetch = (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Promise.resolve(Response.json({ expiresAt: 1_700_000_300, token: 'tenant-only-assertion' }));
    };
    const issuer = makePriceGroupCatalogGatewayCredentialIssuer(configuration);

    const credential = yield* issuer
      .issue({ audience: 'price-group-catalog', requestCorrelation })
      .pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));

    expect(requests).toHaveLength(1);
    const [request] = requests;
    if (request === undefined) {
      yield* Effect.die(new Error('Expected the Shell gateway request to be captured'));
    }
    expect(request.url).toBe('https://shell.example.test/shell-super-app-api/auth/api-key/gateway-context');
    expect(request.headers.get('x-api-key')).toBe('dedicated-customer-context-key');
    expect(request.headers.get('x-correlation-id')).toBe(requestCorrelation);
    expect(request.headers.get('cookie')).toBeNull();
    expect(request.headers.get('authorization')).toBeNull();
    const payload: unknown = yield* Effect.promise(() => request.json());
    expect(payload).toEqual({ audience: 'price-group-catalog' });
    expect(JSON.stringify(payload)).not.toContain('legalEntityId');
    expect(Redacted.value(credential)).toBe('Bearer tenant-only-assertion');
  }),
);
