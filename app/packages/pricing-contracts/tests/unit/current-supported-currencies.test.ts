import { Effect, Exit, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CurrentSupportedCurrenciesPolicyConflictProblemSchema,
  CurrentSupportedCurrenciesRequestSchema,
  CurrentSupportedCurrenciesResponseSchema,
  CurrentSupportedCurrenciesSuccessSchema,
  executeCurrentSupportedCurrencies,
  executeCurrentSupportedCurrenciesWithAuthorization,
} from '../../src/index.ts';

const tenantId = '22222222-2222-4222-8222-222222222222';
const supportRootId = '33333333-3333-4333-8333-333333333333';
const supportRevisionId = '55555555-5555-4555-8555-555555555555';
const verificationRef = 'commerce.pricing.currency-support-proof:55555555-5555-4555-8555-555555555555';
const request = {
  effectiveAt: '2026-09-22T10:00:00.000Z',
  tenantId,
};

// The governed read runtime decodes read input closed (core-runtime `reads/runtime.ts`).
const decodeReadInput = Schema.decodeUnknownSync(CurrentSupportedCurrenciesRequestSchema, {
  onExcessProperty: 'error',
});

const completenessEvidence = {
  nextApplicabilityBoundary: '2026-09-23T00:00:00.000Z',
  observedAt: '2026-09-22T10:00:01.000Z',
  ownerRevision: supportRevisionId,
  scope: {
    kind: 'EXACT_PREDICATE' as const,
    predicateRef: `commerce.pricing.current-supported-currencies:${tenantId}`,
  },
};

const supportRootRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: supportRootId,
  resourceType: 'commerce.pricing.currency-support' as const,
  tenantId,
};
const supportRevisionRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: completenessEvidence.ownerRevision,
  resourceType: 'commerce.pricing.currency-support-revision' as const,
  supportRootId,
  tenantId,
};

const current = {
  completenessEvidence,
  currentnessEvidence: {
    evaluatedAt: '2026-09-22T10:00:00.500Z',
    evaluationMode: 'CURRENT_WITH_REVALIDATION' as const,
    observedAt: completenessEvidence.observedAt,
    revalidatedAt: '2026-09-22T10:00:02.000Z',
    scheduleRevision: 5,
    supportRevisionRef,
    supportRootRef,
  },
  effectiveAt: request.effectiveAt,
  effectivePeriod: {
    effectiveFrom: '2026-09-22T09:00:00.000Z',
    effectiveTo: '2026-09-23T00:00:00.000Z',
  },
  factProofs: [{ factRef: supportRootId, factRevisionRef: supportRevisionId, verificationRef }],
  generation: 4,
  nextApplicabilityBoundary: completenessEvidence.nextApplicabilityBoundary,
  observedAt: completenessEvidence.observedAt,
  outcome: 'SUPPORTED_CURRENCIES_CURRENT' as const,
  pricingRevision: 'pricing:73',
  scheduleRevision: 5,
  supportedCurrencies: ['CZK', 'EUR'],
  supportRevisionRef,
  supportRootRef,
  tenantId,
  verificationRef,
};

