import type { GatewayContextResponse } from '@app/shared-contracts';
import type { ApiKeyGatewayContextClientOptions } from '@app/shared-contracts/server/gateway-context-api-key';
import { ConfigProvider, Effect, Layer, Redacted, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  makeCommercePriceGroupResolutionGatewayCredentialIssuer,
  makeCommercePriceGroupResolutionGatewayCredentialLayer,
  makePriceGroupCompatibilityGatewayCredentialIssuer,
  makePriceGroupCompatibilityGatewayCredentialLayer,
} from '../../api/price-group-owner-gateway-credential.ts';
import { CommercePriceGroupResolutionGatewayCredentialService } from '../../shared/domain/commerce-price-group-resolution-gateway-credential.ts';
import { PriceGroupCompatibilityGatewayCredentialService } from '../../shared/domain/price-group-compatibility-gateway-credential.ts';
import { PriceGroupOwnerGatewayUnavailable } from '../../shared/domain/price-group-owner-gateway-unavailable.ts';

const legalEntityId = '20000000-0000-4000-8000-000000000001';
const requestCorrelation = 'price-group-owner-credential-test';

it.layer(
  Layer.mergeAll(
    makeCommercePriceGroupResolutionGatewayCredentialLayer(),
    makePriceGroupCompatibilityGatewayCredentialLayer(),
  ).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}, { preserveEmptyStrings: true })))),
)('Price Group interpretation owner credentials with missing configuration', (testIt) => {
  testIt.effect('fails closed independently when either server-owned owner configuration is unavailable', () =>
    Effect.gen(function* missingOwnerConfiguration() {
      const commerceIssuer = yield* CommercePriceGroupResolutionGatewayCredentialService;
      const compatibilityIssuer = yield* PriceGroupCompatibilityGatewayCredentialService;

      const commerceFailure = yield* commerceIssuer
        .issue({ audience: 'commerce-customer-context', legalEntityId, requestCorrelation })
        .pipe(Effect.flip);
      const compatibilityFailure = yield* compatibilityIssuer
        .issue({ audience: 'price-group-catalog', requestCorrelation })
        .pipe(Effect.flip);

      expect(commerceFailure).toMatchObject({
        owner: 'COMMERCE_ASSIGNMENT',
        reason: 'Commerce Customer Context gateway configuration is unavailable',
      });
      expect(compatibilityFailure).toMatchObject({
        owner: 'PRICE_GROUP_COMPATIBILITY',
        reason: 'Price Group Catalog gateway configuration is unavailable',
      });
      expect(Schema.is(PriceGroupOwnerGatewayUnavailable)(commerceFailure)).toBe(true);
      expect(Schema.is(PriceGroupOwnerGatewayUnavailable)(compatibilityFailure)).toBe(true);
    }),
  );
});

describe('Price Group interpretation owner credentials', () => {
  it.effect('issues fresh exact-audience credentials without leaking Legal Entity scope to the catalog', () =>
    Effect.gen(function* exactOwnerCredentials() {
      const requests: unknown[] = [];
      const issue = (
        payload:
          | { readonly audience: 'commerce-customer-context'; readonly legalEntityId: string }
          | { readonly audience: 'price-group-catalog' },
        options: ApiKeyGatewayContextClientOptions,
      ): Effect.Effect<GatewayContextResponse> =>
        Effect.sync(() => {
          requests.push({ options, payload });
          return { expiresAt: 1_700_000_300, token: `owner-assertion-${requests.length}` };
        });
      const commerceIssuer = makeCommercePriceGroupResolutionGatewayCredentialIssuer(
        {
          apiKey: Redacted.make('dedicated-pricing-key'),
          commerceCustomerContextBaseUrl: new URL('https://commerce-customer.example.test'),
          shellBaseUrl: new URL('https://shell.example.test'),
        },
        issue,
      );
      const compatibilityIssuer = makePriceGroupCompatibilityGatewayCredentialIssuer(
        {
          apiKey: Redacted.make('dedicated-pricing-key'),
          priceGroupCatalogBaseUrl: new URL('https://price-groups.example.test'),
          shellBaseUrl: new URL('https://shell.example.test'),
        },
        issue,
      );

      const commerce = yield* commerceIssuer.issue({
        audience: 'commerce-customer-context',
        legalEntityId,
        requestCorrelation,
      });
      const commerceAgain = yield* commerceIssuer.issue({
        audience: 'commerce-customer-context',
        legalEntityId,
        requestCorrelation,
      });
      const compatibility = yield* compatibilityIssuer.issue({
        audience: 'price-group-catalog',
        requestCorrelation,
      });

      expect(requests).toEqual([
        {
          options: {
            apiKey: expect.anything(),
            baseUrl: new URL('https://shell.example.test'),
            requestCorrelation,
          },
          payload: { audience: 'commerce-customer-context', legalEntityId },
        },
        {
          options: {
            apiKey: expect.anything(),
            baseUrl: new URL('https://shell.example.test'),
            requestCorrelation,
          },
          payload: { audience: 'commerce-customer-context', legalEntityId },
        },
        {
          options: {
            apiKey: expect.anything(),
            baseUrl: new URL('https://shell.example.test'),
            requestCorrelation,
          },
          payload: { audience: 'price-group-catalog' },
        },
      ]);
      expect(commerce.baseUrl).toEqual(new URL('https://commerce-customer.example.test'));
      expect(commerceAgain.baseUrl).toEqual(new URL('https://commerce-customer.example.test'));
      expect(compatibility.baseUrl).toEqual(new URL('https://price-groups.example.test'));
      expect(Redacted.value(commerce.credential)).toBe('Bearer owner-assertion-1');
      expect(Redacted.value(commerceAgain.credential)).toBe('Bearer owner-assertion-2');
      expect(Redacted.value(compatibility.credential)).toBe('Bearer owner-assertion-3');
    }),
  );
});
