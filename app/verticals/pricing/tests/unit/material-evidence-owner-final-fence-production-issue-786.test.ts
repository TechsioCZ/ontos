import { PricingMaterialEvidenceUnverifiableFailure } from '@app/pricing-contracts/domain/material-evidence';
import { PricingSourceEvidenceVerifiedPresentSchema } from '@app/pricing-contracts/domain/source-revision-evidence';
import { Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingCatalogMaterialEvidenceFenceGateway,
  PricingCustomerContextMaterialEvidenceFenceGateway,
  PricingMarketMaterialEvidenceFenceGateway,
  PricingOwnerMaterialEvidenceFenceGatewayUnavailable,
  PricingPricingMaterialEvidenceFenceGateway,
  PricingPromotionMaterialEvidenceFenceGateway,
  makePricingMaterialEvidenceOwnerFinalFence,
} from '../../src/integrations/material-evidence-owner-final-fence.ts';
import type {
  PricingOwnerMaterialEvidenceGenerationConfirmation,
  PricingOwnerMaterialEvidenceFenceGateway,
  PricingOwnerMaterialEvidenceFenceGatewayResult,
} from '../../src/integrations/material-evidence-owner-final-fence.ts';
import {
  PricingMaterialEvidenceChangedAtFinalFence,
  PricingMaterialEvidenceOwnerFinalFence,
  verifyPricingMaterialEvidenceOwnerFence,
} from '../../src/services/material-evidence-final-validation.service.ts';
import type {
  PricingMaterialEvidenceFenceExpectation,
  PricingMaterialEvidenceFenceSourceObservation,
} from '../../src/services/material-evidence-final-validation.service.ts';

const requestedAt = '2026-09-28T12:00:00.000Z';
const nextMaterialBoundary = '2026-09-28T13:00:00.000Z';

const sourceFor = (
  ownerModuleId: string,
  family: 'COMMERCIAL_CONTEXT' | 'PRICE' | 'PROMOTION',
  observedAt: string,
  suffix: string,
) => {
  const predicateRef = `${ownerModuleId}:predicate:${suffix}`;
  const ownerScope = {
    ownerModuleId,
    ownerRootRef: `${ownerModuleId}:root:tenant-786`,
    predicateRef,
    tenantId: 'tenant-786',
  };
  const temporal = {
    effectiveAt: requestedAt,
    evaluatedAt: observedAt,
    evaluationMode: 'CURRENT_AT_OWNER_EVALUATION' as const,
    nextMaterialBoundary,
    observedAt,
    requestedAt,
  };
  const ownerSetRevisionRef = `${ownerModuleId}:set:${suffix}:a`;
  return Schema.decodeSync(PricingSourceEvidenceVerifiedPresentSchema, {
    onExcessProperty: 'error',
  })({
    _tag: 'VERIFIED_PRESENT',
    completeness: {
      completenessEvidence: {
        nextApplicabilityBoundary: nextMaterialBoundary,
        observedAt,
        ownerRevision: ownerSetRevisionRef,
        scope: { kind: 'EXACT_PREDICATE', predicateRef },
      },
      family,
      ownerScope,
      ownerSetRevisionRef,
      temporal,
      verification: {
        kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE',
        verificationRef: `${ownerModuleId}:proof:set:${suffix}:a`,
      },
    },
    currentFacts: [
      {
        effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
        factRef: `${ownerModuleId}:fact:${suffix}`,
        factRevisionRef: `${ownerModuleId}:revision:${suffix}:a`,
        family,
        ownerScope,
        temporal,
        verification: {
          kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE',
          verificationRef: `${ownerModuleId}:proof:fact:${suffix}:a`,
        },
      },
    ],
    request: { effectiveAt: requestedAt, family, ownerScope, requestedAt },
  });
};

