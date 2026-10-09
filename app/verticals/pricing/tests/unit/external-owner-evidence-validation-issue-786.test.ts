import { PricingCurrentMarketEvidenceResponseSchema } from '@app/commerce-market-catalog/api/pricing-current-market-evidence';
import type { PriceGroupAssignmentResolutionResponse } from '@app/pricing-contracts/domain/price-group-interpretation';
import type { PricingDecision } from '@app/pricing-contracts/pricing-decision';
import type {
  PricingSourceEvidenceRequest,
  PricingSourceEvidenceResult,
} from '@app/pricing-contracts/domain/source-revision-evidence';
import {
  PricingSourceEvidenceConflictSchema,
  PricingSourceEvidenceResultSchema,
  PricingSourceEvidenceUnverifiableSchema,
  PricingSourceEvidenceVerifiedAbsentSchema,
  PricingSourceEvidenceVerifiedPresentSchema,
} from '@app/pricing-contracts/domain/source-revision-evidence';
import { PromotionContributionOutcomeSchema } from '@app/pricing-contracts/domain/promotion-contribution';
import type { OwnerVerifiableSetCompletenessEvidenceEncoded } from '@app/shared-contracts';
import { Effect, Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingExternalOwnerEvidenceMismatch,
  makePricingExternalOwnerEvidenceValidationService,
} from '../../src/services/external-owner-evidence-validation.service.ts';
import { makeIssue779Scenario } from './support/issue-779-line-value.fixture.ts';

