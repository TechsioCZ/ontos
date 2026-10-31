import type {
  MarketAffectedUseAssessmentRequest,
  MarketAffectedUseAssessmentResponse,
  MarketAffectedUseSourceEvidence,
} from '@app/customer-market-retirement-contracts';
import { describe, expect, it } from 'effect-rstest';
import { DateTime, Effect, Predicate } from 'effect';

import {
  makeMarketRetirementImpactAuthority,
  makeMarketRetirementImpactAuthorityFromPublishedClient,
} from '../../src/integrations/market-retirement-impact.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const marketRef = {
  moduleId: 'commerce.market-catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.market-catalog.market',
  tenantId,
} as const;
const effectiveAt = '2026-12-01T00:00:00.000Z';
const observedAt = '2026-11-30T23:59:59.000Z';
const nextApplicabilityBoundary = '2027-01-01T00:00:00.000Z';
const assessmentDigest = 'a'.repeat(64);
const reservationToken = '99999999-9999-4999-8999-999999999999';
const requestCorrelation = '33333333-3333-4333-8333-333333333333';
const reason = 'Retire replaced Market.';
const input = {
  compositionRevision: 'a'.repeat(64),
  effectiveAt: DateTime.makeUnsafe(effectiveAt),
  expectedMarketRevision: 3,
  legalEntityId: '44444444-4444-4444-8444-444444444444',
  marketRef,
  reason,
  requestCorrelation,
} as const;
const owner = {
  compositionRevision: input.compositionRevision,
  legalEntityId: input.legalEntityId,
  requestCorrelation,
} as const;
const reserveKey = 'market-retirement:55555555-5555-4555-8555-555555555555:reserve';
const commitKey = 'market-retirement:55555555-5555-4555-8555-555555555555:commit';
const releaseKey = 'market-retirement:55555555-5555-4555-8555-555555555555:release';
const reservationInvocationId = '66666666-6666-4666-8666-666666666666';
const alreadyCommitted = {
  _tag: 'ReserveMarketRetirementActionAlreadyCommittedProblem',
  code: 'action_already_committed',
  detail: 'This idempotency key already committed successfully',
  invocationId: reservationInvocationId,
  resolution: 'REFRESH_GOVERNED_READS',
  retryCommand: false,
  status: 409,
  title: 'Already committed',
  type: 'about:blank',
} as const;
const reservedResult = (lifecycle: 'COMMITTED' | 'RELEASED' | 'RESERVED', reservationVersion: number) => ({
  assessmentDigest,
  lifecycle,
  marketRef,
  marketRevision: 3,
  reservationToken,
  reservationVersion,
  tenantId,
});
const assess = (authority: ReturnType<typeof makeMarketRetirementImpactAuthority>) =>
  authority.prepareRetirementReservation(input).pipe(Effect.map(({ assessment }) => assessment));
const request: MarketAffectedUseAssessmentRequest = {
  evaluatedAt: effectiveAt,
  marketRef,
  marketRevision: 3,
  tenantId,
};
const sourceEvidence: MarketAffectedUseSourceEvidence = {
  completenessEvidence: {
    nextApplicabilityBoundary: DateTime.makeUnsafe(nextApplicabilityBoundary),
    observedAt: DateTime.makeUnsafe(observedAt),
    ownerRevision: 'customer-context:revision:17',
    scope: {
      kind: 'EXACT_PREDICATE' as const,
      predicateRef: `market-retirement:${tenantId}:${marketRef.resourceId}:3`,
    },
  },
  currentness: 'CURRENT' as const,
  digest: 'b'.repeat(64),
  generation: 'customer-context:g17',
  ownerRevision: 'customer-context:revision:17',
  sourceId: 'commerce.customer-context.market-bootstrap-policy',
};
const verified: Extract<MarketAffectedUseAssessmentResponse, { readonly outcome: 'VERIFIED' }> = {
  assessmentDigest,
  evaluatedAt: effectiveAt,
  liveBlockingReferences: {
    bootstrapDefaults: [],
    currentProposals: [],
  },
  marketRef,
  marketRevision: 3,
  nextApplicabilityBoundary,
  observedAt,
  outcome: 'VERIFIED',
  retainedHistoryReferences: [
    {
      kind: 'RETAINED_HISTORY',
      marketRef,
      marketRevision: 3,
      ownerResourceRef: {
        moduleId: 'commerce.customer-context',
        resourceId: '44444444-4444-4444-8444-444444444444',
        resourceType: 'commerce.customer-context.purchase-proposal-revision',
        tenantId,
      },
      ownerResourceRevision: 'proposal:revision:4',
    },
  ],
  sourceEvidence: [sourceEvidence],
  tenantId,
};

