import { PricingMaterialEvidenceUnverifiableFailure } from '@app/pricing-contracts/domain/material-evidence';
import {
  PricingSourceEvidenceResultSchema,
  PricingSourceEvidenceVerifiedPresentSchema,
} from '@app/pricing-contracts/domain/source-revision-evidence';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingMaterialEvidenceChangedAtFinalFence,
  PricingMaterialEvidenceOwnerFinalFence,
  verifyPricingMaterialEvidenceOwnerFence,
} from '../../src/services/material-evidence-final-validation.service.ts';
import type {
  PricingMaterialEvidenceFenceExpectation,
  PricingMaterialEvidenceFenceSourceObservation,
  PricingMaterialEvidenceOwnerFencePort,
} from '../../src/services/material-evidence-final-validation.service.ts';

const evidenceObservedAt = '2026-09-28T12:00:00.100Z';
const laterCallerRevalidatedAt = '2026-09-28T12:00:10.000Z';
const finalOwnerObservedAt = '2026-09-28T12:00:10.100Z';

const sourceAtRevisionA = Schema.decodeSync(PricingSourceEvidenceVerifiedPresentSchema, {
  onExcessProperty: 'error',
})({
  _tag: 'VERIFIED_PRESENT',
  completeness: {
    completenessEvidence: {
      observedAt: evidenceObservedAt,
      ownerRevision: 'price-set-revision-a',
      scope: { kind: 'EXACT_PREDICATE', predicateRef: 'price:exact:tenant-786:variant-786:EUR' },
    },
    currencyCode: 'EUR',
    family: 'PRICE',
    ownerScope: {
      ownerModuleId: 'commerce.pricing',
      ownerRootRef: 'pricing:price-root:tenant-786',
      predicateRef: 'price:exact:tenant-786:variant-786:EUR',
      tenantId: 'tenant-786',
    },
    ownerSetRevisionRef: 'price-set-revision-a',
    temporal: {
      effectiveAt: '2026-09-28T12:00:00.000Z',
      evaluatedAt: '2026-09-28T12:00:00.050Z',
      evaluationMode: 'CURRENT_AT_OWNER_EVALUATION',
      observedAt: evidenceObservedAt,
      requestedAt: '2026-09-28T12:00:00.000Z',
    },
    verification: {
      kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE',
      verificationRef: 'owner-proof:price-set:revision-a:generation-41',
    },
  },
  currentFacts: [
    {
      currencyCode: 'EUR',
      effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
      factRef: 'price:786',
      factRevisionRef: 'price-revision-a',
      family: 'PRICE',
      ownerScope: {
        ownerModuleId: 'commerce.pricing',
        ownerRootRef: 'pricing:price-root:tenant-786',
        predicateRef: 'price:exact:tenant-786:variant-786:EUR',
        tenantId: 'tenant-786',
      },
      temporal: {
        effectiveAt: '2026-09-28T12:00:00.000Z',
        evaluatedAt: '2026-09-28T12:00:00.050Z',
        evaluationMode: 'CURRENT_AT_OWNER_EVALUATION',
        observedAt: evidenceObservedAt,
        requestedAt: '2026-09-28T12:00:00.000Z',
      },
      verification: {
        kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE',
        verificationRef: 'owner-proof:price:revision-a',
      },
    },
  ],
  request: {
    currencyCode: 'EUR',
    effectiveAt: '2026-09-28T12:00:00.000Z',
    family: 'PRICE',
    ownerScope: {
      ownerModuleId: 'commerce.pricing',
      ownerRootRef: 'pricing:price-root:tenant-786',
      predicateRef: 'price:exact:tenant-786:variant-786:EUR',
      tenantId: 'tenant-786',
    },
    requestedAt: '2026-09-28T12:00:00.000Z',
  },
});

const unchangedObservation = (
  expectation: PricingMaterialEvidenceFenceExpectation,
  observedAt = finalOwnerObservedAt,
): PricingMaterialEvidenceFenceSourceObservation => ({
  currencyCode: expectation.currencyCode,
  currentFacts: expectation.currentFacts,
  currentInvalidationGenerationRef: `owner-generation:${expectation.evidenceVerificationRef}`,
  currentOwnerSetRevisionRef: expectation.ownerSetRevisionRef,
  evidenceInvalidationGenerationRef: `owner-generation:${expectation.evidenceVerificationRef}`,
  evidenceVerificationRef: expectation.evidenceVerificationRef,
  family: expectation.family,
  observedAt,
  ownerModuleId: expectation.ownerModuleId,
  ownerRootRef: expectation.ownerRootRef,
  predicateRef: expectation.predicateRef,
  tenantId: expectation.tenantId,
});

