import {
  PricingExplicitInputContextSchema,
  PricingExplicitInputIndeterminateSchema,
} from '@app/pricing-contracts/domain/broken-explicit-input';
import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { makeBrokenExplicitInputObservationPort } from '../../src/integrations/broken-explicit-input-observation.ts';
import { makeBrokenExplicitInputValidationService } from '../../src/services/broken-explicit-input.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const effectiveAt = '2026-09-27T12:00:00.000Z';
const supportRootId = '33333333-3333-4333-8333-333333333333';
const supportRevisionId = '44444444-4444-4444-8444-444444444444';

const context = Schema.decodeSync(PricingExplicitInputContextSchema)({
  effectiveAt,
  requestedCurrencyCode: 'CZK',
  tenantId,
});
const trusted = {
  legalEntityId,
  tenantId,
  trustedOperationAt: DateTime.makeUnsafe(effectiveAt),
} as const;
const supportRootRef = {
  moduleId: 'commerce.pricing',
  resourceId: supportRootId,
  resourceType: 'commerce.pricing.currency-support',
  tenantId,
} as const;
const supportRevisionRef = {
  moduleId: 'commerce.pricing',
  resourceId: supportRevisionId,
  resourceType: 'commerce.pricing.currency-support-revision',
  supportRootId,
  tenantId,
} as const;
const verificationRef = 'commerce.pricing.currency-support-proof:765-observation';
const stored = {
  currentnessEvidence: {
    evaluatedAt: effectiveAt,
    evaluationMode: 'CURRENT_WITH_REVALIDATION',
    observedAt: effectiveAt,
    revalidatedAt: effectiveAt,
    scheduleRevision: 1,
    supportRevisionRef,
    supportRootRef,
  },
  effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
  factProofs: [{ factRef: supportRootRef.resourceId, factRevisionRef: supportRevisionRef.resourceId, verificationRef }],
  generation: 1,
  observedAt: effectiveAt,
  predicateRef: `commerce.pricing.current-supported-currencies:${tenantId}:${supportRootId}:${supportRevisionId}:CZK`,
  pricingRevision: 'pricing-currency-support:1',
  scheduleRevision: 1,
  supportedCurrencies: ['CZK'],
  supportRevisionRef,
  supportRootRef,
  verificationRef,
} as const;

describe('Issue #765 trusted explicit-input observation composition', () => {
  it.effect('acquires Pricing-owned Currency Support without fabricating candidate-only owner evidence', () =>
    Effect.gen(function* acquireOnlyAvailableFacts() {
      const port = makeBrokenExplicitInputObservationPort({
        loadCurrencySupport: () => Effect.succeed({ _tag: 'current', current: stored }),
      });
      const result = yield* port.acquire(context, trusted);

      expect(result.currencySupport).toMatchObject({
        outcome: 'SUPPORTED_CURRENCIES_CURRENT',
        supportedCurrencies: ['CZK'],
        tenantId,
      });
      expect(result).not.toHaveProperty('priceGroupResolutionInput');
      expect(result).not.toHaveProperty('quantityBasis');
      expect(result).not.toHaveProperty('sourceAssessment');
    }),
  );

  it.effect('retains distinct Pricing-owned claimants for a Currency Support conflict', () =>
    Effect.gen(function* acquireConflictFacts() {
      const candidateRevisionIds = [
        '55555555-5555-4555-8555-555555555555',
        '66666666-6666-4666-8666-666666666666',
      ] as const;
      const port = makeBrokenExplicitInputObservationPort({
        loadCurrencySupport: () =>
          Effect.succeed({
            _tag: 'conflict',
            candidateRevisionIds,
            observedAt: effectiveAt,
          }),
      });
      const result = yield* port.acquire(context, trusted);

      expect(result.currencySupport).toMatchObject({
        code: 'pricing_currency_support_revision_conflict',
        outcome: 'SUPPORTED_CURRENCIES_INVALID',
      });
      expect(result.currencySupportConflictRefs).toEqual(candidateRevisionIds);
    }),
  );

  it.effect('fails closed when trusted whole-candidate identifiers are not yet available', () =>
    Effect.gen(function* failClosedWithoutCandidatePorts() {
      const observations = makeBrokenExplicitInputObservationPort({
        loadCurrencySupport: () => Effect.succeed({ _tag: 'current', current: stored }),
      });
      const result = yield* makeBrokenExplicitInputValidationService(observations).evaluate(context, trusted);

      expect(Schema.is(PricingExplicitInputIndeterminateSchema)(result)).toBe(true);
      expect(result).toMatchObject({
        outcome: 'PRICING_INDETERMINATE',
        retryable: true,
      });
    }),
  );

  it.effect('does not consult any owner when public context disagrees with trusted scope', () =>
    Effect.gen(function* rejectUntrustedContext() {
      let calls = 0;
      const port = makeBrokenExplicitInputObservationPort({
        candidates: {
          priceGroup: () => {
            calls += 1;
            return Effect.die('must not acquire candidate evidence');
          },
        },
        loadCurrencySupport: () => {
          calls += 1;
          return Effect.die('must not acquire Currency Support');
        },
      });
      const result = yield* port.acquire(context, { ...trusted, tenantId: 'different-tenant' });

      expect(result).toEqual({ context });
      expect(calls).toBe(0);
    }),
  );
});