const sourceResult = (input: {
  readonly completeness?: OwnerVerifiableSetCompletenessEvidenceEncoded;
  readonly effectiveAt: PricingSourceEvidenceRequest['effectiveAt'];
  readonly factRef?: string;
  readonly factRevisionRef?: string;
  readonly family: 'COMMERCIAL_CONTEXT' | 'PROMOTION';
  readonly ownerModuleId: string;
  readonly ownerRootRef: string;
  readonly predicateRef: string;
  readonly requestedAt?: PricingSourceEvidenceRequest['requestedAt'];
  readonly tag: 'CONFLICT' | 'MISSING' | 'UNVERIFIABLE' | 'VERIFIED_ABSENT' | 'VERIFIED_PRESENT';
  readonly tenantId: string;
}) => {
  const requestedAt = input.requestedAt ?? input.effectiveAt;
  const observedAt = input.completeness?.observedAt ?? input.effectiveAt;
  const request = {
    effectiveAt: input.effectiveAt,
    family: input.family,
    ownerScope: {
      ownerModuleId: input.ownerModuleId,
      ownerRootRef: input.ownerRootRef,
      predicateRef: input.predicateRef,
      tenantId: input.tenantId,
    },
    requestedAt,
  } as const;
  if (input.tag === 'MISSING') {
    return Schema.decodeSync(PricingSourceEvidenceResultSchema)({
      _tag: 'MISSING',
      observedAt,
      reason: 'OWNER_ROOT_NOT_INITIALIZED',
      request,
      verification: { kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE', verificationRef: 'owner-proof:missing' },
    });
  }
  if (input.tag === 'UNVERIFIABLE') {
    return Schema.decodeSync(PricingSourceEvidenceResultSchema)({
      _tag: 'UNVERIFIABLE',
      observedAt,
      reason: 'OWNER_UNAVAILABLE',
      request,
      retryable: true,
    });
  }
  const completenessEvidence = input.completeness ?? {
    observedAt,
    ownerRevision: 'owner-set-r786',
    scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: input.predicateRef },
  };
  const temporalBase = {
    effectiveAt: input.effectiveAt,
    evaluatedAt: input.effectiveAt,
    evaluationMode: 'HISTORICAL_AS_OF' as const,
    observedAt: completenessEvidence.observedAt,
    requestedAt,
  };
  const temporal =
    completenessEvidence.nextApplicabilityBoundary === undefined
      ? temporalBase
      : { ...temporalBase, nextMaterialBoundary: completenessEvidence.nextApplicabilityBoundary };
  const completeness = {
    completenessEvidence,
    family: input.family,
    ownerScope: request.ownerScope,
    ownerSetRevisionRef: completenessEvidence.ownerRevision,
    temporal,
    verification: { kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE' as const, verificationRef: 'owner-set-proof:786' },
  };
  if (input.tag === 'VERIFIED_ABSENT') {
    return Schema.decodeSync(PricingSourceEvidenceResultSchema)({
      _tag: 'VERIFIED_ABSENT',
      completeness,
      request,
    });
  }
  const fact = (suffix: string) => ({
    effectivePeriod: { effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null },
    factRef: input.factRef ?? `owner-fact:${suffix}`,
    factRevisionRef: input.factRevisionRef ?? `owner-fact-revision:${suffix}`,
    family: input.family,
    ownerScope: request.ownerScope,
    temporal,
    verification: { kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE' as const, verificationRef: `owner-fact-proof:${suffix}` },
  });
  return Schema.decodeSync(PricingSourceEvidenceResultSchema)({
    _tag: input.tag,
    completeness,
    currentFacts: input.tag === 'CONFLICT' ? [fact('one'), fact('two')] : [fact('one')],
    request,
  });
};

type MarketDecisionContext = Pick<PricingDecision, 'commercialScope' | 'operationTime' | 'tenantId'>;

const presentMarketResponse = (decision: MarketDecisionContext, sourceEvidence: PricingSourceEvidenceResult) => {
  if (!Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(sourceEvidence)) {
    throw new Error('fixture requires verified-present Market evidence');
  }
  const [sourceFact] = sourceEvidence.currentFacts;
  if (sourceFact === undefined) {
    throw new Error('fixture requires one Current Market fact');
  }
  const authorityBase = {
    generation: 1,
    observedAt: sourceEvidence.completeness.temporal.observedAt,
    ownerRootRef: sourceEvidence.completeness.ownerScope.ownerRootRef,
    ownerSetRevisionRef: sourceEvidence.completeness.ownerSetRevisionRef,
    predicateRef: sourceEvidence.completeness.ownerScope.predicateRef,
    verificationRef: sourceEvidence.completeness.verification.verificationRef,
  };
  const nextBoundary = sourceEvidence.completeness.temporal.nextMaterialBoundary;
  const authority =
    nextBoundary === undefined ? authorityBase : { ...authorityBase, nextApplicabilityBoundary: nextBoundary };
  return Schema.decodeSync(PricingCurrentMarketEvidenceResponseSchema)({
    market: {
      channels: [decision.commercialScope.channelId],
      definitionRevisionRef: {
        moduleId: 'commerce.market-catalog',
        resourceId: 'market-definition:786',
        resourceType: 'commerce.market-catalog.market-definition-revision',
        tenantId: decision.tenantId,
      },
      effectivePeriod: { startsAt: sourceFact.effectivePeriod.effectiveFrom },
      jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
      lifecycle: 'ACTIVE',
      marketCode: 'CZ',
      marketRef: {
        moduleId: 'commerce.market-catalog',
        resourceId: decision.commercialScope.marketId,
        resourceType: 'commerce.market-catalog.market',
        tenantId: decision.tenantId,
      },
      purpose: 'Ordinary Current Pricing',
      revision: 1,
      sellingLegalEntityRef: {
        moduleId: 'core.identity',
        resourceId: decision.commercialScope.sellingLegalEntityId,
        resourceType: 'core.identity.legal-entity',
        tenantId: decision.tenantId,
      },
      supportedLocales: ['cs-CZ'],
    },
    outcome: 'PRICING_MARKET_SOURCE_PRESENT',
    receipt: {
      authority,
      currentFacts: [
        {
          effectivePeriod:
            sourceFact.effectivePeriod.effectiveTo === null
              ? { startsAt: sourceFact.effectivePeriod.effectiveFrom }
              : {
                  endsAt: sourceFact.effectivePeriod.effectiveTo,
                  startsAt: sourceFact.effectivePeriod.effectiveFrom,
                },
          factRef: sourceFact.factRef,
          factRevisionRef: sourceFact.factRevisionRef,
          verificationRef: sourceFact.verification.verificationRef,
        },
      ],
      state: 'PRESENT',
    },
    request: {
      commercialScope: {
        channel: decision.commercialScope.channelId,
        marketRef: {
          moduleId: 'commerce.market-catalog',
          resourceId: decision.commercialScope.marketId,
          resourceType: 'commerce.market-catalog.market',
          tenantId: decision.tenantId,
        },
        sellingLegalEntityRef: {
          moduleId: 'core.identity',
          resourceId: decision.commercialScope.sellingLegalEntityId,
          resourceType: 'core.identity.legal-entity',
          tenantId: decision.tenantId,
        },
      },
      effectiveAt: decision.operationTime,
      requestedAt: sourceEvidence.request.requestedAt,
    },
  });
};

describe('Pricing external owner evidence validation #786', () => {
  it.effect('preserves exact Catalog evidence and never rewrites owner inability as absence', () =>
    Effect.gen(function* catalogEvidence() {
      const scenario = yield* makeIssue779Scenario();
      const [line] = scenario.compositionRequest.decision.lines;
      if (line === undefined) {
        throw new Error('fixture requires one line');
      }
      const evidence = sourceResult({
        effectiveAt: scenario.compositionRequest.decision.operationTime,
        family: 'COMMERCIAL_CONTEXT',
        ownerModuleId: 'commerce.catalog',
        ownerRootRef: 'catalog-root:786',
        predicateRef: 'catalog-selection:786',
        tag: 'VERIFIED_PRESENT',
        tenantId: scenario.compositionRequest.decision.tenantId,
      });
      const service = makePricingExternalOwnerEvidenceValidationService();
      const result = yield* service.validateCatalogSelection({
        assessment: line.catalog.evidence,
        expectedEffectiveAt: scenario.compositionRequest.decision.operationTime,
        expectedOwnerRootRef: 'catalog-root:786',
        expectedPredicateRef: 'catalog-selection:786',
        expectedSelection: line.catalog.selection,
        requestedAt: scenario.compositionRequest.decision.operationTime,
        sourceEvidence: evidence,
      });
      expect(result.ownerPayload).toBe(line.catalog.evidence);
      expect(result.sourceEvidence).toBe(evidence);

      const unavailable = sourceResult({
        effectiveAt: scenario.compositionRequest.decision.operationTime,
        family: 'COMMERCIAL_CONTEXT',
        ownerModuleId: 'commerce.catalog',
        ownerRootRef: 'catalog-root:786',
        predicateRef: 'catalog-selection:786',
        tag: 'UNVERIFIABLE',
        tenantId: scenario.compositionRequest.decision.tenantId,
      });
      const failure = yield* service
        .validateCatalogSelection({
          assessment: line.catalog.evidence,
          expectedEffectiveAt: scenario.compositionRequest.decision.operationTime,
          expectedOwnerRootRef: 'catalog-root:786',
          expectedPredicateRef: 'catalog-selection:786',
          expectedSelection: line.catalog.selection,
          requestedAt: scenario.compositionRequest.decision.operationTime,
          sourceEvidence: unavailable,
        })
        .pipe(Effect.flip);
      expect(failure).toBeInstanceOf(PricingExternalOwnerEvidenceMismatch);
      expect(failure.reason).toBe('OUTCOME_PROOF_CLASS_MISMATCH');
    }),
  );

  it.effect('binds Market evidence to exact SLE, Channel, and Market while excluding Storefront', () =>
    Effect.gen(function* marketEvidence() {
      const decision = {
        commercialScope: {
          channelId: 'B2C',
          marketId: 'market:cz-launch',
          sellingLegalEntityId: '20000000-0000-4000-8000-000000000001',
        },
        operationTime: '2026-09-28T08:00:00.000Z',
        tenantId: '10000000-0000-4000-8000-000000000001',
      } satisfies MarketDecisionContext;
      const source = sourceResult({
        effectiveAt: decision.operationTime,
        factRef: decision.commercialScope.marketId,
        family: 'COMMERCIAL_CONTEXT',
        ownerModuleId: 'commerce.market-catalog',
        ownerRootRef: 'market-catalog-root:786',
        predicateRef: 'market-resolution:786',
        tag: 'VERIFIED_PRESENT',
        tenantId: decision.tenantId,
      });
      if (!Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(source)) {
        throw new Error('fixture requires verified-present evidence');
      }
      const response = presentMarketResponse(decision, source);
      const service = makePricingExternalOwnerEvidenceValidationService();
      const result = yield* service.validateMarket({
        expectedCommercialScope: decision.commercialScope,
        expectedEffectiveAt: decision.operationTime,
        expectedOwnerRootRef: 'market-catalog-root:786',
        expectedPredicateRef: 'market-resolution:786',
        requestedAt: decision.operationTime,
        response,
        sourceEvidence: source,
        tenantId: decision.tenantId,
      });
      expect(result.ownerPayload).toBe(response);
      expect(result.sourceEvidence).toBe(source);

      if (response.outcome !== 'PRICING_MARKET_SOURCE_PRESENT') {
        throw new Error('fixture requires present Market owner evidence');
      }
      const substitutedReceiptFailure = yield* service
        .validateMarket({
          expectedCommercialScope: decision.commercialScope,
          expectedEffectiveAt: decision.operationTime,
          expectedOwnerRootRef: 'market-catalog-root:786',
          expectedPredicateRef: 'market-resolution:786',
          requestedAt: decision.operationTime,
          response: {
            ...response,
            receipt: {
              ...response.receipt,
              authority: { ...response.receipt.authority, verificationRef: 'consumer-substituted-proof' },
            },
          },
          sourceEvidence: source,
          tenantId: decision.tenantId,
        })
        .pipe(Effect.flip);
      expect(substitutedReceiptFailure.reason).toBe('OWNER_EVIDENCE_MISMATCH');

      const storefrontFailure = yield* service
        .validateMarket({
          expectedCommercialScope: { ...decision.commercialScope, storefrontId: 'storefront-web' },
          expectedEffectiveAt: decision.operationTime,
          expectedOwnerRootRef: 'market-catalog-root:786',
          expectedPredicateRef: 'market-resolution:786',
          requestedAt: decision.operationTime,
          response,
          sourceEvidence: source,
          tenantId: decision.tenantId,
        })
        .pipe(Effect.flip);
      expect(storefrontFailure.reason).toBe('COMMERCIAL_SCOPE_MISMATCH');

      const absentSource = sourceResult({
        effectiveAt: decision.operationTime,
        family: 'COMMERCIAL_CONTEXT',
        ownerModuleId: 'commerce.market-catalog',
        ownerRootRef: 'market-catalog-root:786',
        predicateRef: 'market-resolution:786',
        tag: 'VERIFIED_ABSENT',
        tenantId: decision.tenantId,
      });
      if (!Schema.is(PricingSourceEvidenceVerifiedAbsentSchema)(absentSource)) {
        throw new Error('fixture requires verified-absent evidence');
      }
      const absentResponse = yield* Schema.decodeEffect(PricingCurrentMarketEvidenceResponseSchema)({
        outcome: 'PRICING_MARKET_SOURCE_ABSENT',
        receipt: {
          authority: {
            generation: 1,
            observedAt: absentSource.completeness.temporal.observedAt,
            ownerRootRef: absentSource.completeness.ownerScope.ownerRootRef,
            ownerSetRevisionRef: absentSource.completeness.ownerSetRevisionRef,
            predicateRef: absentSource.completeness.ownerScope.predicateRef,
            verificationRef: absentSource.completeness.verification.verificationRef,
          },
          currentFacts: [],
          state: 'ABSENT',
        },
        request: {
          commercialScope: {
            channel: decision.commercialScope.channelId,
            marketRef: {
              moduleId: 'commerce.market-catalog',
              resourceId: decision.commercialScope.marketId,
              resourceType: 'commerce.market-catalog.market',
              tenantId: decision.tenantId,
            },
            sellingLegalEntityRef: {
              moduleId: 'core.identity',
              resourceId: decision.commercialScope.sellingLegalEntityId,
              resourceType: 'core.identity.legal-entity',
              tenantId: decision.tenantId,
            },
          },
          effectiveAt: decision.operationTime,
          requestedAt: decision.operationTime,
        },
      });
      const absence = yield* service.validateMarket({
        expectedCommercialScope: decision.commercialScope,
        expectedEffectiveAt: decision.operationTime,
        expectedOwnerRootRef: 'market-catalog-root:786',
        expectedPredicateRef: 'market-resolution:786',
        requestedAt: decision.operationTime,
        response: absentResponse,
        sourceEvidence: absentSource,
        tenantId: decision.tenantId,
      });
      expect(Schema.is(PricingSourceEvidenceVerifiedAbsentSchema)(absence.sourceEvidence)).toBe(true);

      const unavailableSource = sourceResult({
        effectiveAt: decision.operationTime,
        family: 'COMMERCIAL_CONTEXT',
        ownerModuleId: 'commerce.market-catalog',
        ownerRootRef: 'market-catalog-root:786',
        predicateRef: 'market-resolution:786',
        tag: 'UNVERIFIABLE',
        tenantId: decision.tenantId,
      });
      const unavailableResponse = yield* Schema.decodeEffect(PricingCurrentMarketEvidenceResponseSchema)({
        outcome: 'PRICING_MARKET_SOURCE_UNAVAILABLE',
        reason: 'Owner temporarily unavailable',
        request: {
          commercialScope: {
            channel: decision.commercialScope.channelId,
            marketRef: {
              moduleId: 'commerce.market-catalog',
              resourceId: decision.commercialScope.marketId,
              resourceType: 'commerce.market-catalog.market',
              tenantId: decision.tenantId,
            },
            sellingLegalEntityRef: {
              moduleId: 'core.identity',
              resourceId: decision.commercialScope.sellingLegalEntityId,
              resourceType: 'core.identity.legal-entity',
              tenantId: decision.tenantId,
            },
          },
          effectiveAt: decision.operationTime,
          requestedAt: decision.operationTime,
        },
        retryable: true,
      });
      const unavailable = yield* service.validateMarket({
        expectedCommercialScope: decision.commercialScope,
        expectedEffectiveAt: decision.operationTime,
        expectedOwnerRootRef: 'market-catalog-root:786',
        expectedPredicateRef: 'market-resolution:786',
        requestedAt: decision.operationTime,
        response: unavailableResponse,
        sourceEvidence: unavailableSource,
        tenantId: decision.tenantId,
      });
      expect(Schema.is(PricingSourceEvidenceUnverifiableSchema)(unavailable.sourceEvidence)).toBe(true);
    }),
  );

  it.effect('keeps Group proven absence, cardinality conflict, and owner outage distinct', () =>
    Effect.gen(function* groupEvidence() {
      const tenantId = '10000000-0000-4000-8000-000000000001';
      const effectiveAt = '2026-09-28T08:00:00.000Z';
      const profile = {
        kind: 'RETAIL' as const,
        moduleId: 'commerce.customer-context' as const,
        resourceId: 'retail-profile:786',
        resourceType: 'commerce.customer-context.retail-customer-profile' as const,
        tenantId,
      };
      const response = {
        effectiveAt,
        profile,
        resolution: { _tag: 'NONE' as const },
      } satisfies PriceGroupAssignmentResolutionResponse;
      const absent = sourceResult({
        effectiveAt,
        family: 'COMMERCIAL_CONTEXT',
        ownerModuleId: 'commerce.customer-context',
        ownerRootRef: 'group-assignments:786',
        predicateRef: 'group-assignment:profile-786',
        tag: 'VERIFIED_ABSENT',
        tenantId,
      });
      const service = makePricingExternalOwnerEvidenceValidationService();
      const result = yield* service.validatePriceGroupAssignment({
        expectedEffectiveAt: effectiveAt,
        expectedOwnerRootRef: 'group-assignments:786',
        expectedPredicateRef: 'group-assignment:profile-786',
        expectedProfile: profile,
        requestedAt: effectiveAt,
        response,
        sourceEvidence: absent,
      });
      expect(result.ownerPayload).toBe(response);
      expect(Schema.is(PricingSourceEvidenceVerifiedAbsentSchema)(result.sourceEvidence)).toBe(true);

      const unavailable = sourceResult({
        effectiveAt,
        family: 'COMMERCIAL_CONTEXT',
        ownerModuleId: 'commerce.customer-context',
        ownerRootRef: 'group-assignments:786',
        predicateRef: 'group-assignment:profile-786',
        tag: 'UNVERIFIABLE',
        tenantId,
      });
      const outage = yield* service.validatePriceGroupAssignment({
        expectedEffectiveAt: effectiveAt,
        expectedOwnerRootRef: 'group-assignments:786',
        expectedPredicateRef: 'group-assignment:profile-786',
        expectedProfile: profile,
        requestedAt: effectiveAt,
        sourceEvidence: unavailable,
      });
      expect(outage.ownerPayload).toBeUndefined();
      expect(Schema.is(PricingSourceEvidenceUnverifiableSchema)(outage.sourceEvidence)).toBe(true);
      if (Schema.is(PricingSourceEvidenceUnverifiableSchema)(outage.sourceEvidence)) {
        expect(outage.sourceEvidence.reason).toBe('OWNER_UNAVAILABLE');
      }

      const conflictResponse = {
        ...response,
        resolution: { _tag: 'INCONSISTENT' as const, currentAssignmentCount: 2 },
      };
      const conflict = sourceResult({
        effectiveAt,
        family: 'COMMERCIAL_CONTEXT',
        ownerModuleId: 'commerce.customer-context',
        ownerRootRef: 'group-assignments:786',
        predicateRef: 'group-assignment:profile-786',
        tag: 'CONFLICT',
        tenantId,
      });
      const cardinality = yield* service.validatePriceGroupAssignment({
        expectedEffectiveAt: effectiveAt,
        expectedOwnerRootRef: 'group-assignments:786',
        expectedPredicateRef: 'group-assignment:profile-786',
        expectedProfile: profile,
        requestedAt: effectiveAt,
        response: conflictResponse,
        sourceEvidence: conflict,
      });
      if (cardinality.ownerPayload === undefined) {
        throw new Error('fixture requires owner cardinality response');
      }
      const assignmentCount = Match.value(cardinality.ownerPayload.resolution).pipe(
        Match.tag('INCONSISTENT', ({ currentAssignmentCount }) => currentAssignmentCount),
        Match.orElse(() => 0),
      );
      expect(assignmentCount).toBe(2);
      expect(Schema.is(PricingSourceEvidenceConflictSchema)(cardinality.sourceEvidence)).toBe(true);
    }),
  );

  it.effect('preserves Promotion eligible-set proof and rejects a consumer-substituted set revision', () =>
    Effect.gen(function* promotionEvidence() {
      const scenario = yield* makeIssue779Scenario();
      const { promotionComposition } = scenario.compositionRequest;
      if (promotionComposition.kind !== 'PROMOTION_SELECTED') {
        throw new Error('fixture requires selected Promotion evaluation');
      }
      const selectedPromotionComposition = promotionComposition.composition;
      const { promotion } = selectedPromotionComposition;
      if (promotion.outcome !== 'PROMOTION_NOT_APPLICABLE') {
        throw new Error('fixture requires non-applicability');
      }
      const outcome = yield* Schema.decodeEffect(PromotionContributionOutcomeSchema)({
        _tag: 'PROMOTION_CONTRIBUTION_NOT_APPLICABLE',
        ownerEvidence: promotion.ownerEvidence,
        reason: promotion.reason,
        request: {
          applicationRequestRef: promotion.acceptedRequest.applicationRequestRef,
          candidate: {
            candidateRef: promotion.acceptedRequest.candidateRef,
            decision: scenario.compositionRequest.decision,
          },
          currencyCompatibility: selectedPromotionComposition.currentnessEvidence.currencySupport,
          exactPredicateRef: promotion.acceptedRequest.exactPredicateRef,
          prePromotionBasis: {
            completedPricingAllocationRefs: selectedPromotionComposition.completedPricingAllocationRefs,
            currencyCode: scenario.compositionRequest.decision.currencyCode,
            lines: selectedPromotionComposition.lines.map((line) => ({
              amount: line.prePromotionValue,
              catalogSelection: line.catalogSelection,
              occurrenceId: line.occurrenceId,
            })),
            monetaryBoundary: 'PRE_TAX',
            pricingCompositionRef: selectedPromotionComposition.currentnessEvidence.pricingCompositionRef,
            pricingCompositionRevision: selectedPromotionComposition.currentnessEvidence.pricingCompositionRevision,
            stage: 'AFTER_PRICE_TIER_FEES_AND_ALL_PRICING_DISCOUNTS',
          },
          subjectEvidence: promotion.acceptedRequest.subjectEvidence,
        },
      });
      const source = sourceResult({
        completeness: promotion.ownerEvidence.completenessEvidence,
        effectiveAt: outcome.request.candidate.decision.operationTime,
        family: 'PROMOTION',
        ownerModuleId: 'commerce.promotion',
        ownerRootRef: 'promotion-root:786',
        predicateRef: outcome.request.exactPredicateRef,
        requestedAt: outcome.request.candidate.decision.operationTime,
        tag: 'VERIFIED_ABSENT',
        tenantId: outcome.request.candidate.decision.tenantId,
      });
      const service = makePricingExternalOwnerEvidenceValidationService();
      const result = yield* service.validatePromotion({
        expectedOwnerRootRef: 'promotion-root:786',
        expectedPredicateRef: outcome.request.exactPredicateRef,
        outcome,
        requestedAt: outcome.request.candidate.decision.operationTime,
        sourceEvidence: source,
      });
      expect(result.ownerPayload).toBe(outcome);
      expect(result.sourceEvidence).toBe(source);

      if (!Schema.is(PricingSourceEvidenceVerifiedAbsentSchema)(source)) {
        throw new Error('fixture requires absence proof');
      }
      const substituted = {
        ...source,
        completeness: {
          ...source.completeness,
          completenessEvidence: {
            ...source.completeness.completenessEvidence,
            ownerRevision: 'consumer-invented-revision',
          },
          ownerSetRevisionRef: 'consumer-invented-revision',
        },
      };
      const failure = yield* service
        .validatePromotion({
          expectedOwnerRootRef: 'promotion-root:786',
          expectedPredicateRef: outcome.request.exactPredicateRef,
          outcome,
          requestedAt: outcome.request.candidate.decision.operationTime,
          sourceEvidence: substituted,
        })
        .pipe(Effect.flip);
      expect(failure.reason).toBe('OWNER_EVIDENCE_MISMATCH');
    }),
  );

  it.effect('retains the exact validated Catalog, Market, Group, and Promotion proofs for one candidate', () =>
    Effect.gen(function* retainedOwnerProofs() {
      const scenario = yield* makeIssue779Scenario();
      const { decision } = scenario.compositionRequest;
      const [line] = decision.lines;
      if (line === undefined) {
        throw new Error('fixture requires one line');
      }
      const requestedAt = decision.operationTime;
      const catalogSource = sourceResult({
        effectiveAt: decision.operationTime,
        family: 'COMMERCIAL_CONTEXT',
        ownerModuleId: 'commerce.catalog',
        ownerRootRef: 'catalog-root:retained-786',
        predicateRef: 'catalog-selection:retained-786',
        requestedAt,
        tag: 'VERIFIED_PRESENT',
        tenantId: decision.tenantId,
      });
      const marketSource = sourceResult({
        effectiveAt: decision.operationTime,
        factRef: decision.commercialScope.marketId,
        family: 'COMMERCIAL_CONTEXT',
        ownerModuleId: 'commerce.market-catalog',
        ownerRootRef: 'market-root:retained-786',
        predicateRef: 'market-selection:retained-786',
        requestedAt,
        tag: 'VERIFIED_PRESENT',
        tenantId: decision.tenantId,
      });
      if (!Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(marketSource)) {
        throw new Error('fixture requires verified Market evidence');
      }
      const marketResponse = presentMarketResponse(decision, marketSource);
      const profile = {
        kind: 'RETAIL' as const,
        moduleId: 'commerce.customer-context' as const,
        resourceId: 'profile:retained-786',
        resourceType: 'commerce.customer-context.retail-customer-profile' as const,
        tenantId: decision.tenantId,
      };
      const groupResponse = {
        effectiveAt: decision.operationTime,
        profile,
        resolution: { _tag: 'NONE' as const },
      } satisfies PriceGroupAssignmentResolutionResponse;
      const groupSource = sourceResult({
        effectiveAt: decision.operationTime,
        family: 'COMMERCIAL_CONTEXT',
        ownerModuleId: 'commerce.customer-context',
        ownerRootRef: 'group-root:retained-786',
        predicateRef: 'group-assignment:retained-786',
        requestedAt,
        tag: 'VERIFIED_ABSENT',
        tenantId: decision.tenantId,
      });
      const { promotionComposition } = scenario.compositionRequest;
      if (promotionComposition.kind !== 'PROMOTION_SELECTED') {
        throw new Error('fixture requires selected Promotion evaluation');
      }
      const selectedPromotionComposition = promotionComposition.composition;
      const { promotion } = selectedPromotionComposition;
      if (promotion.outcome !== 'PROMOTION_NOT_APPLICABLE') {
        throw new Error('fixture requires non-applicable Promotion');
      }
      const promotionOutcome = yield* Schema.decodeEffect(PromotionContributionOutcomeSchema)({
        _tag: 'PROMOTION_CONTRIBUTION_NOT_APPLICABLE',
        ownerEvidence: promotion.ownerEvidence,
        reason: promotion.reason,
        request: {
          applicationRequestRef: promotion.acceptedRequest.applicationRequestRef,
          candidate: { candidateRef: promotion.acceptedRequest.candidateRef, decision },
          currencyCompatibility: selectedPromotionComposition.currentnessEvidence.currencySupport,
          exactPredicateRef: promotion.acceptedRequest.exactPredicateRef,
          prePromotionBasis: {
            completedPricingAllocationRefs: selectedPromotionComposition.completedPricingAllocationRefs,
            currencyCode: decision.currencyCode,
            lines: selectedPromotionComposition.lines.map((promotionLine) => ({
              amount: promotionLine.prePromotionValue,
              catalogSelection: promotionLine.catalogSelection,
              occurrenceId: promotionLine.occurrenceId,
            })),
            monetaryBoundary: 'PRE_TAX',
            pricingCompositionRef: selectedPromotionComposition.currentnessEvidence.pricingCompositionRef,
            pricingCompositionRevision: selectedPromotionComposition.currentnessEvidence.pricingCompositionRevision,
            stage: 'AFTER_PRICE_TIER_FEES_AND_ALL_PRICING_DISCOUNTS',
          },
          subjectEvidence: promotion.acceptedRequest.subjectEvidence,
        },
      });
      const promotionSource = sourceResult({
        completeness: promotion.ownerEvidence.completenessEvidence,
        effectiveAt: decision.operationTime,
        family: 'PROMOTION',
        ownerModuleId: 'commerce.promotion',
        ownerRootRef: 'promotion-root:retained-786',
        predicateRef: promotionOutcome.request.exactPredicateRef,
        requestedAt,
        tag: 'VERIFIED_ABSENT',
        tenantId: decision.tenantId,
      });
      const service = makePricingExternalOwnerEvidenceValidationService();
      const catalog = yield* service.validateCatalogSelection({
        assessment: line.catalog.evidence,
        expectedEffectiveAt: decision.operationTime,
        expectedOwnerRootRef: 'catalog-root:retained-786',
        expectedPredicateRef: 'catalog-selection:retained-786',
        expectedSelection: line.catalog.selection,
        requestedAt,
        sourceEvidence: catalogSource,
      });
      const market = yield* service.validateMarket({
        expectedCommercialScope: decision.commercialScope,
        expectedEffectiveAt: decision.operationTime,
        expectedOwnerRootRef: 'market-root:retained-786',
        expectedPredicateRef: 'market-selection:retained-786',
        requestedAt,
        response: marketResponse,
        sourceEvidence: marketSource,
        tenantId: decision.tenantId,
      });
      const group = yield* service.validatePriceGroupAssignment({
        expectedEffectiveAt: decision.operationTime,
        expectedOwnerRootRef: 'group-root:retained-786',
        expectedPredicateRef: 'group-assignment:retained-786',
        expectedProfile: profile,
        requestedAt,
        response: groupResponse,
        sourceEvidence: groupSource,
      });
      const validatedPromotion = yield* service.validatePromotion({
        expectedOwnerRootRef: 'promotion-root:retained-786',
        expectedPredicateRef: promotionOutcome.request.exactPredicateRef,
        outcome: promotionOutcome,
        requestedAt,
        sourceEvidence: promotionSource,
      });
      const subject = {
        authorizationSubject: { kind: 'RETAIL' as const },
        kind: 'PROFILE' as const,
        profileRef: profile,
      };
      const retained = yield* service.retainValidatedOwnerEvidence({
        candidateRef: promotionOutcome.request.candidate.candidateRef,
        catalogSelections: [{ occurrenceId: line.occurrenceId, validation: catalog }],
        decision,
        market,
        priceGroupAssignment: group,
        promotion: { kind: 'PROMOTION_SELECTED', validation: validatedPromotion },
        requestedAt,
        subject,
        validatedAt: requestedAt,
      });

      expect(retained.catalogSelections[0]?.sourceEvidence).toBe(catalogSource);
      expect(retained.market).toBe(marketSource);
      expect(retained.priceGroupAssignment).toBe(groupSource);
      expect(retained.promotion).toEqual({ kind: 'PROMOTION_SELECTED', sourceEvidence: promotionSource });
      expect('storefrontId' in retained.decision.commercialScope).toBe(false);

      const withoutPromotion = yield* service.retainValidatedOwnerEvidence({
        candidateRef: promotionOutcome.request.candidate.candidateRef,
        catalogSelections: [{ occurrenceId: line.occurrenceId, validation: catalog }],
        decision,
        market,
        priceGroupAssignment: group,
        promotion: { kind: 'PROMOTION_NOT_SELECTED' },
        requestedAt,
        subject,
        validatedAt: requestedAt,
      });
      expect(withoutPromotion.promotion).toEqual({ kind: 'PROMOTION_NOT_SELECTED' });

      const unavailableGroup = yield* service.validatePriceGroupAssignment({
        expectedEffectiveAt: decision.operationTime,
        expectedOwnerRootRef: 'group-root:retained-786',
        expectedPredicateRef: 'group-assignment:retained-786',
        expectedProfile: profile,
        requestedAt,
        sourceEvidence: sourceResult({
          effectiveAt: decision.operationTime,
          family: 'COMMERCIAL_CONTEXT',
          ownerModuleId: 'commerce.customer-context',
          ownerRootRef: 'group-root:retained-786',
          predicateRef: 'group-assignment:retained-786',
          requestedAt,
          tag: 'UNVERIFIABLE',
          tenantId: decision.tenantId,
        }),
      });
      const unavailableFailure = yield* service
        .retainValidatedOwnerEvidence({
          candidateRef: promotionOutcome.request.candidate.candidateRef,
          catalogSelections: [{ occurrenceId: line.occurrenceId, validation: catalog }],
          decision,
          market,
          priceGroupAssignment: unavailableGroup,
          promotion: { kind: 'PROMOTION_SELECTED', validation: validatedPromotion },
          requestedAt,
          subject,
          validatedAt: requestedAt,
        })
        .pipe(Effect.flip);
      expect(unavailableFailure.reason).toBe('OWNER_EVIDENCE_MISMATCH');
    }),
  );
});