const externalSource = (input: {
  readonly family: 'COMMERCIAL_CONTEXT' | 'PROMOTION';
  readonly observedAt: string;
  readonly ownerModuleId: string;
  readonly suffix: string;
}) => {
  const predicateRef = `${input.ownerModuleId}:predicate:${input.suffix}`;
  const ownerScope = {
    ownerModuleId: input.ownerModuleId,
    ownerRootRef: `${input.ownerModuleId}:root:tenant-786`,
    predicateRef,
    tenantId: 'tenant-786',
  };
  const temporal = {
    effectiveAt: '2026-09-28T12:00:00.000Z',
    evaluatedAt: input.observedAt,
    evaluationMode: 'CURRENT_AT_OWNER_EVALUATION' as const,
    nextMaterialBoundary: '2026-09-28T13:00:00.000Z',
    observedAt: input.observedAt,
    requestedAt: '2026-09-28T12:00:00.000Z',
  };
  const ownerSetRevisionRef = `${input.ownerModuleId}:set:${input.suffix}`;
  const request = {
    effectiveAt: '2026-09-28T12:00:00.000Z',
    family: input.family,
    ownerScope,
    requestedAt: '2026-09-28T12:00:00.000Z',
  };
  return Schema.decodeSync(PricingSourceEvidenceVerifiedPresentSchema, {
    onExcessProperty: 'error',
  })({
    _tag: 'VERIFIED_PRESENT',
    completeness: {
      completenessEvidence: {
        nextApplicabilityBoundary: temporal.nextMaterialBoundary,
        observedAt: input.observedAt,
        ownerRevision: ownerSetRevisionRef,
        scope: { kind: 'EXACT_PREDICATE', predicateRef },
      },
      family: input.family,
      ownerScope,
      ownerSetRevisionRef,
      temporal,
      verification: {
        kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE',
        verificationRef: `${input.ownerModuleId}:proof:set:${input.suffix}`,
      },
    },
    currentFacts: [
      {
        effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
        factRef: `${input.ownerModuleId}:fact:${input.suffix}`,
        factRevisionRef: `${input.ownerModuleId}:revision:${input.suffix}`,
        family: input.family,
        ownerScope,
        temporal,
        verification: {
          kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE',
          verificationRef: `${input.ownerModuleId}:proof:fact:${input.suffix}`,
        },
      },
    ],
    request,
  });
};

const ownerFence = (
  observe: (expectation: PricingMaterialEvidenceFenceExpectation) => ReturnType<typeof unchangedObservation>,
): PricingMaterialEvidenceOwnerFencePort => ({
  verifyImmediatelyBeforePublication: ({ sources }) => {
    const [expectation] = sources;
    if (expectation === undefined) {
      return Effect.fail(
        new PricingMaterialEvidenceUnverifiableFailure({
          candidateRef: 'candidate-786',
          reason: 'Test owner received no material source',
          retryable: false,
        }),
      );
    }
    return Effect.succeed({
      fenceRef: 'pricing-owner-fence:786',
      observedAt: finalOwnerObservedAt,
      sources: [observe(expectation)],
    });
  },
});

