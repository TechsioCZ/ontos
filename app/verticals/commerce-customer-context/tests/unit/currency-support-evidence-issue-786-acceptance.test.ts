import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import { CurrentSupportedCurrenciesSuccessSchema } from '@app/pricing-contracts';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { purchaseCurrencyPricingPortFromEnvironment } from '../../src/integrations/purchase-currency-pricing.ts';
import {
  fakeDelegatedAcquire,
  issuedDelegatedContext,
  originatorSubject,
} from '../support/delegated-gateway-acquisition.fixture.ts';

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

const issued = issuedDelegatedContext({ compositionRevision: 'a'.repeat(64), token: 'pricing-owner-issued' });
const acquire = fakeDelegatedAcquire(issued);
const subject = originatorSubject('a'.repeat(64), '20000000-0000-4000-8000-000000000001');

describe('issue #786 Tenant Currency Support evidence propagation', () => {
  it.effect('preserves requested, evaluated, and observed time plus owner proof through Commerce', () =>
    Effect.gen(function* losslessCurrencyProof() {
      const ownerCalls: unknown[] = [];
      const port = yield* purchaseCurrencyPricingPortFromEnvironment(
        {
          requestCorrelation: 'issue-786-currency-proof',
          subject,
        },
        (payload) => {
          ownerCalls.push(payload);
          return Effect.succeed(ownerResponse);
        },
        acquire,
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
    }).pipe(Effect.provide(nodeCryptoLayer)),
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
