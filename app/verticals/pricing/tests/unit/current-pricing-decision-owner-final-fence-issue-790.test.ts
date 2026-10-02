import { Context, Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { CurrentSupportedCurrenciesSuccessSchema } from '@app/pricing-contracts/current-supported-currencies';
import { PricingMaterialEvidenceFenceSourceSchema } from '@app/pricing-contracts/domain/material-evidence';
import type {
  PricingMaterialEvidenceFenceSource,
  PricingOwnerMaterialEvidenceFenceGatewayRequest,
} from '@app/pricing-contracts/domain/material-evidence';
import { PricingSourceEvidenceVerifiedPresentSchema } from '@app/pricing-contracts/domain/source-revision-evidence';
import {
  PricingContractualDiscountCurrentSetSchema,
  PricingContractualDiscountResolvedProofSchema,
  PricingContractualDiscountSetPredicateSchema,
  pricingContractualDiscountSetPredicateRef,
} from '@app/pricing-contracts/domain/contractual-discount-set';
import { ActiveApplicationCompositionService, ActiveApplicationCompositionUnavailableError } from '@app/core-runtime';
import { PrincipalIdSchema } from '@app/core-runtime/auth/external-identity-contracts';

import {
  makePricingCurrentDecisionPricingOwnerFinalFenceGateway,
  makePricingCurrentDecisionOwnerFinalFenceGatewaysLive,
  pricingCurrentDecisionOwnerFinalFenceGatewaysLive,
} from '../../src/integrations/current-pricing-decision-owner-final-fence.ts';
import {
  PricingCatalogMaterialEvidenceFenceGateway,
  PricingCustomerContextMaterialEvidenceFenceGateway,
  PricingMarketMaterialEvidenceFenceGateway,
  PricingOwnerMaterialEvidenceFenceGatewayUnavailable,
  PricingPricingMaterialEvidenceFenceGateway,
  PricingPromotionMaterialEvidenceFenceGateway,
  pricingMaterialEvidenceOwnerFinalFenceLive,
  makePricingMaterialEvidenceOwnerFinalFenceFromGateways,
} from '../../src/integrations/material-evidence-owner-final-fence.ts';
import type {
  PricingMaterialEvidenceOwnerModule,
  PricingOwnerMaterialEvidenceGenerationConfirmation,
  PricingOwnerMaterialEvidenceFenceGateway,
} from '../../src/integrations/material-evidence-owner-final-fence.ts';
import { PricingMaterialEvidenceOwnerFinalFence } from '../../src/services/material-evidence-final-validation.service.ts';
import type { PricingMaterialEvidenceFenceExpectation } from '../../src/services/material-evidence-final-validation.service.ts';
import {
  ReadCurrentQuantityTierSetPersistenceOutcomeSchema,
  ResolveQuantityTierSetProofPersistenceOutcomeSchema,
} from '../../src/services/quantity-tier-persistence.service.ts';
import { makeIssue787Snapshot } from './support/issue-787-material-change.fixture.ts';

const services = [
  ['commerce.pricing', PricingPricingMaterialEvidenceFenceGateway],
  ['commerce.catalog', PricingCatalogMaterialEvidenceFenceGateway],
  ['commerce.market-catalog', PricingMarketMaterialEvidenceFenceGateway],
  ['commerce.customer-context', PricingCustomerContextMaterialEvidenceFenceGateway],
  ['commerce.promotion', PricingPromotionMaterialEvidenceFenceGateway],
] as const;

const forbiddenOwnerPersistence = () => Effect.die('Unrelated owner persistence was called');

const assertUnavailable = (
  ownerModuleId: PricingMaterialEvidenceOwnerModule,
  gateway: PricingOwnerMaterialEvidenceFenceGateway,
) =>
  Effect.gen(function* rejectsWithoutFabrication() {
    const verificationFailure = yield* gateway
      .verifyOpaqueProofsAgainstCurrentState({ candidateRef: 'candidate:790', sources: [] })
      .pipe(Effect.flip);
    const generationFailure = yield* gateway
      .confirmObservedGenerationsThrough({
        candidateRef: 'candidate:790',
        observations: [],
        through: '2026-09-28T12:00:00.000Z',
      })
      .pipe(Effect.flip);

    for (const failure of [verificationFailure, generationFailure]) {
      expect(failure).toBeInstanceOf(PricingOwnerMaterialEvidenceFenceGatewayUnavailable);
      expect(failure).toMatchObject({ ownerModuleId, retryable: true });
      expect(failure.reason).not.toMatch(/verified|succeeded|fallback/iu);
      expect(failure).not.toHaveProperty('completedAt');
      expect(failure).not.toHaveProperty('observations');
      expect(failure).not.toHaveProperty('confirmations');
      expect(failure).not.toHaveProperty('verifiedThrough');
    }
  });

const familyFor = (
  ownerModuleId: PricingMaterialEvidenceOwnerModule,
): PricingMaterialEvidenceFenceExpectation['family'] => {
  if (ownerModuleId === 'commerce.promotion') {
    return 'PROMOTION';
  }
  if (ownerModuleId === 'commerce.pricing') {
    return 'PRICE';
  }
  return 'COMMERCIAL_CONTEXT';
};

const expectations: readonly PricingMaterialEvidenceFenceExpectation[] = services.map(
  ([ownerModuleId], index): PricingMaterialEvidenceFenceExpectation => ({
    currentFacts: [
      {
        factRef: `${ownerModuleId}:fact:${index}`,
        factRevisionRef: `${ownerModuleId}:revision:${index}`,
        verificationRef: `${ownerModuleId}:fact-proof:${index}`,
      },
    ],
    evidenceObservedAt: `2026-09-28T12:00:0${index}.000Z`,
    evidenceVerificationRef: `${ownerModuleId}:set-proof:${index}`,
    family: familyFor(ownerModuleId),
    nextMaterialBoundary: '2026-09-28T12:01:00.000Z',
    ownerModuleId,
    ownerRootRef: `${ownerModuleId}:root:${index}`,
    ownerSetRevisionRef: `${ownerModuleId}:set-revision:${index}`,
    predicateRef: `${ownerModuleId}:predicate:${index}`,
    tenantId: '10000000-0000-4000-8000-000000000001',
  }),
);

const successfulGateway = (completedAt: string): PricingOwnerMaterialEvidenceFenceGateway => ({
  confirmObservedGenerationsThrough: ({ observations, through }) =>
    Effect.succeed({
      confirmations: observations.map((observation): PricingOwnerMaterialEvidenceGenerationConfirmation => ({
        currentFacts: observation.currentFacts,
        currentInvalidationGenerationRef: observation.currentInvalidationGenerationRef,
        currentOwnerSetRevisionRef: observation.currentOwnerSetRevisionRef,
        evidenceInvalidationGenerationRef: observation.evidenceInvalidationGenerationRef,
        evidenceVerificationRef: observation.evidenceVerificationRef,
      })),
      verifiedThrough: through,
    }),
  verifyOpaqueProofsAgainstCurrentState: ({ sources }) =>
    Effect.succeed({
      completedAt,
      observations: sources.map((source) => ({
        currencyCode: source.currencyCode,
        currentFacts: source.currentFacts,
        currentInvalidationGenerationRef: `generation:${source.evidenceVerificationRef}`,
        currentOwnerSetRevisionRef: source.ownerSetRevisionRef,
        evidenceInvalidationGenerationRef: `generation:${source.evidenceVerificationRef}`,
        evidenceVerificationRef: source.evidenceVerificationRef,
        family: source.family,
        observedAt: source.evidenceObservedAt,
        ownerModuleId: source.ownerModuleId,
        ownerRootRef: source.ownerRootRef,
        predicateRef: source.predicateRef,
        tenantId: source.tenantId,
      })),
    }),
});

describe('Current Pricing Decision production owner final-fence adapters #790', () => {
  it.effect('accepts a fresh Tier receipt and verifies the original proof through completion', () => {
    const tenantId = '10000000-0000-4000-8000-000000000001';
    const effectiveAt = '2026-09-28T08:58:00.000Z';
    const originalAt = '2026-09-28T08:59:00.000Z';
    const freshAt = '2026-09-28T09:00:00.000Z';
    const through = '2026-09-28T09:01:00.000Z';
    const priceRef = {
      moduleId: 'commerce.pricing',
      resourceId: '10000000-0000-4000-8000-000000000002',
      resourceType: 'commerce.pricing.price',
      tenantId,
    } as const;
    const authority = {
      generation: 7,
      observedAt: originalAt,
      ownerRevision: 'tier-set:7',
      ownerRootRef: `tier-set:${priceRef.resourceId}`,
      predicateRef: `tier-set:${priceRef.resourceId}:current`,
      verificationRef: 'tier-proof:original',
    };
    const productRef = {
      moduleId: 'commerce.catalog' as const,
      resourceId: '10000000-0000-4000-8000-000000000003',
      resourceType: 'commerce.catalog.product' as const,
      tenantId,
    };
    const variantRef = {
      moduleId: 'commerce.catalog' as const,
      resourceId: '10000000-0000-4000-8000-000000000004',
      resourceType: 'commerce.catalog.variant' as const,
      tenantId,
    };
    const unitRef = {
      moduleId: 'commerce.catalog' as const,
      resourceId: '10000000-0000-4000-8000-000000000005',
      resourceType: 'commerce.catalog.product-unit' as const,
      tenantId,
    };
    const quantityBasis = {
      catalogQuantityBasis: {
        targetDivisibilityRevision: 1,
        targetRef: variantRef,
        unitRef,
        unitRuleRevision: 1,
      },
      priceUnitBasis: { quantity: '1', unitRef },
    };
    const tierRevisionId = '10000000-0000-4000-8000-000000000006';
    const currentTier = {
      definition: {
        identityKey: { priceRef, quantityBasis, thresholdQuantity: '10' },
        revision: {
          effectiveFrom: effectiveAt,
          monetaryBoundary: 'PRE_TAX' as const,
          resultingUnitPrice: { amount: '90', currencyCode: 'CZK' as const },
          revision: 1,
          revisionId: tierRevisionId,
        },
      },
      effectivePeriod: { effectiveFrom: effectiveAt, effectiveTo: null },
      lineage: { correctedRevisionId: null, kind: 'INITIAL' as const, previousRevisionId: null },
    };
    const factProofs = [
      { factRef: 'tier:1', factRevisionRef: tierRevisionId, verificationRef: authority.verificationRef },
    ];
    const completenessEvidence = {
      observedAt: originalAt,
      ownerRevision: authority.ownerRevision,
      scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: authority.predicateRef },
    };
    const tierSet = { authority, completenessEvidence, currentTiers: [currentTier], factProofs, priceRef };
    const ownerScope = {
      ownerModuleId: 'commerce.pricing',
      ownerRootRef: authority.ownerRootRef,
      predicateRef: authority.predicateRef,
      tenantId,
    };
    const temporal = {
      effectiveAt,
      evaluatedAt: originalAt,
      evaluationMode: 'CURRENT_AT_OWNER_EVALUATION' as const,
      observedAt: originalAt,
      requestedAt: effectiveAt,
    };
    const source = Schema.decodeUnknownSync(PricingMaterialEvidenceFenceSourceSchema)({
      sourceEvidence: {
        _tag: 'VERIFIED_PRESENT',
        completeness: {
          completenessEvidence,
          currencyCode: 'CZK',
          family: 'QUANTITY_TIER',
          ownerScope,
          ownerSetRevisionRef: authority.ownerRevision,
          temporal,
          verification: {
            kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE',
            verificationRef: authority.verificationRef,
          },
        },
        currentFacts: factProofs.map((fact) => ({
          currencyCode: 'CZK',
          effectivePeriod: currentTier.effectivePeriod,
          factRef: fact.factRef,
          factRevisionRef: fact.factRevisionRef,
          family: 'QUANTITY_TIER',
          ownerScope,
          temporal,
          verification: { kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE', verificationRef: fact.verificationRef },
        })),
        request: {
          currencyCode: 'CZK',
          effectiveAt,
          family: 'QUANTITY_TIER',
          ownerScope,
          requestedAt: effectiveAt,
        },
      },
      verificationMaterial: {
        kind: 'PRICING_QUANTITY_TIER_AUTHORITY',
        ownerReadReceipt: { authority, factProofs },
        selectionInput: {
          attempt: {
            evaluatedAt: originalAt,
            exactPrice: {
              path: { priceGroupSelector: { kind: 'NO_GROUP' }, requiredAbsenceEvidence: [] },
              price: {
                definition: {
                  identityKey: {
                    catalogSelection: { productRef, variantRef },
                    commercialScope: {
                      channelId: 'B2C',
                      marketId: 'cz-launch',
                      sellingLegalEntityId: '10000000-0000-4000-8000-000000000007',
                    },
                    currencyCode: 'CZK',
                    priceGroupSelector: { kind: 'NO_GROUP' },
                    unitBasis: { quantity: '1', unitRef },
                  },
                  priceRef,
                  revision: {
                    effectiveFrom: effectiveAt,
                    monetaryAmount: { amount: '100', currencyCode: 'CZK' },
                    monetaryBoundary: 'PRE_TAX',
                    revision: 1,
                    revisionId: '10000000-0000-4000-8000-000000000008',
                  },
                },
                effectivePeriod: { effectiveFrom: effectiveAt, effectiveTo: null },
                lineage: { correctedRevisionId: null, kind: 'INITIAL', previousRevisionId: null },
              },
              scheduleRevision: 1,
            },
            normalizedQuantity: { quantity: '10', quantityBasis },
            tierSetPriceRef: priceRef,
          },
          tierSet,
        },
      },
    });
    const freshAuthority = { ...authority, observedAt: freshAt, verificationRef: 'tier-proof:fresh' };
    const currentTierSet = Schema.decodeSync(ReadCurrentQuantityTierSetPersistenceOutcomeSchema)({
      authority: freshAuthority,
      outcome: 'QUANTITY_TIER_SET_CURRENT',
      tierSet: {
        ...tierSet,
        authority: freshAuthority,
        completenessEvidence: { ...tierSet.completenessEvidence, observedAt: freshAt },
        factProofs: factProofs.map((fact) => ({
          ...fact,
          verificationRef: freshAuthority.verificationRef,
        })),
      },
    });
    const originalTierSetProof = Schema.decodeSync(ResolveQuantityTierSetProofPersistenceOutcomeSchema)({
      authority,
      currentFacts: factProofs,
      outcome: 'QUANTITY_TIER_SET_PROOF_RESOLVED',
      tierSet,
    });
    const gateway = makePricingCurrentDecisionPricingOwnerFinalFenceGateway({
      currencySupport: {
        loadCurrent: forbiddenOwnerPersistence,
        resolveOriginalProof: forbiddenOwnerPersistence,
        verifyCurrentThrough: forbiddenOwnerPersistence,
      },
      discounts: {
        readCurrentSet: forbiddenOwnerPersistence,
        resolveOriginalSetProof: forbiddenOwnerPersistence,
        verifySetGeneration: forbiddenOwnerPersistence,
      },
      fees: { readCurrentSet: forbiddenOwnerPersistence, verifySetGeneration: forbiddenOwnerPersistence },
      prices: {
        readExactCandidateSet: forbiddenOwnerPersistence,
        verifyExactCandidateSetGeneration: forbiddenOwnerPersistence,
      },
      tiers: {
        readCurrentSet: () => Effect.succeed(currentTierSet),
        resolveQuantityTierSetProof: () => Effect.succeed(originalTierSetProof),
        verifySetGeneration: ({ through: verifiedThrough, verificationRef }) =>
          Effect.succeed({
            generation: 7,
            outcome: 'QUANTITY_TIER_SET_GENERATION_CURRENT',
            ownerRevision: authority.ownerRevision,
            ownerRootRef: authority.ownerRootRef,
            verificationRef,
            verifiedAt: freshAt,
            verifiedThrough,
          }),
      },
      zeroFloor: { readCurrentSet: forbiddenOwnerPersistence, verifyGeneration: forbiddenOwnerPersistence },
    });
    const expectation: PricingMaterialEvidenceFenceExpectation = {
      currencyCode: 'CZK',
      currentFacts: factProofs,
      evidenceObservedAt: originalAt,
      evidenceVerificationRef: authority.verificationRef,
      family: 'QUANTITY_TIER',
      ownerModuleId: 'commerce.pricing',
      ownerRootRef: authority.ownerRootRef,
      ownerSetRevisionRef: authority.ownerRevision,
      predicateRef: authority.predicateRef,
      tenantId,
    };
    const verificationContext = {
      candidateRef: 'candidate:790',
      decision: makeIssue787Snapshot({ operationTime: effectiveAt }).decision,
      effectiveAt,
      evaluatedAt: freshAt,
      requestedAt: effectiveAt,
    };
    return Effect.gen(function* verifiesTierGeneration() {
      const first = yield* gateway.verifyOpaqueProofsAgainstCurrentState({
        candidateRef: 'candidate:790',
        sources: [expectation],
        typedSources: [source],
        verificationContext,
      });
      expect(first.observations[0]).toMatchObject({
        currentInvalidationGenerationRef: '7',
        evidenceVerificationRef: authority.verificationRef,
        observedAt: freshAt,
      });
      const second = yield* gateway.confirmObservedGenerationsThrough({
        candidateRef: 'candidate:790',
        observations: first.observations,
        through,
        typedSources: [source],
        verificationContext,
      });
      expect(second.verifiedThrough).toBe(through);
    });
  });

  it.effect('rebinds an absent Discount set to durable proof and confirms its generation', () => {
    const tenantId = '10000000-0000-4000-8000-000000000001';
    const legalEntityId = '10000000-0000-4000-8000-000000000002';
    const effectiveAt = '2026-09-28T08:58:00.000Z';
    const originalAt = '2026-09-28T08:59:00.000Z';
    const freshAt = '2026-09-28T09:00:00.000Z';
    const through = '2026-09-28T09:01:00.000Z';
    const audience = {
      counterpartyRef: {
        moduleId: 'party.registry',
        resourceId: '10000000-0000-4000-8000-000000000003',
        resourceType: 'party.registry.counterparty',
        tenantId,
      },
      kind: 'COUNTERPARTY',
    } as const;
    const scope = { channelId: 'B2B', marketId: 'cz-launch', sellingLegalEntityId: legalEntityId } as const;
    const predicate = Schema.decodeSync(PricingContractualDiscountSetPredicateSchema)({
      audiences: [audience],
      basis: { kind: 'WHOLE_PURCHASE' },
      commercialScope: scope,
      currencyCode: 'CZK',
      effectiveAt,
      tenantId,
    });
    const predicateRef = pricingContractualDiscountSetPredicateRef(predicate);
    const samePredicate = Schema.toEquivalence(PricingContractualDiscountSetPredicateSchema);
    const rootRef = `pricing:contractual-discount-set:${tenantId}`;
    const revisionRef = 'contractual-discount-set:generation:9';
    const proofRef = `pricing:contractual-discount-set-proof:${predicateRef}`;
    const originalAuthority = {
      generation: 9,
      observedAt: originalAt,
      ownerRevision: revisionRef,
      ownerRootRef: rootRef,
      predicateRef,
      verificationRef: proofRef,
      verifiedAt: originalAt,
    };
    const original = Schema.decodeSync(PricingContractualDiscountResolvedProofSchema)({
      authority: originalAuthority,
      currentFacts: [],
      outcome: 'CONTRACTUAL_DISCOUNT_SET_PROOF_RESOLVED',
      predicate,
    });
    const current = Schema.decodeSync(PricingContractualDiscountCurrentSetSchema)({
      authority: {
        ...originalAuthority,
        observedAt: freshAt,
        verificationRef: `${proofRef}:fresh`,
        verifiedAt: freshAt,
      },
      completenessEvidence: {
        observedAt: freshAt,
        ownerRevision: revisionRef,
        scope: { kind: 'EXACT_PREDICATE', predicateRef },
      },
      currentDiscounts: [],
      factProofs: [],
      predicate,
    });
    const ownerScope = { ownerModuleId: 'commerce.pricing', ownerRootRef: rootRef, predicateRef, tenantId };
    const temporal = {
      effectiveAt,
      evaluatedAt: effectiveAt,
      evaluationMode: 'CURRENT_AT_OWNER_EVALUATION',
      observedAt: originalAt,
      requestedAt: effectiveAt,
    };
    const source = Schema.decodeUnknownSync(PricingMaterialEvidenceFenceSourceSchema)({
      sourceEvidence: {
        _tag: 'VERIFIED_ABSENT',
        completeness: {
          completenessEvidence: {
            observedAt: originalAt,
            ownerRevision: revisionRef,
            scope: { kind: 'EXACT_PREDICATE', predicateRef },
          },
          currencyCode: 'CZK',
          family: 'DISCOUNT',
          ownerScope,
          ownerSetRevisionRef: revisionRef,
          temporal,
          verification: { kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE', verificationRef: proofRef },
        },
        request: { currencyCode: 'CZK', effectiveAt, family: 'DISCOUNT', ownerScope, requestedAt: effectiveAt },
      },
      verificationMaterial: {
        applicabilityBindings: [],
        identityKeys: [],
        kind: 'PRICING_DISCOUNT_AUTHORITY',
        ownerReadReceipt: {
          authority: originalAuthority,
          completenessEvidence: {
            observedAt: originalAt,
            ownerRevision: revisionRef,
            scope: { kind: 'EXACT_PREDICATE', predicateRef },
          },
          factProofs: [],
          predicate,
        },
      },
    });
    const gateway = makePricingCurrentDecisionPricingOwnerFinalFenceGateway({
      currencySupport: {
        loadCurrent: forbiddenOwnerPersistence,
        resolveOriginalProof: forbiddenOwnerPersistence,
        verifyCurrentThrough: forbiddenOwnerPersistence,
      },
      discounts: {
        readCurrentSet: (replayedPredicate) =>
          samePredicate(replayedPredicate, predicate)
            ? Effect.succeed(current)
            : Effect.die('Discount replay did not use the exact retained owner predicate'),
        resolveOriginalSetProof: () => Effect.succeed(original),
        verifySetGeneration: ({ through: verifiedThrough }) =>
          Effect.succeed({
            authority: original.authority,
            outcome: 'CONTRACTUAL_DISCOUNT_SET_GENERATION_CURRENT' as const,
            verifiedThrough,
          }),
      },
      fees: { readCurrentSet: forbiddenOwnerPersistence, verifySetGeneration: forbiddenOwnerPersistence },
      prices: {
        readExactCandidateSet: forbiddenOwnerPersistence,
        verifyExactCandidateSetGeneration: forbiddenOwnerPersistence,
      },
      tiers: {
        readCurrentSet: forbiddenOwnerPersistence,
        resolveQuantityTierSetProof: forbiddenOwnerPersistence,
        verifySetGeneration: forbiddenOwnerPersistence,
      },
      zeroFloor: { readCurrentSet: forbiddenOwnerPersistence, verifyGeneration: forbiddenOwnerPersistence },
    });
    const verificationContext = {
      candidateRef: 'candidate:790',
      decision: makeIssue787Snapshot({ operationTime: effectiveAt }).decision,
      effectiveAt,
      evaluatedAt: freshAt,
      requestedAt: effectiveAt,
    };
    const expectation: PricingMaterialEvidenceFenceExpectation = {
      currencyCode: 'CZK',
      currentFacts: [],
      evidenceObservedAt: originalAt,
      evidenceVerificationRef: proofRef,
      family: 'DISCOUNT',
      ownerModuleId: 'commerce.pricing',
      ownerRootRef: rootRef,
      ownerSetRevisionRef: revisionRef,
      predicateRef,
      tenantId,
    };
    return Effect.gen(function* verifiesDiscountAbsenceFromOwnerProof() {
      const first = yield* gateway.verifyOpaqueProofsAgainstCurrentState({
        candidateRef: 'candidate:790',
        sources: [expectation],
        typedSources: [source],
        verificationContext,
      });
      expect(first.observations[0]).toMatchObject({
        currentFacts: [],
        currentInvalidationGenerationRef: '9',
        evidenceInvalidationGenerationRef: '9',
        observedAt: freshAt,
      });
      const second = yield* gateway.confirmObservedGenerationsThrough({
        candidateRef: 'candidate:790',
        observations: first.observations,
        through,
        typedSources: [source],
        verificationContext,
      });
      expect(second.verifiedThrough).toBe(through);
    });
  });

  it.effect(
    'resolves Currency Support original generation from durable owner history before its fresh Current read',
    () => {
      const tenantId = '10000000-0000-4000-8000-000000000001';
      const rootId = '10000000-0000-4000-8000-000000000002';
      const revisionId = '10000000-0000-4000-8000-000000000003';
      const proofRef = 'currency-support-proof:original';
      const effectiveAt = '2026-09-28T08:58:00.000Z';
      const originalAt = '2026-09-28T08:59:00.000Z';
      const freshAt = '2026-09-28T09:00:00.000Z';
      const through = '2026-09-28T09:01:00.000Z';
      const predicateRef = `commerce.pricing.current-supported-currencies:${tenantId}:${rootId}`;
      const rootRef = {
        moduleId: 'commerce.pricing',
        resourceId: rootId,
        resourceType: 'commerce.pricing.currency-support',
        tenantId,
      } as const;
      const revisionRef = {
        moduleId: 'commerce.pricing',
        resourceId: revisionId,
        resourceType: 'commerce.pricing.currency-support-revision',
        supportRootId: rootId,
        tenantId,
      } as const;
      const support = Schema.decodeSync(CurrentSupportedCurrenciesSuccessSchema)({
        completenessEvidence: {
          observedAt: originalAt,
          ownerRevision: revisionId,
          scope: { kind: 'EXACT_PREDICATE', predicateRef },
        },
        currentnessEvidence: {
          evaluatedAt: effectiveAt,
          evaluationMode: 'CURRENT_WITH_REVALIDATION',
          observedAt: originalAt,
          revalidatedAt: originalAt,
          scheduleRevision: 5,
          supportRevisionRef: revisionRef,
          supportRootRef: rootRef,
        },
        effectiveAt,
        effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
        factProofs: [{ factRef: rootId, factRevisionRef: revisionId, verificationRef: proofRef }],
        generation: 4,
        observedAt: originalAt,
        outcome: 'SUPPORTED_CURRENCIES_CURRENT',
        pricingRevision: 'pricing-currency-support:4',
        scheduleRevision: 5,
        supportedCurrencies: ['CZK'],
        supportRevisionRef: revisionRef,
        supportRootRef: rootRef,
        tenantId,
        verificationRef: proofRef,
      });
      const ownerScope = { ownerModuleId: 'commerce.pricing', ownerRootRef: rootId, predicateRef, tenantId };
      const temporal = {
        effectiveAt,
        evaluatedAt: effectiveAt,
        evaluationMode: 'CURRENT_AT_OWNER_EVALUATION',
        observedAt: originalAt,
        requestedAt: effectiveAt,
      };
      const verification = { kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE', verificationRef: proofRef };
      const source = Schema.decodeUnknownSync(PricingMaterialEvidenceFenceSourceSchema)({
        sourceEvidence: {
          _tag: 'VERIFIED_PRESENT',
          completeness: {
            completenessEvidence: support.completenessEvidence,
            currencyCode: 'CZK',
            family: 'CURRENCY_SUPPORT',
            ownerScope,
            ownerSetRevisionRef: revisionId,
            temporal,
            verification,
          },
          currentFacts: [
            {
              currencyCode: 'CZK',
              effectivePeriod: support.effectivePeriod,
              factRef: rootId,
              factRevisionRef: revisionId,
              family: 'CURRENCY_SUPPORT',
              ownerScope,
              temporal,
              verification,
            },
          ],
          request: {
            currencyCode: 'CZK',
            effectiveAt,
            family: 'CURRENCY_SUPPORT',
            ownerScope,
            requestedAt: effectiveAt,
          },
        },
        verificationMaterial: { kind: 'PRICING_CURRENCY_SUPPORT_AUTHORITY', support },
      });
      const verifiedInstants: string[] = [];
      const gateway = makePricingCurrentDecisionPricingOwnerFinalFenceGateway({
        currencySupport: {
          loadCurrent: () =>
            Effect.succeed({
              _tag: 'current' as const,
              current: {
                ...support,
                currentnessEvidence: { ...support.currentnessEvidence, observedAt: freshAt, revalidatedAt: freshAt },
                factProofs: [{ factRef: rootId, factRevisionRef: revisionId, verificationRef: `${proofRef}:fresh` }],
                observedAt: freshAt,
                predicateRef,
                verificationRef: `${proofRef}:fresh`,
              },
            }),
          resolveOriginalProof: () =>
            Effect.succeed({
              effectiveAt,
              effectivePeriod: support.effectivePeriod,
              factProofs: support.factProofs,
              generation: 4,
              observedAt: originalAt,
              predicateRef,
              pricingRevision: support.pricingRevision,
              scheduleRevision: 5,
              supportedCurrencies: support.supportedCurrencies,
              supportRevisionId: revisionId,
              supportRootId: rootId,
              tenantId,
              verificationRef: proofRef,
            }),
          verifyCurrentThrough: ({ through: checkedThrough }) => {
            verifiedInstants.push(checkedThrough);
            return Effect.succeed({
              generation: 4,
              observedAt: freshAt,
              outcome: 'UNCHANGED_THROUGH' as const,
              scheduleRevision: 5,
              supportRevisionId: revisionId,
              supportRootId: rootId,
              verifiedThrough: checkedThrough,
            });
          },
        },
        discounts: {
          readCurrentSet: forbiddenOwnerPersistence,
          resolveOriginalSetProof: forbiddenOwnerPersistence,
          verifySetGeneration: forbiddenOwnerPersistence,
        },
        fees: { readCurrentSet: forbiddenOwnerPersistence, verifySetGeneration: forbiddenOwnerPersistence },
        prices: {
          readExactCandidateSet: forbiddenOwnerPersistence,
          verifyExactCandidateSetGeneration: forbiddenOwnerPersistence,
        },
        tiers: {
          readCurrentSet: forbiddenOwnerPersistence,
          resolveQuantityTierSetProof: forbiddenOwnerPersistence,
          verifySetGeneration: forbiddenOwnerPersistence,
        },
        zeroFloor: { readCurrentSet: forbiddenOwnerPersistence, verifyGeneration: forbiddenOwnerPersistence },
      });
      const verificationContext = {
        candidateRef: 'candidate:790',
        decision: makeIssue787Snapshot({ operationTime: effectiveAt }).decision,
        effectiveAt,
        evaluatedAt: freshAt,
        requestedAt: effectiveAt,
      };
      const expectation: PricingMaterialEvidenceFenceExpectation = {
        currencyCode: 'CZK',
        currentFacts: [{ factRef: rootId, factRevisionRef: revisionId, verificationRef: proofRef }],
        evidenceObservedAt: originalAt,
        evidenceVerificationRef: proofRef,
        family: 'CURRENCY_SUPPORT',
        ownerModuleId: 'commerce.pricing',
        ownerRootRef: rootId,
        ownerSetRevisionRef: revisionId,
        predicateRef,
        tenantId,
      };
      return Effect.gen(function* verifiesStoredOriginalAndCurrentCurrencyGeneration() {
        const first = yield* gateway.verifyOpaqueProofsAgainstCurrentState({
          candidateRef: 'candidate:790',
          sources: [expectation],
          typedSources: [source],
          verificationContext,
        });
        expect(first.observations[0]).toMatchObject({
          currentInvalidationGenerationRef: '4',
          evidenceInvalidationGenerationRef: '4',
          observedAt: freshAt,
        });
        const second = yield* gateway.confirmObservedGenerationsThrough({
          candidateRef: 'candidate:790',
          observations: first.observations,
          through,
          typedSources: [source],
          verificationContext,
        });
        expect(second.verifiedThrough).toBe(through);
        expect(verifiedInstants).toEqual([through]);
      });
    },
  );

  it.effect('requires exact typed source material before any Pricing owner read or proof resolution', () => {
    const gateway = makePricingCurrentDecisionPricingOwnerFinalFenceGateway({
      currencySupport: {
        loadCurrent: forbiddenOwnerPersistence,
        resolveOriginalProof: forbiddenOwnerPersistence,
        verifyCurrentThrough: forbiddenOwnerPersistence,
      },
      discounts: {
        readCurrentSet: forbiddenOwnerPersistence,
        resolveOriginalSetProof: forbiddenOwnerPersistence,
        verifySetGeneration: forbiddenOwnerPersistence,
      },
      fees: { readCurrentSet: forbiddenOwnerPersistence, verifySetGeneration: forbiddenOwnerPersistence },
      prices: {
        readExactCandidateSet: forbiddenOwnerPersistence,
        verifyExactCandidateSetGeneration: forbiddenOwnerPersistence,
      },
      resolveOriginalProof: forbiddenOwnerPersistence,
      tiers: {
        readCurrentSet: forbiddenOwnerPersistence,
        resolveQuantityTierSetProof: forbiddenOwnerPersistence,
        verifySetGeneration: forbiddenOwnerPersistence,
      },
      zeroFloor: { readCurrentSet: forbiddenOwnerPersistence, verifyGeneration: forbiddenOwnerPersistence },
    });
    return Effect.gen(function* refusesUntypedOwnerRead() {
      const sourceFailure = yield* gateway
        .verifyOpaqueProofsAgainstCurrentState({ candidateRef: 'candidate:790', sources: [] })
        .pipe(Effect.flip);
      const generationFailure = yield* gateway
        .confirmObservedGenerationsThrough({
          candidateRef: 'candidate:790',
          observations: [],
          through: '2026-09-28T12:00:00.000Z',
        })
        .pipe(Effect.flip);
      expect(sourceFailure.reason).toMatch(/typed Pricing source/iu);
      expect(generationFailure.reason).toMatch(/typed Pricing source/iu);
    });
  });

  it.effect('provides all owner tags and keeps every unavailable authority fail-closed', () =>
    Effect.scoped(
      Effect.gen(function* allOwnersFailClosed() {
        const context = yield* Layer.build(
          pricingCurrentDecisionOwnerFinalFenceGatewaysLive.pipe(
            Layer.provide(
              Layer.succeed(ActiveApplicationCompositionService, {
                load: Effect.fail(
                  new ActiveApplicationCompositionUnavailableError({ reason: 'Composition unavailable in test' }),
                ),
              }),
            ),
          ),
        );
        const unavailableGateways: readonly [
          PricingMaterialEvidenceOwnerModule,
          PricingOwnerMaterialEvidenceFenceGateway,
        ][] = [
          ['commerce.pricing', Context.get(context, PricingPricingMaterialEvidenceFenceGateway)],
          ['commerce.catalog', Context.get(context, PricingCatalogMaterialEvidenceFenceGateway)],
          ['commerce.market-catalog', Context.get(context, PricingMarketMaterialEvidenceFenceGateway)],
          ['commerce.customer-context', Context.get(context, PricingCustomerContextMaterialEvidenceFenceGateway)],
        ];
        for (const [ownerModuleId, gateway] of unavailableGateways) {
          yield* assertUnavailable(ownerModuleId, gateway);
        }
        const promotion = Context.get(context, PricingPromotionMaterialEvidenceFenceGateway);
        const failure = yield* promotion
          .verifyOpaqueProofsAgainstCurrentState({ candidateRef: 'candidate:790', sources: [] })
          .pipe(Effect.flip);
        expect(failure).toBeInstanceOf(PricingOwnerMaterialEvidenceFenceGatewayUnavailable);
        expect(failure).toMatchObject({ ownerModuleId: 'commerce.promotion', retryable: true });
      }),
    ),
  );

  it.effect('accepts real owner adapters and permits an unchanged five-owner aggregate fence', () => {
    const realGateways = makePricingCurrentDecisionOwnerFinalFenceGatewaysLive({
      catalog: successfulGateway('2026-09-28T12:00:10.200Z'),
      customerContext: successfulGateway('2026-09-28T12:00:10.400Z'),
      market: successfulGateway('2026-09-28T12:00:10.300Z'),
      pricing: successfulGateway('2026-09-28T12:00:10.100Z'),
      promotion: successfulGateway('2026-09-28T12:00:10.500Z'),
    });
    const live = pricingMaterialEvidenceOwnerFinalFenceLive.pipe(Layer.provide(realGateways));

    return Effect.scoped(
      Effect.gen(function* acceptsRealOwnerAuthorities() {
        const context = yield* Layer.build(
          live.pipe(
            Layer.provide(
              Layer.succeed(ActiveApplicationCompositionService, {
                load: Effect.fail(new ActiveApplicationCompositionUnavailableError({ reason: 'Unused in this test' })),
              }),
            ),
          ),
        );
        const fence = Context.get(context, PricingMaterialEvidenceOwnerFinalFence);
        const result = yield* fence.verifyImmediatelyBeforePublication({
          candidateRef: 'candidate:790',
          sources: expectations,
        });

        expect(result.observedAt).toBe('2026-09-28T12:00:10.500Z');
        expect(result.sources.map(({ observedAt }) => observedAt)).toEqual(
          expectations.map(({ evidenceObservedAt }) => evidenceObservedAt),
        );
        expect(result.sources.map(({ evidenceVerificationRef }) => evidenceVerificationRef)).toEqual(
          expectations.map(({ evidenceVerificationRef }) => evidenceVerificationRef),
        );
      }),
    );
  });

  it.effect('invokes the source-free Promotion owner when Promotion was not selected', () => {
    const realGateways = makePricingCurrentDecisionOwnerFinalFenceGatewaysLive({
      catalog: successfulGateway('2026-09-28T12:00:10.200Z'),
      customerContext: successfulGateway('2026-09-28T12:00:10.400Z'),
      market: successfulGateway('2026-09-28T12:00:10.300Z'),
      pricing: successfulGateway('2026-09-28T12:00:10.100Z'),
      promotion: successfulGateway('2026-09-28T12:00:10.500Z'),
    });
    const live = pricingMaterialEvidenceOwnerFinalFenceLive.pipe(Layer.provide(realGateways));
    const ordinarySources = expectations.filter(({ ownerModuleId }) => ownerModuleId !== 'commerce.promotion');

    return Effect.scoped(
      Effect.gen(function* verifiesUnselectedPromotionOwner() {
        const context = yield* Layer.build(
          live.pipe(
            Layer.provide(
              Layer.succeed(ActiveApplicationCompositionService, {
                load: Effect.fail(new ActiveApplicationCompositionUnavailableError({ reason: 'Unused in this test' })),
              }),
            ),
          ),
        );
        const fence = Context.get(context, PricingMaterialEvidenceOwnerFinalFence);
        const result = yield* fence.verifyImmediatelyBeforePublication({
          candidateRef: 'candidate:790',
          sources: ordinarySources,
        });

        expect(result.sources).toHaveLength(ordinarySources.length);
        expect(result.sources.some(({ ownerModuleId }) => ownerModuleId === 'commerce.promotion')).toBe(false);
        expect(result.observedAt).toBe('2026-09-28T12:00:10.500Z');
      }),
    );
  });

  it.effect('routes the source-free Purchase Context singleton without treating it as set evidence', () => {
    const pricingExpectation = expectations.find(({ ownerModuleId }) => ownerModuleId === 'commerce.pricing');
    if (pricingExpectation === undefined) {
      return Effect.die('Pricing expectation fixture is missing');
    }
    const snapshot = makeIssue787Snapshot({
      capturedAt: '2026-09-28T10:00:00.500Z',
      evaluatedAt: '2026-09-28T10:00:00.200Z',
      observedAt: '2026-09-28T10:00:00.300Z',
    });
    const [line] = snapshot.decision.lines;
    const [binding] = snapshot.materialBindings;
    if (
      line === undefined ||
      binding === undefined ||
      !Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(binding.sourceEvidence)
    ) {
      return Effect.die('Pricing source fixture is incomplete');
    }
    const { completeness, currentFacts } = binding.sourceEvidence;
    const { nextMaterialBoundary } = completeness.temporal;
    if (nextMaterialBoundary === undefined) {
      return Effect.die('Pricing source fixture lacks its material boundary');
    }
    const pricingSource: PricingMaterialEvidenceFenceSource = {
      sourceEvidence: binding.sourceEvidence,
      verificationMaterial: {
        kind: 'PRICING_PRICE_AUTHORITY',
        lookupRequest: {
          effectiveAt: snapshot.decision.operationTime,
          exactKey: {
            catalogSelection: line.catalog.selection,
            commercialScope: snapshot.decision.commercialScope,
            currencyCode: snapshot.decision.currencyCode,
            priceGroupSelector: { kind: 'NO_GROUP' },
            unitBasis: line.pricingBasis,
          },
        },
        ownerReadReceipt: {
          authority: {
            generation: 1,
            kind: 'PERSISTENT',
            nextApplicabilityBoundary: nextMaterialBoundary,
            observedAt: completeness.temporal.observedAt,
            ownerRevision: completeness.ownerSetRevisionRef,
            ownerRootRef: completeness.ownerScope.ownerRootRef,
            predicateRef: completeness.ownerScope.predicateRef,
            verificationRef: completeness.verification.verificationRef,
          },
          factProofs: currentFacts.map(({ factRef, factRevisionRef, verification }) => ({
            factRef,
            factRevisionRef,
            verificationRef: verification.verificationRef,
          })),
        },
      },
    };
    const principalId = Schema.decodeSync(PrincipalIdSchema)('77777777-7777-4777-8777-777777777777');
    const purchaseSource: PricingMaterialEvidenceFenceSource = {
      verificationMaterial: {
        evidence: {
          currentness: {
            evaluatedAt: snapshot.decision.operationTime,
            observedAt: completeness.temporal.observedAt,
            validFrom: snapshot.decision.operationTime,
            validTo: null,
          },
          ownerRef: snapshot.decision.purchasingContext.contextRef,
          ownerRevisionRef: snapshot.decision.purchasingContext.contextRevision,
          subjectAuthority: {
            actorPrincipalId: principalId,
            kind: 'PROFILE',
            partyAuthorityRef: 'party-authority:790',
            partyAuthorityRevisionRef: 'party-authority-revision:790',
            subject: snapshot.decision.purchasingContext.subject,
            subjectAuthorityRef: 'subject-authority:790',
            subjectAuthorityRevisionRef: 'subject-authority-revision:790',
          },
          verificationRef: 'purchase-context-verification:790',
          verifiedScope: {
            channelId: snapshot.decision.commercialScope.channelId,
            legalEntityId: snapshot.decision.commercialScope.sellingLegalEntityId,
            marketId: snapshot.decision.commercialScope.marketId,
            tenantId: snapshot.decision.tenantId,
          },
        },
        kind: 'CUSTOMER_CONTEXT_PURCHASE_AUTHORITY',
        request: {
          actor: { kind: 'AUTHENTICATED_CUSTOMER', principalId },
          operationTime: snapshot.decision.operationTime,
          purchasingContext: {
            channelId: snapshot.decision.commercialScope.channelId,
            contextRef: snapshot.decision.purchasingContext.contextRef,
            contextRevision: snapshot.decision.purchasingContext.contextRevision,
            marketId: snapshot.decision.commercialScope.marketId,
            sellingLegalEntityId: snapshot.decision.commercialScope.sellingLegalEntityId,
          },
          subject: snapshot.decision.purchasingContext.subject,
          tenantId: snapshot.decision.tenantId,
        },
      },
    };
    const purchaseUnavailable: PricingOwnerMaterialEvidenceFenceGateway = {
      confirmObservedGenerationsThrough: () => Effect.die('Purchase phase two must not run after phase-one refusal'),
      verifyOpaqueProofsAgainstCurrentState: ({ sources, typedSources }) => {
        const [purchase] = typedSources ?? [];
        if (
          sources.length !== 0 ||
          typedSources?.length !== 1 ||
          purchase?.verificationMaterial.kind !== 'CUSTOMER_CONTEXT_PURCHASE_AUTHORITY'
        ) {
          return Effect.die('Purchase singleton was incorrectly correlated as set-backed evidence');
        }
        return Effect.fail(
          new PricingOwnerMaterialEvidenceFenceGatewayUnavailable({
            ownerModuleId: 'commerce.customer-context',
            reason: 'Purchase Context same-principal replay is unavailable',
            retryable: true,
          }),
        );
      },
    };
    const success = successfulGateway('2026-09-28T12:00:10.000Z');
    const fence = makePricingMaterialEvidenceOwnerFinalFenceFromGateways({
      'commerce.catalog': success,
      'commerce.customer-context': purchaseUnavailable,
      'commerce.market-catalog': success,
      'commerce.pricing': success,
      'commerce.promotion': success,
    });
    const verificationRequest: PricingOwnerMaterialEvidenceFenceGatewayRequest = {
      candidateRef: snapshot.candidateRef,
      decision: snapshot.decision,
      effectiveAt: snapshot.decision.operationTime,
      evaluatedAt: snapshot.capturedAt,
      requestedAt: snapshot.requestedAt,
      sources: [pricingSource, purchaseSource],
      subject: snapshot.decision.purchasingContext.subject,
    };
    const routedPricingExpectation: PricingMaterialEvidenceFenceExpectation = {
      ...pricingExpectation,
      currentFacts: currentFacts.map(({ factRef, factRevisionRef, verification }) => ({
        factRef,
        factRevisionRef,
        verificationRef: verification.verificationRef,
      })),
      evidenceObservedAt: completeness.temporal.observedAt,
      evidenceVerificationRef: completeness.verification.verificationRef,
      ownerRootRef: completeness.ownerScope.ownerRootRef,
      ownerSetRevisionRef: completeness.ownerSetRevisionRef,
      predicateRef: completeness.ownerScope.predicateRef,
      tenantId: completeness.ownerScope.tenantId,
    };

    return Effect.gen(function* rejectsOnlyAtNativePurchaseReplay() {
      const failure = yield* fence
        .verifyImmediatelyBeforePublication({
          candidateRef: verificationRequest.candidateRef,
          sources: [routedPricingExpectation],
          verificationRequest,
        })
        .pipe(Effect.flip);
      expect(failure.reason).toMatch(/source-free predicate/iu);
      expect(failure.cause).toMatchObject({ ownerModuleId: 'commerce.customer-context', retryable: true });
    });
  });
});