const observationFor = (expectation: PricingMaterialEvidenceFenceExpectation, observedAt: string) => ({
  currencyCode: expectation.currencyCode,
  currentFacts: expectation.currentFacts,
  currentInvalidationGenerationRef: `generation:${expectation.evidenceVerificationRef}`,
  currentOwnerSetRevisionRef: expectation.ownerSetRevisionRef,
  evidenceInvalidationGenerationRef: `generation:${expectation.evidenceVerificationRef}`,
  evidenceVerificationRef: expectation.evidenceVerificationRef,
  family: expectation.family,
  observedAt,
  ownerModuleId: expectation.ownerModuleId,
  ownerRootRef: expectation.ownerRootRef,
  predicateRef: expectation.predicateRef,
  tenantId: expectation.tenantId,
});

const confirmationFor = (
  observation: PricingMaterialEvidenceFenceSourceObservation,
): PricingOwnerMaterialEvidenceGenerationConfirmation => ({
  currentFacts: observation.currentFacts,
  currentInvalidationGenerationRef: observation.currentInvalidationGenerationRef,
  currentOwnerSetRevisionRef: observation.currentOwnerSetRevisionRef,
  evidenceInvalidationGenerationRef: observation.evidenceInvalidationGenerationRef,
  evidenceVerificationRef: observation.evidenceVerificationRef,
});

const gateway = (
  observedAt: string,
  completedAt: string,
  phaseOneChange?: (expectation: PricingMaterialEvidenceFenceExpectation) => ReturnType<typeof observationFor>,
  generationChange?: (
    observation: PricingMaterialEvidenceFenceSourceObservation,
  ) => PricingOwnerMaterialEvidenceGenerationConfirmation,
): PricingOwnerMaterialEvidenceFenceGateway => ({
  confirmObservedGenerationsThrough: ({ observations, through }) =>
    Effect.succeed({
      confirmations: observations.map((observation) =>
        generationChange === undefined ? confirmationFor(observation) : generationChange(observation),
      ),
      verifiedThrough: through,
    }),
  verifyOpaqueProofsAgainstCurrentState: ({ sources }): Effect.Effect<PricingOwnerMaterialEvidenceFenceGatewayResult> =>
    Effect.succeed({
      completedAt,
      observations: sources.map((expectation) =>
        phaseOneChange === undefined ? observationFor(expectation, observedAt) : phaseOneChange(expectation),
      ),
    }),
});

const ownerLayers = (overrides?: {
  readonly catalog?: PricingOwnerMaterialEvidenceFenceGateway;
  readonly promotion?: PricingOwnerMaterialEvidenceFenceGateway;
}) =>
  Layer.mergeAll(
    Layer.succeed(
      PricingPricingMaterialEvidenceFenceGateway,
      gateway('2026-09-28T12:00:10.100Z', '2026-09-28T12:00:10.150Z'),
    ),
    Layer.succeed(
      PricingCatalogMaterialEvidenceFenceGateway,
      overrides?.catalog ?? gateway('2026-09-28T12:00:10.200Z', '2026-09-28T12:00:10.250Z'),
    ),
    Layer.succeed(
      PricingMarketMaterialEvidenceFenceGateway,
      gateway('2026-09-28T12:00:10.300Z', '2026-09-28T12:00:10.350Z'),
    ),
    Layer.succeed(
      PricingCustomerContextMaterialEvidenceFenceGateway,
      gateway('2026-09-28T12:00:10.400Z', '2026-09-28T12:00:10.450Z'),
    ),
    Layer.succeed(
      PricingPromotionMaterialEvidenceFenceGateway,
      overrides?.promotion ?? gateway('2026-09-28T12:00:10.500Z', '2026-09-28T12:00:10.550Z'),
    ),
  );

const live = (overrides?: Parameters<typeof ownerLayers>[0]) =>
  Layer.effect(PricingMaterialEvidenceOwnerFinalFence, makePricingMaterialEvidenceOwnerFinalFence('revision:786')).pipe(
    Layer.provide(ownerLayers(overrides)),
  );

