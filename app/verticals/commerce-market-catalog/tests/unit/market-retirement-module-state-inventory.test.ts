import type {
  MarketAffectedUseAssessmentRequest,
  MarketAffectedUseAssessmentResponse,
  MarketAffectedUseSourceEvidence,
} from '@app/customer-market-retirement-contracts';
import { DateTime, Effect, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeMarketRetirementImpactAuthority } from '../../src/integrations/market-retirement-impact.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const marketRef = {
  moduleId: 'commerce.market-catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.market-catalog.market',
  tenantId,
} as const;
const effectiveAt = '2026-12-01T00:00:00.000Z';
const observedAt = '2026-11-30T23:59:59.000Z';
const request: MarketAffectedUseAssessmentRequest = {
  evaluatedAt: effectiveAt,
  marketRef,
  marketRevision: 3,
  tenantId,
};
const input = {
  actionInvocationId: '33333333-3333-4333-8333-333333333333',
  effectiveAt,
  expectedMarketRevision: 3,
  marketRef,
} as const;

const compositionEvidence: MarketAffectedUseSourceEvidence = {
  completenessEvidence: {
    nextApplicabilityBoundary: DateTime.makeUnsafe('2027-01-01T00:00:00.000Z'),
    observedAt: DateTime.makeUnsafe(observedAt),
    ownerRevision: 'composition:19',
    scope: {
      declaredScopeRef: `active-composition:19:${tenantId}`,
      kind: 'SAFELY_BROADER_SCOPE',
      predicateRef: `market-reference-owner-deployment-state:${tenantId}`,
    },
  },
  currentness: 'CURRENT',
  digest: 'b'.repeat(64),
  generation: 'composition:19',
  ownerRevision: 'composition:19',
  sourceId: 'commerce.customer-context.authoritative-owner-deployment-state',
};

const verified: Extract<MarketAffectedUseAssessmentResponse, { readonly outcome: 'VERIFIED' }> = {
  assessmentDigest: 'a'.repeat(64),
  evaluatedAt: effectiveAt,
  liveBlockingReferences: { bootstrapDefaults: [], currentProposals: [] },
  marketRef,
  marketRevision: 3,
  observedAt,
  outcome: 'VERIFIED',
  retainedHistoryReferences: [],
  sourceEvidence: [compositionEvidence],
  tenantId,
};

it.effect('delegates installed-owner completeness to the Customer Context authoritative assessment', () =>
  Effect.gen(function* delegatesOwnerInventory() {
    const calls: unknown[] = [];
    const authority = makeMarketRetirementImpactAuthority((payload, correlation) => {
      calls.push({ correlation, payload });
      return Effect.succeed(verified);
    });

    const result = yield* authority.assessRetirementImpact(input);

    expect(calls).toEqual([{ correlation: input.actionInvocationId, payload: request }]);
    expect(result.assessmentDigest).toBe(verified.assessmentDigest);
    expect(result.requiredProviderModuleKeys).toEqual(['commerce.customer-context']);
  }),
);

it.effect('does not require magic UNIMPLEMENTED source IDs from authoritative composition evidence', () =>
  Effect.gen(function* acceptsContractEvidence() {
    const result = yield* makeMarketRetirementImpactAuthority(() => Effect.succeed(verified)).assessRetirementImpact(
      input,
    );

    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]?.ownerRevision).toBe(verified.assessmentDigest);
  }),
);

it.effect('fails closed when Customer Context reports installed-owner evidence unavailable', () =>
  Effect.gen(function* rejectsUnavailableAuthority() {
    const failure = yield* makeMarketRetirementImpactAuthority(() =>
      Effect.succeed({
        ...request,
        code: 'installed-owner-provider-unavailable',
        outcome: 'UNAVAILABLE' as const,
        reason: 'An installed Market-reference owner has no affected-use provider',
        retryable: true,
      }),
    )
      .assessRetirementImpact(input)
      .pipe(Effect.flip);

    expect(Predicate.isTagged(failure, 'MarketRetirementImpactAssessmentUnavailable')).toBe(true);
    expect(failure.reason).toContain('installed');
  }),
);
