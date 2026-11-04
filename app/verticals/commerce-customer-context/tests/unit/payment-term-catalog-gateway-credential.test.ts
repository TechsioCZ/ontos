import { PaymentTermCatalogGatewayCredentialService } from '../../shared/domain/payment-term-catalog-gateway-credential.ts';
import {
  makePaymentTermCatalogGatewayCredentialIssuer,
  makePaymentTermCatalogGatewayCredentialLayer,
} from '../../api/payment-term-catalog-gateway-credential.ts';
import {
  CommerceTenantWorkloadCredentialUnavailable,
  makeCommerceTenantWorkloadCredentials,
} from '../../api/tenant-workload-credentials.ts';
import { ConfigProvider, Effect, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { PaymentTermsDependencyUnavailable } from '../../shared/domain/payment-term-errors.ts';

const legalEntityId = '20000000-0000-4000-8000-000000000001';
const requestCorrelation = 'catalog-credential-correlation';
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
    const issuer = yield* PaymentTermCatalogGatewayCredentialService;
    const failure = yield* issuer
      .issue({
        audience: 'payment-term-catalog',
        compositionRevision: 'a'.repeat(64),
        legalEntityId,
        requestCorrelation,
        tenantId,
      })
      .pipe(Effect.flip);

    expect(Schema.is(PaymentTermsDependencyUnavailable)(failure)).toBe(true);
    expect(failure.reason).toContain('No server-owned Payment Term Catalog');
  }).pipe(
    Effect.provide(makePaymentTermCatalogGatewayCredentialLayer()),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}, { preserveEmptyStrings: true }))),
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
      .issue({
        audience: 'payment-term-catalog',
        compositionRevision: 'a'.repeat(64),
        legalEntityId,
        requestCorrelation,
        tenantId,
      })
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
    const issuer = makePaymentTermCatalogGatewayCredentialIssuer(configuration, (payload, options) =>
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
      audience: 'payment-term-catalog',
      compositionRevision: 'a'.repeat(64),
      legalEntityId,
      requestCorrelation,
      tenantId,
    });
    const second = yield* issuer.issue({
      audience: 'payment-term-catalog',
      compositionRevision: 'a'.repeat(64),
      legalEntityId,
      requestCorrelation,
      tenantId,
    });

    expect(requests).toHaveLength(2);
    expect(requests.map(({ payload }) => payload)).toEqual([
      { audience: 'payment-term-catalog', compositionRevision: 'a'.repeat(64), legalEntityId },
      { audience: 'payment-term-catalog', compositionRevision: 'a'.repeat(64), legalEntityId },
    ]);
    expect(requests.map(({ options }) => options.requestCorrelation)).toEqual([requestCorrelation, requestCorrelation]);
    expect(requests.every(({ options }) => options.apiKey === gatewayApiKey)).toBe(true);
    expect(first.baseUrl.href).toBe('https://shell.example.test/owner-api');
    expect(second.baseUrl.href).toBe('https://shell.example.test/owner-api');
    expect(Redacted.value(first.credential)).toBe('Bearer fresh-assertion-1');
    expect(Redacted.value(second.credential)).toBe('Bearer fresh-assertion-2');
  }),
);

it.effect('rejects issuance from a different composition before returning the selected owner connection', () =>
  Effect.gen(function* mismatchedComposition() {
    const issuer = makePaymentTermCatalogGatewayCredentialIssuer(configuration, () =>
      Effect.succeed({
        apiBaseUrl: '/owner-api',
        compositionRevision: 'b'.repeat(64),
        expiresAt: 1_700_000_300,
        token: 'must-not-be-used',
      }),
    );
    const failure = yield* issuer
      .issue({
        audience: 'payment-term-catalog',
        compositionRevision: 'a'.repeat(64),
        legalEntityId,
        requestCorrelation,
        tenantId,
      })
      .pipe(Effect.flip);
    expect(Schema.is(PaymentTermsDependencyUnavailable)(failure)).toBe(true);
  }),
);

it.effect("fails closed for an unconfigured tenant without presenting another tenant's key", () =>
  Effect.gen(function* unconfiguredTenantTest() {
    const presentedKeys: Redacted.Redacted[] = [];
    const issuer = makePaymentTermCatalogGatewayCredentialIssuer(configuration, (payload, options) =>
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
        audience: 'payment-term-catalog',
        compositionRevision: 'a'.repeat(64),
        legalEntityId,
        requestCorrelation,
        tenantId: otherTenantId,
      })
      .pipe(Effect.flip);

    expect(Schema.is(PaymentTermsDependencyUnavailable)(failure)).toBe(true);
    expect(failure.cause).toBeInstanceOf(CommerceTenantWorkloadCredentialUnavailable);
    expect(presentedKeys).toEqual([]);
  }),
);