describe('Pricing material-evidence final owner fence #786', () => {
  it.effect('fences one owner set when repeated material usage retains the same exact proof', () =>
    Effect.gen(function* deduplicatesEquivalentProofs() {
      let receivedSourceCount = 0;
      const fence: PricingMaterialEvidenceOwnerFencePort = {
        verifyImmediatelyBeforePublication: ({ sources }) => {
          receivedSourceCount = sources.length;
          const [expectation] = sources;
          if (expectation === undefined) {
            return Effect.fail(
              new PricingMaterialEvidenceUnverifiableFailure({
                candidateRef: 'candidate-786',
                reason: 'Test owner received no material source',
                retryable: false,
              }),
            );
          }
          return Effect.succeed({
            fenceRef: 'deduplicated-owner-fence:786',
            observedAt: finalOwnerObservedAt,
            sources: [unchangedObservation(expectation)],
          });
        },
      };

      const result = yield* verifyPricingMaterialEvidenceOwnerFence('candidate-786', [
        sourceAtRevisionA,
        sourceAtRevisionA,
      ]).pipe(Effect.provideService(PricingMaterialEvidenceOwnerFinalFence, fence));

      expect(receivedSourceCount).toBe(1);
      expect(result.sources).toHaveLength(1);
    }),
  );

  it.effect('rejects conflicting proof meaning that reuses one opaque verification reference', () =>
    Effect.gen(function* rejectsConflictingProofReuse() {
      const conflictingSource = yield* Schema.decodeEffect(PricingSourceEvidenceResultSchema, {
        onExcessProperty: 'error',
      })({
        ...sourceAtRevisionA,
        currentFacts: sourceAtRevisionA.currentFacts.map((fact) => ({
          ...fact,
          factRevisionRef: 'price-revision-conflicting',
        })),
      });
      let invoked = false;
      const fence: PricingMaterialEvidenceOwnerFencePort = {
        verifyImmediatelyBeforePublication: () => {
          invoked = true;
          return Effect.die('Conflicting proof reuse must fail before invoking an owner gateway');
        },
      };

      const failure = yield* verifyPricingMaterialEvidenceOwnerFence('candidate-786', [
        sourceAtRevisionA,
        conflictingSource,
      ]).pipe(Effect.provideService(PricingMaterialEvidenceOwnerFinalFence, fence), Effect.flip);

      expect(invoked).toBe(false);
      expect(failure).toBeInstanceOf(PricingMaterialEvidenceUnverifiableFailure);
      expect(failure.reason).toContain('conflicting material proofs');
    }),
  );

  it.effect('accepts ordinary owner latency and does not special-case a generalized currency', () =>
    Effect.gen(function* acceptsOwnerLatency() {
      const result = yield* verifyPricingMaterialEvidenceOwnerFence('candidate-786', [sourceAtRevisionA]).pipe(
        Effect.provideService(PricingMaterialEvidenceOwnerFinalFence, ownerFence(unchangedObservation)),
      );

      expect(result.observedAt).toBe(finalOwnerObservedAt);
      expect(result.sources[0]?.currencyCode).toBe('EUR');
    }),
  );

  it.effect('authorizes unchanged Catalog, Market, Group and Promotion owners with distinct observation latency', () =>
    Effect.gen(function* acceptsDistinctOwnerObservations() {
      const sources = [
        externalSource({
          family: 'COMMERCIAL_CONTEXT',
          observedAt: '2026-09-28T12:00:00.100Z',
          ownerModuleId: 'commerce.catalog',
          suffix: 'catalog',
        }),
        externalSource({
          family: 'COMMERCIAL_CONTEXT',
          observedAt: '2026-09-28T12:00:00.200Z',
          ownerModuleId: 'commerce.market-catalog',
          suffix: 'market',
        }),
        externalSource({
          family: 'COMMERCIAL_CONTEXT',
          observedAt: '2026-09-28T12:00:00.300Z',
          ownerModuleId: 'commerce.customer-context',
          suffix: 'group',
        }),
        externalSource({
          family: 'PROMOTION',
          observedAt: '2026-09-28T12:00:00.400Z',
          ownerModuleId: 'commerce.promotion',
          suffix: 'promotion',
        }),
      ];
      const ownerObservationByModule = new Map([
        ['commerce.catalog', '2026-09-28T12:00:10.100Z'],
        ['commerce.market-catalog', '2026-09-28T12:00:10.200Z'],
        ['commerce.customer-context', '2026-09-28T12:00:10.300Z'],
        ['commerce.promotion', '2026-09-28T12:00:10.400Z'],
      ]);
      const fence: PricingMaterialEvidenceOwnerFencePort = {
        verifyImmediatelyBeforePublication: ({ sources: expectations }) =>
          Effect.succeed({
            fenceRef: 'multi-owner-publication-fence:786',
            observedAt: '2026-09-28T12:00:10.500Z',
            sources: expectations.map((expectation) =>
              unchangedObservation(
                expectation,
                ownerObservationByModule.get(expectation.ownerModuleId) ?? '2026-09-28T12:00:10.450Z',
              ),
            ),
          }),
      };

      const result = yield* verifyPricingMaterialEvidenceOwnerFence('candidate-786', sources).pipe(
        Effect.provideService(PricingMaterialEvidenceOwnerFinalFence, fence),
      );

      expect(result.observedAt).toBe('2026-09-28T12:00:10.500Z');
      expect(result.sources.map(({ observedAt }) => observedAt)).toEqual([
        '2026-09-28T12:00:10.100Z',
        '2026-09-28T12:00:10.200Z',
        '2026-09-28T12:00:10.300Z',
        '2026-09-28T12:00:10.400Z',
      ]);
    }),
  );

  it.effect('rejects revision A after B is inserted even when a caller supplies a later revalidatedAt', () =>
    Effect.gen(function* rejectsInterveningMutation() {
      expect(laterCallerRevalidatedAt > evidenceObservedAt).toBe(true);
      const failure = yield* verifyPricingMaterialEvidenceOwnerFence('candidate-786', [sourceAtRevisionA]).pipe(
        Effect.provideService(
          PricingMaterialEvidenceOwnerFinalFence,
          ownerFence((expectation) => ({
            ...unchangedObservation(expectation),
            currentFacts: [
              ...expectation.currentFacts,
              {
                factRef: 'price:786-b',
                factRevisionRef: 'price-revision-b',
                verificationRef: 'owner-proof:price:revision-b',
              },
            ],
            currentInvalidationGenerationRef: 'price-generation-42',
            currentOwnerSetRevisionRef: 'price-set-revision-b',
          })),
        ),
        Effect.flip,
      );

      expect(failure).toBeInstanceOf(PricingMaterialEvidenceChangedAtFinalFence);
      expect(failure).toMatchObject({
        family: 'PRICE',
        predicateRef: 'price:exact:tenant-786:variant-786:EUR',
        retryable: true,
      });
    }),
  );
});