const sources = [
  sourceFor('commerce.pricing', 'PRICE', '2026-09-28T12:00:00.100Z', 'price'),
  sourceFor('commerce.catalog', 'COMMERCIAL_CONTEXT', '2026-09-28T12:00:00.200Z', 'catalog'),
  sourceFor('commerce.market-catalog', 'COMMERCIAL_CONTEXT', '2026-09-28T12:00:00.300Z', 'market'),
  sourceFor('commerce.customer-context', 'COMMERCIAL_CONTEXT', '2026-09-28T12:00:00.400Z', 'group'),
  sourceFor('commerce.promotion', 'PROMOTION', '2026-09-28T12:00:00.500Z', 'promotion'),
];

describe('Pricing material-evidence production owner fence #786', () => {
  it.layer(live())((test) => {
    test.effect('executes the Live five-owner composition and preserves distinct owner timestamps', () =>
      Effect.gen(function* unchangedStateSucceeds() {
        const result = yield* verifyPricingMaterialEvidenceOwnerFence('candidate-786', sources);

        expect(result.observedAt).toBe('2026-09-28T12:00:10.550Z');
        expect(result.sources.map(({ observedAt }) => observedAt)).toEqual([
          '2026-09-28T12:00:10.100Z',
          '2026-09-28T12:00:10.200Z',
          '2026-09-28T12:00:10.300Z',
          '2026-09-28T12:00:10.400Z',
          '2026-09-28T12:00:10.500Z',
        ]);
      }),
    );
  });

  const changedCatalog = gateway('2026-09-28T12:00:10.200Z', '2026-09-28T12:00:10.250Z', undefined, (observation) => ({
    ...confirmationFor(observation),
    currentFacts: [
      ...observation.currentFacts,
      {
        factRef: 'commerce.catalog:fact:catalog-b',
        factRevisionRef: 'commerce.catalog:revision:catalog-b',
        verificationRef: 'commerce.catalog:proof:fact:catalog-b',
      },
    ],
    currentInvalidationGenerationRef: 'commerce.catalog:generation:b-at-12:00:10.350Z',
    currentOwnerSetRevisionRef: 'commerce.catalog:set:catalog:b',
  }));
  it.layer(live({ catalog: changedCatalog }))((test) => {
    test.effect('fails retryably when Catalog changes from A after t1 before slow Promotion completes at t2', () =>
      Effect.gen(function* changedStateFails() {
        const failure = yield* verifyPricingMaterialEvidenceOwnerFence('candidate-786', sources).pipe(Effect.flip);

        expect(failure).toBeInstanceOf(PricingMaterialEvidenceChangedAtFinalFence);
        expect(failure).toMatchObject({
          family: 'COMMERCIAL_CONTEXT',
          predicateRef: 'commerce.catalog:predicate:catalog',
          retryable: true,
        });
      }),
    );
  });

  const unavailablePromotion: PricingOwnerMaterialEvidenceFenceGateway = {
    confirmObservedGenerationsThrough: () =>
      Effect.fail(
        new PricingOwnerMaterialEvidenceFenceGatewayUnavailable({
          ownerModuleId: 'commerce.promotion',
          reason: 'Promotion owner generation confirmation timed out',
          retryable: true,
        }),
      ),
    verifyOpaqueProofsAgainstCurrentState: () =>
      Effect.fail(
        new PricingOwnerMaterialEvidenceFenceGatewayUnavailable({
          ownerModuleId: 'commerce.promotion',
          reason: 'Promotion owner read timed out',
          retryable: true,
        }),
      ),
  };
  it.layer(live({ promotion: unavailablePromotion }))((test) => {
    test.effect('maps a Promotion owner outage to a typed retryable publication failure', () =>
      Effect.gen(function* ownerOutageFailsTyped() {
        const failure = yield* verifyPricingMaterialEvidenceOwnerFence('candidate-786', sources).pipe(Effect.flip);

        expect(failure).toBeInstanceOf(PricingMaterialEvidenceUnverifiableFailure);
        expect(failure).toMatchObject({
          family: 'PROMOTION',
          predicateRef: 'commerce.promotion:predicate:promotion',
          retryable: true,
        });
        expect(failure.cause).toBeInstanceOf(PricingOwnerMaterialEvidenceFenceGatewayUnavailable);
      }),
    );
  });
});
