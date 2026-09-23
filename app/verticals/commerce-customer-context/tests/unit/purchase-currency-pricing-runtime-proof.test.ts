import { CurrentSupportedCurrenciesResponseSchema } from '@app/pricing-contracts';
import { Effect, Layer, Match, Redacted, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { PurchaseCurrencyPurchasingContextPort } from '../../shared/domain/purchase-currency-context-port.ts';
import { PurchaseCurrencyDependencyUnavailable } from '../../shared/domain/purchase-currency-dependency.ts';
import { PurchaseCurrencyPolicyPort } from '../../shared/domain/purchase-currency-policy-port.ts';
import { PurchaseCurrencyPricingGatewayCredentialService } from '../../shared/domain/purchase-currency-pricing-gateway-credential.ts';
import { PurchaseCurrencyPricingPort } from '../../shared/domain/purchase-currency-pricing-port.ts';
import type { PurchaseCurrencyPricingPortService } from '../../shared/domain/purchase-currency-pricing-port.ts';
import { ExplicitPurchaseCurrencyChoiceInvalid } from '../../shared/domain/purchase-currency-resolution.ts';
import {
  handlePurchaseCurrencyResolution,
  makePurchaseCurrencyResolutionServices,
} from '../../src/api/purchase-currency-resolution.read.ts';
import { purchaseCurrencyPricingPortFromEnvironment } from '../../src/integrations/purchase-currency-pricing.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const sellingLegalEntityId = '40000000-0000-4000-8000-000000000001';
const purchasingContext = {
  cartId: 'cart-czk-launch',
  channelId: 'web',
  marketId: 'cz',
  sellingLegalEntityId,
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
const request = {
  contextRevision: 'context:cz-launch:7',
  purchasingContext,
  requestedAt: '2026-09-22T10:00:00.000Z',
  subject,
};
const policy = {
  allowedCurrencies: ['CZK', 'EUR'] as const,
  completeness: {
    observedAt: '2026-09-22T10:00:00.000Z',
    ownerRevision: 'PURCHASE_CURRENCY:7',
    scope: {
      kind: 'EXACT_PREDICATE' as const,
      predicateRef: 'commerce.customer-context.policy.purchase_currency.current',
    },
  },
  defaultCurrency: 'CZK' as const,
  policyRevisionIds: ['10000000-0000-4000-8000-000000000007'] as const,
};
const credentialLayer = Layer.succeed(PurchaseCurrencyPricingGatewayCredentialService, {
  issue: () =>
    Effect.succeed({
      baseUrl: new URL('https://pricing.example.test'),
      credential: Redacted.make('Bearer pricing-owner-issued'),
    }),
});
const handlerScope = {
  authMethod: 'system' as const,
  correlationId: 'pricing-runtime-proof',
  legalEntityId: sellingLegalEntityId,
  principalId: '50000000-0000-4000-8000-000000000001',
  tenantId,
  trustedStorefrontId: purchasingContext.storefrontId,
};

const currentPricingResponse = (effectiveAt: string) =>
  Schema.decodeUnknownSync(CurrentSupportedCurrenciesResponseSchema)({
    completenessEvidence: {
      observedAt: effectiveAt,
      ownerRevision: 'pricing:cz-launch:11',
      scope: { kind: 'EXACT_PREDICATE', predicateRef: 'pricing:exact-current-context' },
    },
    effectiveAt,
    observedAt: effectiveAt,
    outcome: 'SUPPORTED_CURRENCIES_CURRENT',
    pricingRevision: 'pricing:cz-launch:11',
    supportedCurrencies: ['CZK'],
  });

const runtimeServices = (pricingPort: PurchaseCurrencyPricingPortService) =>
  makePurchaseCurrencyResolutionServices({
    scope: {
      legalEntityId: sellingLegalEntityId,
      storefrontId: purchasingContext.storefrontId,
      tenantId,
    },
  }).pipe(
    Effect.provideService(PurchaseCurrencyPurchasingContextPort, {
      resolveCurrent: () =>
        Effect.succeed({
          contextRevision: request.contextRevision,
          purchasingContext,
          subject,
        }),
    }),
    Effect.provideService(PurchaseCurrencyPolicyPort, {
      resolveCurrent: () => Effect.succeed(policy),
    }),
    Effect.provideService(PurchaseCurrencyPricingPort, pricingPort),
  );

describe('Purchase Currency Pricing runtime proof', () => {
  it.effect('resolves CZK from the exact Pricing context and emits only safe owner evidence', () =>
    Effect.gen(function* validCzk() {
      const pricingCalls: unknown[] = [];
      const pricingPort = yield* purchaseCurrencyPricingPortFromEnvironment(
        { legalEntityId: sellingLegalEntityId, requestCorrelation: handlerScope.correlationId },
        (payload, credential, correlation, options) => {
          pricingCalls.push({ correlation, credential: Redacted.value(credential), options, payload });
          return Effect.succeed(currentPricingResponse(payload.effectiveAt));
        },
      ).pipe(Effect.provide(credentialLayer));
      const services = yield* runtimeServices(pricingPort);
      const response = yield* handlePurchaseCurrencyResolution(request, {
        readKey: 'commerce.customer-context.api.purchase-currency-resolution',
        scope: handlerScope,
        services,
      });

      expect(pricingCalls).toEqual([
        {
          correlation: handlerScope.correlationId,
          credential: 'Bearer pricing-owner-issued',
          options: { baseUrl: new URL('https://pricing.example.test') },
          payload: {
            cartId: purchasingContext.cartId,
            channelId: purchasingContext.channelId,
            contextRevision: request.contextRevision,
            effectiveAt: response.result.evidence.requestedAt,
            marketId: purchasingContext.marketId,
            sellingLegalEntityId,
            storefrontId: purchasingContext.storefrontId,
            subject,
            tenantId,
          },
        },
      ]);
      expect(response).toEqual({
        evidence: { resultCount: 1 },
        result: {
          _tag: 'PURCHASE_CURRENCY_RESOLVED',
          currencyCode: 'CZK',
          evidence: {
            contextRevision: request.contextRevision,
            policyCompleteness: policy.completeness,
            policyRevisionIds: policy.policyRevisionIds,
            pricingRevision: 'pricing:cz-launch:11',
            requestedAt: response.result.evidence.requestedAt,
          },
          source: 'POLICY_DEFAULT',
        },
      });
      expect(JSON.stringify(response)).not.toContain('pricing-owner-issued');
      expect(JSON.stringify(response)).not.toContain('pricing:exact-current-context');
    }),
  );

  it.effect('rejects explicit EUR when Pricing supports only CZK without falling back to the CZK default', () =>
    Effect.gen(function* unsupportedExplicitCurrency() {
      const pricingPort = yield* purchaseCurrencyPricingPortFromEnvironment(
        { legalEntityId: sellingLegalEntityId, requestCorrelation: handlerScope.correlationId },
        (payload) => Effect.succeed(currentPricingResponse(payload.effectiveAt)),
      ).pipe(Effect.provide(credentialLayer));
      const services = yield* runtimeServices(pricingPort);
      const failure = yield* handlePurchaseCurrencyResolution(
        { ...request, explicitChoice: 'EUR' },
        {
          readKey: 'commerce.customer-context.api.purchase-currency-resolution',
          scope: handlerScope,
          services,
        },
      ).pipe(Effect.flip);

      expect(Schema.is(ExplicitPurchaseCurrencyChoiceInvalid)(failure)).toBe(true);
      expect(
        Match.value(failure).pipe(
          Match.tag('EXPLICIT_CHOICE_INVALID', ({ currencyCode, reason }) => ({ currencyCode, reason })),
          Match.orElse(() => null),
        ),
      ).toEqual({
        currencyCode: 'EUR',
        reason: 'PRICING_UNSUPPORTED',
      });
    }),
  );

  it.effect('fails closed for stale and unavailable Pricing evidence', () =>
    Effect.gen(function* nonCurrentPricingEvidence() {
      for (const outcome of ['SUPPORTED_CURRENCIES_STALE', 'SUPPORTED_CURRENCIES_UNAVAILABLE'] as const) {
        const pricingPort = yield* purchaseCurrencyPricingPortFromEnvironment(
          { legalEntityId: sellingLegalEntityId, requestCorrelation: handlerScope.correlationId },
          (payload) =>
            Effect.succeed(
              Schema.decodeUnknownSync(CurrentSupportedCurrenciesResponseSchema)(
                outcome === 'SUPPORTED_CURRENCIES_STALE'
                  ? {
                      code: 'pricing_currency_support_stale',
                      observedAt: payload.effectiveAt,
                      outcome,
                      pricingRevision: 'pricing:cz-launch:10',
                      reason: 'Pricing evidence crossed its applicability boundary',
                      retryable: true,
                    }
                  : {
                      code: 'pricing_currency_support_unavailable',
                      outcome,
                      reason: 'No exact Current Pricing support set exists',
                      retryable: true,
                    },
              ),
            ),
        ).pipe(Effect.provide(credentialLayer));
        const services = yield* runtimeServices(pricingPort);
        const failure = yield* handlePurchaseCurrencyResolution(request, {
          readKey: 'commerce.customer-context.api.purchase-currency-resolution',
          scope: handlerScope,
          services,
        }).pipe(Effect.flip);

        expect(Schema.is(PurchaseCurrencyDependencyUnavailable)(failure)).toBe(true);
        expect(failure).toMatchObject({ code: 'pricing_currency_support_unavailable', retryable: true });
      }
    }),
  );
});
