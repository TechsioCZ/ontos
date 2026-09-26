import { describe, expect, it } from 'effect-rstest';
import { DateTime, Effect, Exit, Schema } from 'effect';

import {
  MarketAffectedUseAssessmentRequestSchema,
  MarketAffectedUseAssessmentResponseSchema,
  MarketAffectedUseSourceEvidenceSchema,
  ReserveMarketRetirementPayloadSchema,
  ReserveMarketRetirementResultSchema,
  executeMarketAffectedUseAssessment,
  executeMarketAffectedUseAssessmentWithAuthorization,
  executeReserveMarketRetirement,
  executeReserveMarketRetirementWithAuthorization,
} from '../../src/index.ts';

const tenantId = '22222222-2222-4222-8222-222222222222';
const marketRef = {
  moduleId: 'commerce.market-catalog' as const,
  resourceId: 'cz-launch',
  resourceType: 'commerce.market-catalog.market' as const,
  tenantId,
};
const request = {
  evaluatedAt: '2026-09-22T10:00:00.000Z',
  marketRef,
  marketRevision: 7,
  tenantId,
};
const completenessEvidence = {
  nextApplicabilityBoundary: '2026-09-23T00:00:00.000Z',
  observedAt: '2026-09-22T09:59:59.000Z',
  ownerRevision: 'customer-context:41',
  scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'market:cz-launch:affected-use' },
};
const sourceEvidence = {
  completenessEvidence: Schema.decodeSync(MarketAffectedUseSourceEvidenceSchema)({
    completenessEvidence,
    currentness: 'CURRENT',
    digest: 'a'.repeat(64),
    generation: 'customer-context-generation-19',
    ownerRevision: 'customer-context:41',
    sourceId: 'customer-commerce-policy',
  }).completenessEvidence,
  currentness: 'CURRENT' as const,
  digest: 'a'.repeat(64),
  generation: 'customer-context-generation-19',
  ownerRevision: 'customer-context:41',
  sourceId: 'customer-commerce-policy',
};
const ownerResourceRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'bootstrap-policy',
  resourceType: 'commerce.customer-context.customer-commerce-policy',
  tenantId,
};

