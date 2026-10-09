import { CurrentSupportedCurrenciesSuccessSchema } from '@app/pricing-contracts';
import { Effect, Layer, Redacted, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { PurchaseCurrencyPricingGatewayCredentialService } from '../../shared/domain/purchase-currency-pricing-gateway-credential.ts';
import { purchaseCurrencyPricingPortFromEnvironment } from '../../src/integrations/purchase-currency-pricing.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const effectiveAt = '2026-09-27T10:00:00.000Z';
const observedAt = '2026-09-27T10:00:01.000Z';
const supportRootId = '30000000-0000-4000-8000-000000000001';
const supportRevisionId = '31000000-0000-4000-8000-000000000007';
const verificationRef = `commerce.pricing.currency-support-proof:${supportRevisionId}`;
const supportRootRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: supportRootId,
  resourceType: 'commerce.pricing.currency-support' as const,
  tenantId,
};
const supportRevisionRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: supportRevisionId,
  resourceType: 'commerce.pricing.currency-support-revision' as const,
  supportRootId,
  tenantId,
};

const ownerResponse = Schema.decodeSync(CurrentSupportedCurrenciesSuccessSchema)({
  completenessEvidence: {
    observedAt,
    ownerRevision: supportRevisionId,
    scope: {
      kind: 'EXACT_PREDICATE',
      predicateRef: `commerce.pricing.current-supported-currencies:${tenantId}`,
    },
  },
  currentnessEvidence: {
    evaluatedAt: effectiveAt,
    evaluationMode: 'HISTORICAL_AS_OF',
    observedAt,
    scheduleRevision: 7,
    supportRevisionRef,
    supportRootRef,
  },
  effectiveAt,
  effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
  factProofs: [{ factRef: supportRootId, factRevisionRef: supportRevisionId, verificationRef }],
  generation: 7,
  observedAt,
  outcome: 'SUPPORTED_CURRENCIES_CURRENT',
  pricingRevision: 'pricing-currency-support:7',
  scheduleRevision: 7,
  supportedCurrencies: ['CZK'],
  supportRevisionRef,
  supportRootRef,
  tenantId,
  verificationRef,
});

const purchaseContexts = [
  {
    cartId: 'cart-retail',
    channelId: 'B2C',
    correlation: 'currency-support-retail',
    legalEntityId: '40000000-0000-4000-8000-000000000001',
    marketId: 'market-retail',
    storefrontId: 'storefront-retail',
    subject: 'guest-retail',
  },
  {
    cartId: 'cart-wholesale',
    channelId: 'B2B',
    correlation: 'currency-support-wholesale',
    legalEntityId: '50000000-0000-4000-8000-000000000001',
    marketId: 'market-wholesale',
    storefrontId: 'storefront-wholesale',
    subject: 'counterparty-wholesale',
  },
] as const;

describe('Tenant Currency Support purchase-context invariance', () => {
  it.effect('uses distinct gateway security contexts but one Tenant capability request and root', () => {
    const issued: unknown[] = [];
    const calls: unknown[] = [];
    const credentialLayer = Layer.succeed(PurchaseCurrencyPricingGatewayCredentialService, {
      issue: (request) => {
        issued.push(request);
        return Effect.succeed({
          baseUrl: new URL('https://shell.example.test/owner-api'),
          credential: Redacted.make(`Bearer ${request.legalEntityId}`),
        });
      },
    });

    return Effect.gen(function* contextInvariantSupport() {
      const results = [];
      for (const purchase of purchaseContexts) {
        const port = yield* purchaseCurrencyPricingPortFromEnvironment(
          {
            compositionRevision: 'a'.repeat(64),
            legalEntityId: purchase.legalEntityId,
            requestCorrelation: purchase.correlation,
          },
          (payload, credential, correlation) => {
            calls.push({ correlation, credential: Redacted.value(credential), payload });
            return Effect.succeed(ownerResponse);
          },
        );
        results.push(yield* port.resolveCurrent({ effectiveAt, tenantId }));
      }

      expect(issued).toEqual(
        purchaseContexts.map((purchase) => ({
          audience: 'pricing',
          compositionRevision: 'a'.repeat(64),
          legalEntityId: purchase.legalEntityId,
          requestCorrelation: purchase.correlation,
        })),
      );
      expect(calls).toEqual(
        purchaseContexts.map((purchase) => ({
          correlation: purchase.correlation,
          credential: `Bearer ${purchase.legalEntityId}`,
          payload: { effectiveAt, tenantId },
        })),
      );
      expect(results).toEqual([results[0], results[0]]);
      expect(results[0]).toMatchObject({
        completenessEvidence: {
          scope: {
            predicateRef: `commerce.pricing.current-supported-currencies:${tenantId}`,
          },
        },
        generation: 7,
        pricingRevision: 'pricing-currency-support:7',
        supportedCurrencies: ['CZK'],
        supportRootRef,
        tenantId,
      });

      for (const purchase of purchaseContexts) {
        for (const purchaseOnlyValue of [
          purchase.cartId,
          purchase.channelId,
          purchase.marketId,
          purchase.storefrontId,
          purchase.subject,
        ]) {
          expect(JSON.stringify(calls)).not.toContain(purchaseOnlyValue);
        }
      }
    }).pipe(Effect.provide(credentialLayer));
  });
});
