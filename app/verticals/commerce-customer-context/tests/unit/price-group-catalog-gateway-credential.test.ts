import { PriceGroupCatalogGatewayCredentialService } from '../../shared/domain/price-group-catalog-gateway-credential.ts';
import {
  makePriceGroupCatalogGatewayCredentialIssuer,
  makePriceGroupCatalogGatewayCredentialLayer,
} from '../../api/price-group-catalog-gateway-credential.ts';
import {
  CommerceTenantWorkloadCredentialUnavailable,
  makeCommerceTenantWorkloadCredentials,
} from '../../api/tenant-workload-credentials.ts';
import { ConfigProvider, Effect, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { CustomerPriceGroupCatalogUnavailable } from '../../shared/domain/price-group-errors.ts';

const requestCorrelation = 'price-group-catalog-credential-correlation';
const tenantId = '10000000-0000-4000-8000-000000000001';
const otherTenantId = '10000000-0000-4000-8000-000000000002';
const gatewayApiKey = Redacted.make('dedicated-customer-context-key');
const configuration = {
  baseUrl: new URL('https://shell.example.test/shell-super-app-api'),
  credentials: makeCommerceTenantWorkloadCredentials({
    [tenantId]: { coreIdentityApiKey: Redacted.make('tenant-core-identity-key'), gatewayApiKey },
  }),
};

it.effect('fails closed when the server-owned issuance configuration is absent', () =>
  Effect.gen(function* missingConfigurationTest() {
    const issuer = yield* PriceGroupCatalogGatewayCredentialService;
    const failure = yield* issuer
      .issue({ audience: 'price-group-catalog', compositionRevision: 'a'.repeat(64), requestCorrelation, tenantId })
      .pipe(Effect.flip);

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
    const failure = yield* issuer
      .issue({ audience: 'price-group-catalog', compositionRevision: 'a'.repeat(64), requestCorrelation, tenantId })
      .pipe(Effect.flip);

    expect(Schema.is(CustomerPriceGroupCatalogUnavailable)(failure)).toBe(true);
    expect(failure).toMatchObject({
      code: 'customer_price_group_catalog_unavailable',
      reason: 'The server-owned Price Group Catalog credential could not be issued',
    });
    expect(JSON.stringify(failure)).not.toContain('private provider diagnostic');
  }),
);

it.effect('forwards each captured composition revision unchanged in a fresh tenant-only assertion', () =>
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
          apiBaseUrl: '/owner-api',
          compositionRevision: payload.compositionRevision,
          expiresAt: 1_700_000_300 + requests.length,
          token: `fresh-assertion-${requests.length}`,
        };
      }),
    );

    const first = yield* issuer.issue({
      audience: 'price-group-catalog',
      compositionRevision: 'a'.repeat(64),
      requestCorrelation,
      tenantId,
    });
    const second = yield* issuer.issue({
      audience: 'price-group-catalog',
      compositionRevision: 'b'.repeat(64),
      requestCorrelation,
      tenantId,
    });

    expect(requests).toHaveLength(2);
    expect(requests.map(({ payload }) => payload)).toEqual([
      { audience: 'price-group-catalog', compositionRevision: 'a'.repeat(64) },
      { audience: 'price-group-catalog', compositionRevision: 'b'.repeat(64) },
    ]);
    expect(requests.every(({ payload }) => !('legalEntityId' in payload))).toBe(true);
    expect(requests.map(({ options }) => options.requestCorrelation)).toEqual([requestCorrelation, requestCorrelation]);
    expect(requests.every(({ options }) => options.apiKey === gatewayApiKey)).toBe(true);
    expect(first.baseUrl.href).toBe('https://shell.example.test/owner-api');
    expect(second.baseUrl.href).toBe('https://shell.example.test/owner-api');
    expect(Redacted.value(first.credential)).toBe('Bearer fresh-assertion-1');
    expect(Redacted.value(second.credential)).toBe('Bearer fresh-assertion-2');
  }),
);

it.effect('sends the tenant-only assertion request through the server API-key client boundary', () =>
  Effect.gen(function* serverClientBoundaryTest() {
    const requests: Request[] = [];
    const fakeFetch: typeof fetch = (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Promise.resolve(
        Response.json({
          apiBaseUrl: '/owner-api',
          compositionRevision: 'a'.repeat(64),
          expiresAt: 1_700_000_300,
          token: 'tenant-only-assertion',
        }),
      );
    };
    const issuer = makePriceGroupCatalogGatewayCredentialIssuer(configuration);

    const credential = yield* issuer
      .issue({ audience: 'price-group-catalog', compositionRevision: 'a'.repeat(64), requestCorrelation, tenantId })
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
    expect(payload).toEqual({ audience: 'price-group-catalog', compositionRevision: 'a'.repeat(64) });
    expect(JSON.stringify(payload)).not.toContain('legalEntityId');
    expect(credential.baseUrl.href).toBe('https://shell.example.test/owner-api');
    expect(Redacted.value(credential.credential)).toBe('Bearer tenant-only-assertion');
  }),
);

it.effect('rejects issuance from a different composition before returning the selected owner connection', () =>
  Effect.gen(function* mismatchedComposition() {
    const issuer = makePriceGroupCatalogGatewayCredentialIssuer(configuration, () =>
      Effect.succeed({
        apiBaseUrl: '/owner-api',
        compositionRevision: 'b'.repeat(64),
        expiresAt: 1_700_000_300,
        token: 'must-not-be-used',
      }),
    );
    const failure = yield* issuer
      .issue({ audience: 'price-group-catalog', compositionRevision: 'a'.repeat(64), requestCorrelation, tenantId })
      .pipe(Effect.flip);
    expect(Schema.is(CustomerPriceGroupCatalogUnavailable)(failure)).toBe(true);
  }),
);

it.effect("fails closed for an unconfigured tenant without presenting another tenant's key", () =>
  Effect.gen(function* unconfiguredTenantTest() {
    const presentedKeys: Redacted.Redacted[] = [];
    const issuer = makePriceGroupCatalogGatewayCredentialIssuer(configuration, (payload, options) =>
      Effect.sync(() => {
        presentedKeys.push(options.apiKey);
        return {
          apiBaseUrl: '/owner-api',
          compositionRevision: payload.compositionRevision,
          expiresAt: 1_700_000_300,
          token: 'must-not-be-issued',
        };
      }),
    );
    const failure = yield* issuer
      .issue({
        audience: 'price-group-catalog',
        compositionRevision: 'a'.repeat(64),
        requestCorrelation,
        tenantId: otherTenantId,
      })
      .pipe(Effect.flip);

    expect(Schema.is(CustomerPriceGroupCatalogUnavailable)(failure)).toBe(true);
    expect(failure.cause).toBeInstanceOf(CommerceTenantWorkloadCredentialUnavailable);
    expect(presentedKeys).toEqual([]);
  }),
);
