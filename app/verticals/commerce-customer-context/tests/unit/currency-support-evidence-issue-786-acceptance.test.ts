import { CurrentSupportedCurrenciesSuccessSchema } from '@app/pricing-contracts';
import { Effect, Layer, Redacted, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { PurchaseCurrencyPricingGatewayCredentialService } from '../../shared/domain/purchase-currency-pricing-gateway-credential.ts';
import { purchaseCurrencyPricingPortFromEnvironment } from '../../src/integrations/purchase-currency-pricing.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const supportRootId = '30000000-0000-4000-8000-000000000001';
const supportRevisionId = '31000000-0000-4000-8000-000000000009';
const effectiveAt = '2026-09-28T10:00:00.000Z';
const evaluatedAt = '2026-09-28T10:00:00.400Z';
const observedAt = '2026-09-28T10:00:00.700Z';
const nextApplicabilityBoundary = '2026-09-28T11:00:00.000Z';
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
    nextApplicabilityBoundary,
    observedAt,
    ownerRevision: supportRevisionId,
    scope: {
      kind: 'EXACT_PREDICATE',
      predicateRef: `commerce.pricing.current-supported-currencies:${tenantId}`,
    },
  },
  currentnessEvidence: {
    evaluatedAt,
    evaluationMode: 'CURRENT_WITH_REVALIDATION',
    observedAt,
    revalidatedAt: observedAt,
    scheduleRevision: 9,
    supportRevisionRef,
    supportRootRef,
  },
  effectiveAt,
  effectivePeriod: {
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    effectiveTo: '2026-10-01T00:00:00.000Z',
  },
  factProofs: [{ factRef: supportRootId, factRevisionRef: supportRevisionId, verificationRef }],
  generation: 9,
  nextApplicabilityBoundary,
  observedAt,
  outcome: 'SUPPORTED_CURRENCIES_CURRENT',
  pricingRevision: 'pricing-currency-support:9',
  scheduleRevision: 9,
  supportedCurrencies: ['CZK'],
  supportRevisionRef,
  supportRootRef,
  tenantId,
  verificationRef,
});

const credentialLayer = Layer.succeed(PurchaseCurrencyPricingGatewayCredentialService, {
  issue: () =>
    Effect.succeed({
      baseUrl: new URL('https://pricing.example.test'),
      credential: Redacted.make('Bearer pricing-owner-issued'),
    }),
});

describe('issue #786 Tenant Currency Support evidence propagation', () => {
  it.effect('preserves requested, evaluated, and observed time plus owner proof through Commerce', () =>
    Effect.gen(function* losslessCurrencyProof() {
      const ownerCalls: unknown[] = [];
      const port = yield* purchaseCurrencyPricingPortFromEnvironment(
        {
          legalEntityId: '40000000-0000-4000-8000-000000000001',
          requestCorrelation: 'issue-786-currency-proof',
        },
        (payload) => {
          ownerCalls.push(payload);
          return Effect.succeed(ownerResponse);
        },
      );

      const result = yield* port.resolveCurrent({ effectiveAt, tenantId });
      const { outcome: _outcome, ...expectedEvidence } = ownerResponse;

      expect(ownerCalls).toEqual([{ effectiveAt, tenantId }]);
      expect(result).toEqual(expectedEvidence);
      expect(result).toMatchObject({
        completenessEvidence: {
          nextApplicabilityBoundary,
          observedAt,
          ownerRevision: supportRevisionId,
        },
        currentnessEvidence: {
          evaluatedAt,
          evaluationMode: 'CURRENT_WITH_REVALIDATION',
          observedAt,
          revalidatedAt: observedAt,
          supportRevisionRef,
          supportRootRef,
        },
        effectiveAt,
        observedAt,
        supportedCurrencies: ['CZK'],
        supportRevisionRef,
        supportRootRef,
        tenantId,
      });
      expect(effectiveAt).not.toBe(evaluatedAt);
      expect(evaluatedAt).not.toBe(observedAt);
      expect(JSON.stringify(result)).not.toContain('EUR');
      expect(JSON.stringify(result).toLowerCase()).not.toContain('fx');
    }).pipe(Effect.provide(credentialLayer)),
  );

  it('rejects timestamp rewriting and a future owner observation presented as earlier proof', () => {
    expect(() =>
      Schema.decodeUnknownSync(CurrentSupportedCurrenciesSuccessSchema)({
        ...ownerResponse,
        currentnessEvidence: {
          ...ownerResponse.currentnessEvidence,
          evaluatedAt: '2026-09-28T10:00:01.000Z',
        },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CurrentSupportedCurrenciesSuccessSchema)({
        ...ownerResponse,
        currentnessEvidence: {
          ...ownerResponse.currentnessEvidence,
          observedAt: effectiveAt,
          revalidatedAt: effectiveAt,
        },
      }),
    ).toThrow();
  });
});