describe('Customer-owned Market retirement public contracts', () => {
  it('strictly binds the governed read to Tenant, exact Market revision, and evaluation instant', () => {
    expect(Schema.decodeSync(MarketAffectedUseAssessmentRequestSchema)(request)).toEqual(request);
    expect(() =>
      Schema.decodeSync(MarketAffectedUseAssessmentRequestSchema)({
        ...request,
        tenantId: '33333333-3333-4333-8333-333333333333',
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(MarketAffectedUseAssessmentRequestSchema)({
        ...request,
        evaluatedAt: '2026-09-22T10:00:00Z',
      }),
    ).toThrow();
    // The governed read runtime decodes read input closed (core-runtime `reads/runtime.ts`).
    const decodeReadInput = Schema.decodeUnknownSync(MarketAffectedUseAssessmentRequestSchema, {
      onExcessProperty: 'error',
    });
    expect(() => decodeReadInput({ ...request, extra: true })).toThrow();
  });

  it('separates live blockers from retained history and preserves owner-verifiable source versions', () => {
    const verified = {
      ...request,
      assessmentDigest: 'b'.repeat(64),
      liveBlockingReferences: {
        bootstrapDefaults: [
          {
            kind: 'BOOTSTRAP_DEFAULT' as const,
            marketRef,
            marketRevision: 7,
            ownerResourceRef,
            ownerResourceRevision: 'policy:12',
          },
        ],
        currentProposals: [],
      },
      nextApplicabilityBoundary: '2026-09-23T00:00:00.000Z',
      observedAt: '2026-09-22T09:59:59.000Z',
      outcome: 'VERIFIED' as const,
      retainedHistoryReferences: [
        {
          kind: 'RETAINED_HISTORY' as const,
          marketRef,
          marketRevision: 7,
          ownerResourceRef: { ...ownerResourceRef, resourceId: 'historical-policy' },
          ownerResourceRevision: 'policy:3',
        },
      ],
      sourceEvidence: [{ ...sourceEvidence, completenessEvidence }],
    };
    const decoded = Schema.decodeSync(MarketAffectedUseAssessmentResponseSchema)(verified);
    expect(decoded.outcome).toBe('VERIFIED');
    if (decoded.outcome !== 'VERIFIED') {
      throw new Error('Expected verified assessment');
    }
    const [decodedSourceEvidence] = decoded.sourceEvidence;
    if (decodedSourceEvidence === undefined) {
      throw new Error('Expected source evidence');
    }
    expect(DateTime.formatIso(decodedSourceEvidence.completenessEvidence.observedAt)).toBe(
      completenessEvidence.observedAt,
    );
    const { nextApplicabilityBoundary: nextBoundary } = decodedSourceEvidence.completenessEvidence;
    if (nextBoundary === undefined) {
      throw new Error('Expected next applicability boundary');
    }
    expect(DateTime.formatIso(nextBoundary)).toBe(completenessEvidence.nextApplicabilityBoundary);
    expect(() =>
      Schema.decodeSync(MarketAffectedUseAssessmentResponseSchema)({
        ...verified,
        observedAt: '2026-09-22T10:00:00.001Z',
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(MarketAffectedUseAssessmentResponseSchema)({
        ...verified,
        liveBlockingReferences: {
          ...verified.liveBlockingReferences,
          bootstrapDefaults: [
            {
              kind: 'BOOTSTRAP_DEFAULT',
              marketRef,
              marketRevision: 6,
              ownerResourceRef,
              ownerResourceRevision: 'policy:12',
            },
          ],
        },
      }),
    ).toThrow();
  });

  it('publishes distinct rejected, unavailable, and stale read outcomes', () => {
    for (const outcome of [
      { ...request, code: 'blocked', outcome: 'REJECTED', reason: 'Live bootstrap reference exists' },
      { ...request, code: 'owner-unavailable', outcome: 'UNAVAILABLE', reason: 'Owner unavailable', retryable: true },
      {
        ...request,
        code: 'stale',
        observedAt: '2026-09-22T09:00:00.000Z',
        outcome: 'STALE',
        reason: 'Source changed',
        staleSourceIds: ['customer-commerce-policy'],
      },
    ]) {
      expect(Schema.decodeUnknownSync(MarketAffectedUseAssessmentResponseSchema)(outcome).outcome).toBe(
        outcome.outcome,
      );
    }
  });

  it('requires the reservation token and version for commit/release and retains them in results', () => {
    const reserve = {
      ...request,
      assessmentDigest: 'b'.repeat(64),
      operation: 'RESERVE' as const,
      reason: 'Retire Market',
      sourceEvidence: [{ ...sourceEvidence, completenessEvidence }],
    };
    const decodedReserve = Schema.decodeSync(ReserveMarketRetirementPayloadSchema)(reserve);
    expect(decodedReserve.operation).toBe('RESERVE');
    if (decodedReserve.operation !== 'RESERVE') {
      throw new Error('Expected reservation payload');
    }
    const [decodedReserveEvidence] = decodedReserve.sourceEvidence;
    if (decodedReserveEvidence === undefined) {
      throw new Error('Expected reservation source evidence');
    }
    expect(DateTime.formatIso(decodedReserveEvidence.completenessEvidence.observedAt)).toBe(
      completenessEvidence.observedAt,
    );
    for (const operation of ['COMMIT', 'RELEASE'] as const) {
      expect(() =>
        Schema.decodeUnknownSync(ReserveMarketRetirementPayloadSchema)({
          marketRef,
          marketRevision: 7,
          operation,
          reason: 'Retire Market',
          tenantId,
        }),
      ).toThrow();
      expect(
        Schema.decodeSync(ReserveMarketRetirementPayloadSchema)({
          marketRef,
          marketRevision: 7,
          operation,
          reason: 'Retire Market',
          reservationToken: '11111111-1111-4111-8111-111111111111',
          reservationVersion: 3,
          tenantId,
        }).operation,
      ).toBe(operation);
    }
    expect(
      Schema.decodeSync(ReserveMarketRetirementResultSchema)({
        assessmentDigest: 'b'.repeat(64),
        lifecycle: 'COMMITTED',
        marketRef,
        marketRevision: 7,
        reservationToken: '11111111-1111-4111-8111-111111111111',
        reservationVersion: 3,
        tenantId,
      }).reservationVersion,
    ).toBe(3);
  });

  it.effect('strictly decodes payloads before either governed client executor can invoke HTTP', () =>
    Effect.gen(function* verifyStrictClientPayloadDecoding() {
      const invalidRead = { ...request, evaluatedAt: 'not-an-instant' };
      const readExit = yield* Effect.exit(
        executeMarketAffectedUseAssessmentWithAuthorization(invalidRead, 'credential', 'correlation'),
      );
      expect(Exit.isFailure(readExit)).toBe(true);
      const invalidReservation = {
        ...request,
        assessmentDigest: 'b'.repeat(64),
        evaluatedAt: 'not-an-instant',
        operation: 'RESERVE' as const,
        reason: 'Retire Market',
        sourceEvidence: [sourceEvidence],
      };
      const actionExit = yield* Effect.exit(
        executeReserveMarketRetirementWithAuthorization(invalidReservation, 'credential', 'correlation', {
          idempotencyKey: 'idempotency-key',
        }),
      );
      expect(Exit.isFailure(actionExit)).toBe(true);
      expect(executeMarketAffectedUseAssessment).toBeTypeOf('function');
      expect(executeReserveMarketRetirement).toBeTypeOf('function');
    }),
  );
});
