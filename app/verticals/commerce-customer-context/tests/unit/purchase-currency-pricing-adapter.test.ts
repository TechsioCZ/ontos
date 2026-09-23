import { CurrentSupportedCurrenciesResponseSchema } from '@app/pricing-contracts';
import { Effect, Layer, Redacted, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { PurchaseCurrencyDependencyUnavailable } from '../../shared/domain/purchase-currency-dependency.ts';
import { PurchaseCurrencyPricingGatewayCredentialService } from '../../shared/domain/purchase-currency-pricing-gateway-credential.ts';
import { purchaseCurrencyPricingPortFromEnvironment } from '../../src/integrations/purchase-currency-pricing.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const observedAt = '2026-09-22T10:00:00.000Z';
const purchasingContext = {
  cartId: 'cart-1',
  channelId: 'web',
  marketId: 'cz',
  sellingLegalEntityId: '40000000-0000-4000-8000-000000000001',
  storefrontId: 'akros-cz',
  tenantId,
};
const subject = {
  authorizationSubject: { kind: 'RETAIL' as const },
  kind: 'PROFILE' as const,
  profileRef: {
    moduleId: 'commerce.customer-context' as const,
    resourceId: '10000000-0000-4000-8000-000000000001',
    resourceType: 'commerce.customer-context.retail-customer-profile' as const,
    tenantId,
  },
};
const credentialLayer = Layer.succeed(PurchaseCurrencyPricingGatewayCredentialService, {
  issue: () =>
    Effect.succeed({
      baseUrl: new URL('https://pricing.example.test'),
      credential: Redacted.make('Bearer pricing-owner-issued'),
    }),
});
const currentResponse = Schema.decodeSync(CurrentSupportedCurrenciesResponseSchema)({
  completenessEvidence: {
    observedAt,
    ownerRevision: 'pricing:73',
    scope: { kind: 'EXACT_PREDICATE', predicateRef: 'pricing:exact-context' },
  },
  effectiveAt: observedAt,
  observedAt,
  outcome: 'SUPPORTED_CURRENCIES_CURRENT',
  pricingRevision: 'pricing:73',
  supportedCurrencies: ['CZK', 'EUR'],
});

describe('Purchase Currency Pricing production adapter', () => {
  it.effect('passes the exact subject and purchasing context and maps owner revision and currency support', () =>
    Effect.gen(function* exactOwnerRequest() {
      const calls: unknown[] = [];
      const port = yield* purchaseCurrencyPricingPortFromEnvironment(
        { legalEntityId: purchasingContext.sellingLegalEntityId, requestCorrelation: 'pricing-test' },
        (payload, credential, correlation, options) => {
          calls.push({ correlation, credential: Redacted.value(credential), options, payload });
          return Effect.succeed(currentResponse);
        },
      );
      const result = yield* port.resolveCurrent({
        context: { contextRevision: 'context:42', purchasingContext },
        observedAt,
        subject,
      });

      expect(calls).toEqual([
        {
          correlation: 'pricing-test',
          credential: 'Bearer pricing-owner-issued',
          options: { baseUrl: new URL('https://pricing.example.test') },
          payload: {
            cartId: purchasingContext.cartId,
            channelId: purchasingContext.channelId,
            contextRevision: 'context:42',
            effectiveAt: observedAt,
            marketId: purchasingContext.marketId,
            sellingLegalEntityId: purchasingContext.sellingLegalEntityId,
            storefrontId: purchasingContext.storefrontId,
            subject,
            tenantId,
          },
        },
      ]);
      expect(result).toEqual({ pricingRevision: 'pricing:73', supportedCurrencies: ['CZK', 'EUR'] });
    }).pipe(Effect.provide(credentialLayer)),
  );

  it.effect('maps every non-current owner outcome to the typed Pricing dependency failure', () =>
    Effect.gen(function* typedOwnerFailures() {
      for (const outcome of [
        'SUPPORTED_CURRENCIES_INVALID',
        'SUPPORTED_CURRENCIES_STALE',
        'SUPPORTED_CURRENCIES_UNAVAILABLE',
        'SUPPORTED_CURRENCIES_UNVERIFIABLE',
      ] as const) {
        const response = Schema.decodeUnknownSync(CurrentSupportedCurrenciesResponseSchema)(
          outcome === 'SUPPORTED_CURRENCIES_STALE'
            ? {
                code: 'pricing-stale',
                observedAt,
                outcome,
                pricingRevision: 'pricing:72',
                reason: `${outcome} owner result`,
                retryable: true,
              }
            : {
                code: 'pricing-not-current',
                outcome,
                reason: `${outcome} owner result`,
                retryable: outcome === 'SUPPORTED_CURRENCIES_UNAVAILABLE',
              },
        );
        const port = yield* purchaseCurrencyPricingPortFromEnvironment(
          { legalEntityId: purchasingContext.sellingLegalEntityId, requestCorrelation: 'pricing-test' },
          () => Effect.succeed(response),
        );
        const failure = yield* port
          .resolveCurrent({
            context: { contextRevision: 'context:42', purchasingContext },
            observedAt,
            subject,
          })
          .pipe(Effect.flip);
        expect(Schema.is(PurchaseCurrencyDependencyUnavailable)(failure)).toBe(true);
        expect(failure).toMatchObject({ code: 'pricing_currency_support_unavailable', retryable: true });
      }
    }).pipe(Effect.provide(credentialLayer)),
  );
});