describe('Pricing Current supported-currencies contract', () => {
  it('accepts only Tenant and effective time as the capability identity', () => {
    expect(Schema.decodeSync(CurrentSupportedCurrenciesRequestSchema)(request)).toEqual(request);
    for (const purchaseSpecific of [
      { cartId: 'cart-42' },
      { channelId: 'B2C' },
      { contextRevision: 'customer-context:41' },
      { marketId: 'cz-launch' },
      { resolvedCurrency: 'CZK' },
      { sellingLegalEntityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      { storefrontId: 'storefront-cz' },
      { subject: { kind: 'GUEST' } },
      { variantId: 'variant-1' },
    ]) {
      expect(() => decodeReadInput({ ...request, ...purchaseSpecific })).toThrow();
    }
    expect(() =>
      Schema.decodeSync(CurrentSupportedCurrenciesRequestSchema)({
        ...request,
        effectiveAt: '2026-09-22T10:00:00Z',
      }),
    ).toThrow();
  });

  it('requires unique generalized currencies and owner-verifiable current evidence', () => {
    expect(Schema.decodeSync(CurrentSupportedCurrenciesResponseSchema)(current)).toEqual(current);
    expect(() =>
      Schema.decodeSync(CurrentSupportedCurrenciesResponseSchema)({
        ...current,
        supportedCurrencies: ['CZK', 'CZK'],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(CurrentSupportedCurrenciesResponseSchema)({
        ...current,
        supportedCurrencies: [],
      }),
    ).toThrow();
    expect(
      Schema.decodeSync(CurrentSupportedCurrenciesResponseSchema)({
        ...current,
        currentnessEvidence: {
          ...current.currentnessEvidence,
          evaluatedAt: '2026-09-22T09:59:58.000Z',
        },
        effectiveAt: '2026-09-22T09:59:58.000Z',
      }),
    ).toMatchObject({ observedAt: completenessEvidence.observedAt, supportedCurrencies: ['CZK', 'EUR'] });
    expect(
      Schema.decodeSync(CurrentSupportedCurrenciesResponseSchema)({
        ...current,
        pricingRevision: 'pricing:72',
      }),
    ).toMatchObject({ pricingRevision: 'pricing:72', supportRevisionRef });
    expect(() =>
      Schema.decodeSync(CurrentSupportedCurrenciesResponseSchema)({
        ...current,
        effectiveAt: '2026-09-23T00:00:00.000Z',
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(CurrentSupportedCurrenciesResponseSchema)({
        ...current,
        currentnessEvidence: {
          ...current.currentnessEvidence,
          evaluatedAt: '2026-09-22T09:59:59.999Z',
        },
      }),
    ).toThrow();
    expect(() =>
      (() => {
        const { nextApplicabilityBoundary: _completenessBoundary, ...completenessWithoutBoundary } =
          current.completenessEvidence;
        const { nextApplicabilityBoundary: _resultBoundary, ...currentWithoutBoundary } = current;
        return Schema.decodeSync(CurrentSupportedCurrenciesResponseSchema)({
          ...currentWithoutBoundary,
          completenessEvidence: {
            ...completenessWithoutBoundary,
            observedAt: '2026-09-23T00:00:00.001Z',
          },
          currentnessEvidence: {
            ...current.currentnessEvidence,
            evaluatedAt: '2026-09-23T00:00:00.000Z',
            observedAt: '2026-09-23T00:00:00.001Z',
            revalidatedAt: '2026-09-23T00:00:00.002Z',
          },
          observedAt: '2026-09-23T00:00:00.001Z',
        });
      })(),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(CurrentSupportedCurrenciesResponseSchema)({
        ...current,
        supportRevisionRef: { ...supportRevisionRef, supportRootId: '44444444-4444-4444-8444-444444444444' },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(CurrentSupportedCurrenciesResponseSchema)({
        ...current,
        currentnessEvidence: { ...current.currentnessEvidence, observedAt: '2026-09-22T10:00:00.500Z' },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(CurrentSupportedCurrenciesResponseSchema)({
        ...current,
        currentnessEvidence: {
          ...current.currentnessEvidence,
          supportRevisionRef: {
            ...current.currentnessEvidence.supportRevisionRef,
            tenantId: '44444444-4444-4444-8444-444444444444',
          },
          supportRootRef: {
            ...current.currentnessEvidence.supportRootRef,
            tenantId: '44444444-4444-4444-8444-444444444444',
          },
        },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(CurrentSupportedCurrenciesResponseSchema)({
        ...current,
        currentnessEvidence: {
          ...current.currentnessEvidence,
          supportRevisionRef: {
            ...current.currentnessEvidence.supportRevisionRef,
            tenantId: '44444444-4444-4444-8444-444444444444',
          },
          supportRootRef: {
            ...current.currentnessEvidence.supportRootRef,
            tenantId: '44444444-4444-4444-8444-444444444444',
          },
        },
        pricingRevision: completenessEvidence.ownerRevision,
      }),
    ).toThrow();
    expect(() => {
      const { revalidatedAt: _revalidatedAt, ...currentnessWithoutRevalidation } = current.currentnessEvidence;
      return Schema.decodeSync(CurrentSupportedCurrenciesResponseSchema)({
        ...current,
        currentnessEvidence: {
          ...currentnessWithoutRevalidation,
          evaluatedAt: '2026-09-22T10:00:00.500Z',
          evaluationMode: 'HISTORICAL_AS_OF',
        },
      });
    }).toThrow();
  });

  it('decodes the prior v2 success only through the bounded compatibility envelope', () => {
    const compatibilityCompletenessEvidence = {
      ...completenessEvidence,
      ownerRevision: 'pricing:73',
    };
    const compatibilityResponse = {
      completenessEvidence: compatibilityCompletenessEvidence,
      effectiveAt: request.effectiveAt,
      nextApplicabilityBoundary: completenessEvidence.nextApplicabilityBoundary,
      observedAt: completenessEvidence.observedAt,
      outcome: 'SUPPORTED_CURRENCIES_CURRENT' as const,
      pricingRevision: compatibilityCompletenessEvidence.ownerRevision,
      supportedCurrencies: ['CZK'],
    };
    expect(Schema.decodeSync(CurrentSupportedCurrenciesResponseSchema)(compatibilityResponse)).toEqual(
      compatibilityResponse,
    );
    expect(() => Schema.decodeUnknownSync(CurrentSupportedCurrenciesSuccessSchema)(compatibilityResponse)).toThrow();
  });

  it('publishes distinct invalid, unavailable, unverifiable, and stale outcomes', () => {
    const outcomes = [
      {
        code: 'invalid-context',
        outcome: 'SUPPORTED_CURRENCIES_INVALID',
        reason: 'The purchase context is inconsistent',
        retryable: false,
      },
      {
        code: 'pricing-unavailable',
        outcome: 'SUPPORTED_CURRENCIES_UNAVAILABLE',
        reason: 'Pricing is temporarily unavailable',
        retryable: true,
      },
      {
        code: 'proof-unverifiable',
        outcome: 'SUPPORTED_CURRENCIES_UNVERIFIABLE',
        reason: 'Completeness proof cannot be verified',
        retryable: false,
      },
      {
        code: 'pricing-stale',
        observedAt: '2026-09-22T09:00:00.000Z',
        outcome: 'SUPPORTED_CURRENCIES_STALE',
        pricingRevision: 'pricing:72',
        reason: 'Pricing changed after observation',
        retryable: true,
      },
    ] as const;

    for (const outcome of outcomes) {
      expect(Schema.decodeSync(CurrentSupportedCurrenciesResponseSchema)(outcome).outcome).toBe(outcome.outcome);
    }
  });

  it('publishes the generated policy-conflict problem contract', () => {
    expect(
      Schema.decodeSync(CurrentSupportedCurrenciesPolicyConflictProblemSchema)({
        _tag: 'CurrentSupportedCurrenciesPolicyConflictProblem',
        detail: 'Pricing rejected the governed read because current policy changed',
        status: 409,
        title: 'Current supported currencies policy conflict',
        type: 'about:blank',
      }).status,
    ).toBe(409);
  });

  it.effect('strictly encodes before the governed client can invoke HTTP', () =>
    Effect.gen(function* verifyStrictClientEncoding() {
      const invalid = { ...request, effectiveAt: 'not-an-instant' };
      const exit = yield* Effect.exit(
        executeCurrentSupportedCurrenciesWithAuthorization(invalid, 'credential', 'correlation'),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(executeCurrentSupportedCurrencies).toBeTypeOf('function');
    }),
  );
});
