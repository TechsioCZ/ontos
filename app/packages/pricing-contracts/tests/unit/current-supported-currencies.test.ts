import { Effect, Exit, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CurrentSupportedCurrenciesPolicyConflictProblemSchema,
  CurrentSupportedCurrenciesRequestSchema,
  CurrentSupportedCurrenciesResponseSchema,
  executeCurrentSupportedCurrencies,
  executeCurrentSupportedCurrenciesWithAuthorization,
} from '../../src/index.ts';

const tenantId = '22222222-2222-4222-8222-222222222222';
const request = {
  cartId: 'cart-42',
  channelId: 'web-b2c',
  contextRevision: 'customer-context:41',
  effectiveAt: '2026-09-22T10:00:00.000Z',
  marketId: 'cz-launch',
  sellingLegalEntityId: 'techsio-cz',
  storefrontId: 'storefront-cz',
  subject: {
    guestEvidenceRef: 'guest-evidence:17',
    guestSessionRef: 'guest-session:42',
    kind: 'GUEST' as const,
  },
  tenantId,
};

// The governed read runtime decodes read input closed (core-runtime `reads/runtime.ts`).
const decodeReadInput = Schema.decodeUnknownSync(CurrentSupportedCurrenciesRequestSchema, {
  onExcessProperty: 'error',
});

const completenessEvidence = {
  nextApplicabilityBoundary: '2026-09-23T00:00:00.000Z',
  observedAt: '2026-09-22T09:59:59.000Z',
  ownerRevision: 'pricing:73',
  scope: {
    kind: 'EXACT_PREDICATE' as const,
    predicateRef: 'pricing.supported-currencies:cart-42:customer-context:41',
  },
};

const current = {
  completenessEvidence,
  effectiveAt: request.effectiveAt,
  nextApplicabilityBoundary: completenessEvidence.nextApplicabilityBoundary,
  observedAt: completenessEvidence.observedAt,
  outcome: 'SUPPORTED_CURRENCIES_CURRENT' as const,
  pricingRevision: completenessEvidence.ownerRevision,
  supportedCurrencies: ['CZK', 'EUR'],
};

describe('Pricing Current supported-currencies contract', () => {
  it('strictly binds every pricing input and accepts an exact guest subject', () => {
    expect(Schema.decodeSync(CurrentSupportedCurrenciesRequestSchema)(request)).toEqual(request);
    expect(() => decodeReadInput({ ...request, extra: true })).toThrow();
    expect(() =>
      Schema.decodeSync(CurrentSupportedCurrenciesRequestSchema)({
        ...request,
        effectiveAt: '2026-09-22T10:00:00Z',
      }),
    ).toThrow();
    expect(() =>
      decodeReadInput({
        ...request,
        subject: { ...request.subject, extra: true },
      }),
    ).toThrow();
  });

  it('rejects a profile from a different Tenant', () => {
    expect(() =>
      Schema.decodeSync(CurrentSupportedCurrenciesRequestSchema)({
        ...request,
        subject: {
          authorizationSubject: { kind: 'RETAIL' },
          kind: 'PROFILE',
          profileRef: {
            moduleId: 'commerce.customer-context',
            resourceId: 'retail-profile-1',
            resourceType: 'commerce.customer-context.retail-customer-profile',
            tenantId: '33333333-3333-4333-8333-333333333333',
          },
        },
      }),
    ).toThrow();
  });

  it('requires unique currencies and owner-verifiable current evidence', () => {
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
        pricingRevision: 'pricing:72',
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(CurrentSupportedCurrenciesResponseSchema)({
        ...current,
        effectiveAt: '2026-09-23T00:00:00.000Z',
      }),
    ).toThrow();
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
