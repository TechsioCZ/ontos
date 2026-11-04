import { ConfigProvider, Effect, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makePurchaseCurrencyPricingGatewayCredentialIssuer,
  makePurchaseCurrencyPricingGatewayCredentialLayer,
} from '../../api/purchase-currency-pricing-gateway-credential.ts';
import {
  CommerceTenantWorkloadCredentialUnavailable,
  makeCommerceTenantWorkloadCredentials,
} from '../../api/tenant-workload-credentials.ts';
import { PurchaseCurrencyDependencyUnavailable } from '../../shared/domain/purchase-currency-dependency.ts';
import { PurchaseCurrencyPricingGatewayCredentialService } from '../../shared/domain/purchase-currency-pricing-gateway-credential.ts';

const legalEntityId = '40000000-0000-4000-8000-000000000001';
const requestCorrelation = 'pricing-credential-test';
const tenantId = '10000000-0000-4000-8000-000000000001';
const otherTenantId = '10000000-0000-4000-8000-000000000002';
const gatewayApiKey = Redacted.make('dedicated-customer-context-key');
const credentials = makeCommerceTenantWorkloadCredentials({
  [tenantId]: { coreIdentityApiKey: Redacted.make('tenant-core-identity-key'), gatewayApiKey },
});

it.effect('fails closed when server-owned Pricing gateway configuration is absent', () =>
  Effect.gen(function* missingConfiguration() {
    const issuer = yield* PurchaseCurrencyPricingGatewayCredentialService;
    const failure = yield* issuer
      .issue({ audience: 'pricing', compositionRevision: 'a'.repeat(64), legalEntityId, requestCorrelation, tenantId })
      .pipe(Effect.flip);

    expect(Schema.is(PurchaseCurrencyDependencyUnavailable)(failure)).toBe(true);
    expect(failure).toMatchObject({ code: 'pricing_currency_support_unavailable', retryable: true });
  }).pipe(
    Effect.provide(makePurchaseCurrencyPricingGatewayCredentialLayer()),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}, { preserveEmptyStrings: true }))),
  ),
);

it.effect('issues a fresh Pricing-audience credential and keeps the owner base URL server-owned', () =>
  Effect.gen(function* freshCredential() {
    const requests: unknown[] = [];
    const issuer = makePurchaseCurrencyPricingGatewayCredentialIssuer(
      {
        credentials,
        shellBaseUrl: new URL('https://shell.example.test'),
      },
      (payload, options) =>
        Effect.sync(() => {
          requests.push({ options, payload });
          return {
            apiBaseUrl: '/owner-api',
            compositionRevision: 'a'.repeat(64),
            expiresAt: 1_700_000_300,
            token: 'fresh-pricing-assertion',
          };
        }),
    );
    const connection = yield* issuer.issue({
      audience: 'pricing',
      compositionRevision: 'a'.repeat(64),
      legalEntityId,
      requestCorrelation,
      tenantId,
    });

    expect(requests).toEqual([
      {
        options: {
          apiKey: gatewayApiKey,
          baseUrl: new URL('https://shell.example.test'),
          requestCorrelation,
        },
        payload: { audience: 'pricing', compositionRevision: 'a'.repeat(64), legalEntityId },
      },
    ]);
    expect(connection.baseUrl).toEqual(new URL('https://shell.example.test/owner-api'));
    expect(Redacted.value(connection.credential)).toBe('Bearer fresh-pricing-assertion');
  }),
);

it.effect('rejects an issued credential for a different composition revision', () =>
  Effect.gen(function* mismatchedCompositionRevision() {
    const issuer = makePurchaseCurrencyPricingGatewayCredentialIssuer(
      {
        credentials,
        shellBaseUrl: new URL('https://shell.example.test'),
      },
      () =>
        Effect.succeed({
          apiBaseUrl: '/owner-api',
          compositionRevision: 'b'.repeat(64),
          expiresAt: 1_700_000_300,
          token: 'wrong-release-assertion',
        }),
    );
    const failure = yield* issuer
      .issue({
        audience: 'pricing',
        compositionRevision: 'a'.repeat(64),
        legalEntityId,
        requestCorrelation,
        tenantId,
      })
      .pipe(Effect.flip);
    expect(Schema.is(PurchaseCurrencyDependencyUnavailable)(failure)).toBe(true);
    expect(failure.reason).toContain('captured composition revision');
  }),
);

it.effect("fails closed for an unconfigured tenant without presenting another tenant's key", () =>
  Effect.gen(function* unconfiguredTenant() {
    const presentedKeys: Redacted.Redacted[] = [];
    const issuer = makePurchaseCurrencyPricingGatewayCredentialIssuer(
      { credentials, shellBaseUrl: new URL('https://shell.example.test') },
      (payload, options) =>
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
        audience: 'pricing',
        compositionRevision: 'a'.repeat(64),
        legalEntityId,
        requestCorrelation,
        tenantId: otherTenantId,
      })
      .pipe(Effect.flip);

    expect(Schema.is(PurchaseCurrencyDependencyUnavailable)(failure)).toBe(true);
    expect(failure.cause).toBeInstanceOf(CommerceTenantWorkloadCredentialUnavailable);
    expect(presentedKeys).toEqual([]);
  }),
);