describe('Market retirement production authority', () => {
  it.effect(
    'calls the Customer Context published client with exact Market scope and maps complete current evidence',
    () =>
      Effect.gen(function* completeEvidence() {
        const calls: unknown[] = [];
        const authority = makeMarketRetirementImpactAuthority((payload, context) => {
          calls.push({ context, payload });
          return Effect.succeed(verified);
        });

        const result = yield* assess(authority);

        expect(calls).toEqual([
          {
            context: {
              compositionRevision: input.compositionRevision,
              legalEntityId: input.legalEntityId,
              requestCorrelation: input.requestCorrelation,
            },
            payload: request,
          },
        ]);
        expect(result).toEqual({
          assessedMarketRef: marketRef,
          assessedMarketRevision: 3,
          assessmentDigest,
          effectiveAt,
          providers: [
            {
              completenessEvidenceReference: `customer-context:market-affected-use:${assessmentDigest}`,
              currentnessEvidenceReference: `customer-context:market-affected-use:${observedAt}:${assessmentDigest}`,
              effectiveAt,
              liveBlockingReferences: {
                count: 0,
                evidenceReference: `customer-context:market-live-references:${assessmentDigest}`,
              },
              nextBoundaryAt: '2027-01-01T00:00:00.000Z',
              observedAt,
              ownerModuleKey: 'commerce.customer-context',
              ownerRevision: assessmentDigest,
              retainedHistoryEvidence: {
                count: 1,
                evidenceReference: `customer-context:market-retained-history:${assessmentDigest}`,
              },
              versionToken: assessmentDigest,
            },
          ],
          requiredProviderModuleKeys: ['commerce.customer-context'],
        });
      }),
  );

  it.effect('persists the exact RESERVE request, then reserves, commits, or releases with stable per-intent keys', () =>
    Effect.gen(function* reservationLifecycle() {
      const calls: {
        readonly idempotencyKey: string;
        readonly payload: unknown;
      }[] = [];
      const authority = makeMarketRetirementImpactAuthority(() => Effect.succeed(verified), {
        execute: (payload, context) => {
          calls.push({ idempotencyKey: context.idempotencyKey, payload });
          expect(context).toEqual({ ...owner, idempotencyKey: context.idempotencyKey });
          if (payload.operation === 'RESERVE') {
            return Effect.succeed(reservedResult('RESERVED', 7));
          }
          return Effect.succeed(
            reservedResult(payload.operation === 'COMMIT' ? 'COMMITTED' : 'RELEASED', payload.reservationVersion + 1),
          );
        },
      });

      const prepared = yield* authority.prepareRetirementReservation(input);
      expect(calls).toEqual([]);
      expect(prepared.reservationRequest).toEqual({
        assessmentDigest,
        evaluatedAt: effectiveAt,
        marketRef,
        marketRevision: 3,
        operation: 'RESERVE',
        reason,
        sourceEvidence: verified.sourceEvidence,
        tenantId,
      });
      const reserved = yield* authority.reserveRetirementImpact({
        ...owner,
        assessment: prepared.assessment,
        idempotencyKey: reserveKey,
        reservationRequest: prepared.reservationRequest,
      });
      expect(reserved).toMatchObject({ assessmentDigest, reservation: { token: reservationToken, version: 7 } });

      yield* authority.commitRetirementImpact({ ...owner, assessment: reserved, idempotencyKey: commitKey, reason });
      yield* authority.releaseRetirementImpact({ ...owner, assessment: reserved, idempotencyKey: releaseKey, reason });
      expect(calls.map(({ idempotencyKey }) => idempotencyKey)).toEqual([reserveKey, commitKey, releaseKey]);
      expect(calls.slice(1).map(({ payload }) => payload)).toEqual([
        {
          marketRef,
          marketRevision: 3,
          operation: 'COMMIT',
          reason,
          reservationToken,
          reservationVersion: 7,
          tenantId,
        },
        {
          marketRef,
          marketRevision: 3,
          operation: 'RELEASE',
          reason,
          reservationToken,
          reservationVersion: 7,
          tenantId,
        },
      ]);
    }),
  );

  it.effect('recovers a committed RESERVE through the exact reservation read instead of reserving again', () =>
    Effect.gen(function* reserveRecovery() {
      const reads: unknown[] = [];
      let reserveCalls = 0;
      const authority = makeMarketRetirementImpactAuthority(() => Effect.succeed(verified), {
        execute: (payload) => {
          reserveCalls += payload.operation === 'RESERVE' ? 1 : 0;
          return payload.operation === 'RESERVE'
            ? Effect.fail(alreadyCommitted)
            : Effect.succeed(reservedResult('COMMITTED', payload.reservationVersion + 1));
        },
        read: (payload, context) => {
          reads.push({ context, payload });
          return Effect.succeed(reservedResult('RESERVED', 1));
        },
      });
      const prepared = yield* authority.prepareRetirementReservation(input);
      const reserved = yield* authority.reserveRetirementImpact({
        ...owner,
        assessment: prepared.assessment,
        idempotencyKey: reserveKey,
        reservationRequest: prepared.reservationRequest,
      });
      expect(reserveCalls).toBe(1);
      expect(reads).toEqual([{ context: owner, payload: { marketRef, reservationInvocationId, tenantId } }]);
      expect(reserved.reservation).toEqual({ token: reservationToken, version: 1 });
    }),
  );

  it.effect('treats a replayed COMMIT or RELEASE key as already final', () =>
    Effect.gen(function* finishReplay() {
      const authority = makeMarketRetirementImpactAuthority(() => Effect.succeed(verified), {
        execute: () => Effect.fail(alreadyCommitted),
      });
      const prepared = yield* authority.prepareRetirementReservation(input);
      const assessment = { ...prepared.assessment, reservation: { token: reservationToken, version: 1 } };
      yield* authority.commitRetirementImpact({ ...owner, assessment, idempotencyKey: commitKey, reason });
      yield* authority.releaseRetirementImpact({ ...owner, assessment, idempotencyKey: releaseKey, reason });
    }),
  );

  it.effect('maps only owner-declared definite reservation outcomes to terminal failures', () =>
    Effect.gen(function* reservationFailures() {
      const cases = [
        [{ code: 'LIVE_REFERENCE_CONFLICT', reason: 'live' }, 'MarketCommandRejected'],
        [{ code: 'ASSESSMENT_STALE', reason: 'stale' }, 'MarketRetirementImpactAssessmentStale'],
        [{ code: 'RETIREMENT_RESERVATION_CONFLICT', reason: 'active' }, 'MarketRetirementImpactAssessmentRejected'],
        [{ code: 'gateway_offline', reason: 'offline' }, 'MarketRetirementImpactAssessmentUnavailable'],
        [{ code: 'action_permission_denied', reason: 'denied' }, 'MarketRetirementImpactAssessmentUnavailable'],
      ] as const;
      for (const [failure, expectedTag] of cases) {
        const authority = makeMarketRetirementImpactAuthority(() => Effect.succeed(verified), {
          execute: () => Effect.fail(failure),
        });
        const prepared = yield* authority.prepareRetirementReservation(input);
        const result = yield* authority
          .reserveRetirementImpact({
            ...owner,
            assessment: prepared.assessment,
            idempotencyKey: reserveKey,
            reservationRequest: prepared.reservationRequest,
          })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(result, expectedTag)).toBe(true);
      }

      const mismatched = makeMarketRetirementImpactAuthority(() => Effect.succeed(verified), {
        execute: () => Effect.succeed({ ...reservedResult('RESERVED', 1), assessmentDigest: 'f'.repeat(64) }),
      });
      const prepared = yield* mismatched.prepareRetirementReservation(input);
      const mismatchedFailure = yield* mismatched
        .reserveRetirementImpact({
          ...owner,
          assessment: prepared.assessment,
          idempotencyKey: reserveKey,
          reservationRequest: prepared.reservationRequest,
        })
        .pipe(Effect.flip);
      expect(Predicate.isTagged(mismatchedFailure, 'MarketRetirementImpactAssessmentUnavailable')).toBe(true);
    }),
  );

  it.effect('keeps owner rejection, stale evidence, and owner unavailability distinct', () =>
    Effect.gen(function* typedFailures() {
      const outcomes: readonly [
        MarketAffectedUseAssessmentResponse,
        (
          | 'MarketRetirementImpactAssessmentRejected'
          | 'MarketRetirementImpactAssessmentStale'
          | 'MarketRetirementImpactAssessmentUnavailable'
        ),
      ][] = [
        [
          { ...request, code: 'live-reference', outcome: 'REJECTED', reason: 'A live reference exists' },
          'MarketRetirementImpactAssessmentRejected',
        ],
        [
          {
            ...request,
            code: 'stale-owner-evidence',
            observedAt,
            outcome: 'STALE',
            reason: 'Owner evidence changed',
            staleSourceIds: [sourceEvidence.sourceId],
          },
          'MarketRetirementImpactAssessmentStale',
        ],
        [
          {
            ...request,
            code: 'owner-unavailable',
            outcome: 'UNAVAILABLE',
            reason: 'Customer Context is unavailable',
            retryable: true,
          },
          'MarketRetirementImpactAssessmentUnavailable',
        ],
      ];

      for (const [response, expectedTag] of outcomes) {
        const failure = yield* assess(makeMarketRetirementImpactAuthority(() => Effect.succeed(response))).pipe(
          Effect.flip,
        );
        expect(Predicate.isTagged(failure, expectedTag)).toBe(true);
      }
    }),
  );

  it.effect(
    'fails closed on transport failure, mismatched scope, stale boundaries, and incomplete source evidence',
    () =>
      Effect.gen(function* invalidEvidence() {
        const cases = [
          {
            ...verified,
            marketRevision: 2,
          },
          {
            ...verified,
            nextApplicabilityBoundary: effectiveAt,
          },
          {
            ...verified,
            sourceEvidence: [],
          },
          {
            ...verified,
            sourceEvidence: [sourceEvidence, sourceEvidence],
          },
          {
            ...verified,
            sourceEvidence: [
              {
                ...sourceEvidence,
                completenessEvidence: {
                  ...sourceEvidence.completenessEvidence,
                  ownerRevision: 'customer-context:revision:older',
                },
              },
            ],
          },
        ] satisfies readonly MarketAffectedUseAssessmentResponse[];

        for (const response of cases) {
          const failure = yield* assess(makeMarketRetirementImpactAuthority(() => Effect.succeed(response))).pipe(
            Effect.flip,
          );
          expect(
            Predicate.isTagged(failure, 'MarketRetirementImpactAssessmentStale') ||
              Predicate.isTagged(failure, 'MarketRetirementImpactAssessmentUnavailable'),
          ).toBe(true);
        }

        const transportFailure = yield* assess(makeMarketRetirementImpactAuthority(() => Effect.fail('offline'))).pipe(
          Effect.flip,
        );
        expect(Predicate.isTagged(transportFailure, 'MarketRetirementImpactAssessmentUnavailable')).toBe(true);
      }),
  );

  it('exports the published-client authority factory used by the Market owner worker', () => {
    expect(makeMarketRetirementImpactAuthorityFromPublishedClient).toBeTypeOf('function');
  });
});
