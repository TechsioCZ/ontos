import type { PricingCommercialTotalRequest } from '@app/pricing-contracts/domain/commercial-total';
import { PricingCurrentMarketEvidenceResponseSchema } from '@app/commerce-market-catalog/api/pricing-current-market-evidence';
import { PRICING_CZK_PUBLICATION_PROFILE } from '@app/pricing-contracts/domain/exact-decimal';
import {
  PricingMaterialEvidenceMissingFailure,
  PricingMaterialEvidenceUnverifiableFailure,
} from '@app/pricing-contracts/domain/material-evidence';
import type { PricingMaterialEvidenceAssemblyRequest } from '@app/pricing-contracts/domain/material-evidence';
import type {
  PricingSourceEvidenceFamily,
  PricingSourceEvidenceResult,
} from '@app/pricing-contracts/domain/source-revision-evidence';
import {
  PricingSourceEvidenceResultSchema,
  PricingSourceEvidenceVerifiedPresentSchema,
} from '@app/pricing-contracts/domain/source-revision-evidence';
import { PromotionContributionOutcomeSchema } from '@app/pricing-contracts/domain/promotion-contribution';
import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  assemblePricingMaterialEvidence,
  pricingLineDiscountApplicabilityPredicateRef,
  pricingWholePurchaseDiscountApplicabilityPredicateRef,
} from '../../src/services/material-evidence-assembly.service.ts';
import { calculatePricingCommercialTotals } from '../../src/services/commercial-totals.service.ts';
import {
  PricingExternalOwnerEvidenceValidation,
  makePricingExternalOwnerEvidenceValidationService,
} from '../../src/services/external-owner-evidence-validation.service.ts';
import { PricingMaterialEvidenceOwnerFinalFence } from '../../src/services/material-evidence-final-validation.service.ts';
import type { PricingOrdinaryCurrentPublicationRequest } from '../../src/services/ordinary-current-pricing-publication.service.ts';
import {
  PricingOrdinaryCurrentPublicationIndeterminate,
  publishOrdinaryCurrentPricingForCustomer,
} from '../../src/services/ordinary-current-pricing-publication.service.ts';
import { unitPriceGroupAbsencePredicateRef } from '../../src/services/unit-price-material-evidence.service.ts';
import { candidateRef, makeIssue779PreRoundScenario, money } from './support/issue-779-line-value.fixture.ts';

const decodedSource = Schema.decodeUnknownSync(PricingSourceEvidenceResultSchema, {
  onExcessProperty: 'error',
});

const currentSource = ({
  effectiveAt,
  factRefs,
  family,
  observedAt,
  ownerModuleId = 'commerce.pricing',
  ownerRevision,
  predicateRef,
  revisionRefs,
  tenantId,
}: {
  readonly effectiveAt: string;
  readonly factRefs?: readonly string[];
  readonly family: PricingSourceEvidenceFamily;
  readonly observedAt: string;
  readonly ownerModuleId?: string;
  readonly ownerRevision: string;
  readonly predicateRef: string;
  readonly revisionRefs: readonly string[];
  readonly tenantId: string;
}): PricingSourceEvidenceResult => {
  const ownerScope = {
    ownerModuleId,
    ownerRootRef: `pricing-root:${family}:${predicateRef}`,
    predicateRef,
    tenantId,
  };
  const temporal = {
    effectiveAt,
    evaluatedAt: effectiveAt,
    evaluationMode: 'HISTORICAL_AS_OF' as const,
    nextMaterialBoundary: '2026-09-28T13:00:00.000Z',
    observedAt,
    requestedAt: effectiveAt,
  };
  const request = { currencyCode: 'CZK', effectiveAt, family, ownerScope, requestedAt: effectiveAt };
  const completeness = {
    completenessEvidence: {
      nextApplicabilityBoundary: temporal.nextMaterialBoundary,
      observedAt,
      ownerRevision,
      scope: { kind: 'EXACT_PREDICATE' as const, predicateRef },
    },
    currencyCode: 'CZK',
    family,
    ownerScope,
    ownerSetRevisionRef: ownerRevision,
    temporal,
    verification: {
      kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE' as const,
      verificationRef: `pricing-proof:set:${family}:${predicateRef}`,
    },
  };
  return decodedSource(
    revisionRefs.length === 0
      ? { _tag: 'VERIFIED_ABSENT', completeness, request }
      : {
          _tag: 'VERIFIED_PRESENT',
          completeness,
          currentFacts: revisionRefs.map((factRevisionRef, index) => ({
            currencyCode: 'CZK',
            effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
            factRef: factRefs?.[index] ?? `pricing-fact:${family}:${index}`,
            factRevisionRef,
            family,
            ownerScope,
            temporal,
            verification: {
              kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE' as const,
              verificationRef: `pricing-proof:fact:${family}:${index}`,
            },
          })),
          request,
        },
  );
};

const readyRequest = Effect.fn('test.issue786ReadyRequest')(function* readyRequestProgram() {
  const { preRound } = yield* makeIssue779PreRoundScenario();
  const [line] = preRound.lines;
  if (line === undefined) {
    throw new Error('Issue #786 fixture requires one exact Pricing line');
  }
  const totalRequest: PricingCommercialTotalRequest = {
    candidateRef,
    decision: preRound.decision,
    preRound,
    publishedLines: [
      {
        occurrenceId: line.occurrenceId,
        publicationProfile: PRICING_CZK_PUBLICATION_PROFILE,
        publishedLineValue: money(line.nonNegativePreRoundValue.amount),
        roundingAdjustment: money('0'),
      },
    ],
  };
  const total = yield* calculatePricingCommercialTotals(totalRequest);
  if (total.outcome !== 'COMMERCIAL_TOTAL_READY') {
    throw new Error(`Issue #786 fixture requires a ready commercial total: ${total.failure.message}`);
  }
  const [totalLine] = total.sourceEvidence.preRound.lines;
  if (totalLine === undefined) {
    throw new Error('Issue #786 fixture requires retained line source evidence');
  }
  const unitPrice = totalLine.composition.unitPriceCalculation;
  const { path } = unitPrice.input.exactPrice;
  if (!('usedPrice' in path)) {
    throw new Error('Issue #786 fixture requires a used exact Price');
  }
  const { operationTime: observedAt, tenantId } = total.decision;
  const { currencySupport: support } = unitPrice.input.exactPrice;
  const { tierSet } = unitPrice.input.tierSelection.evidence.input;
  const { feeSet } = totalLine.composition.feeCalculation.input;
  const externalSource = (
    ownerModuleId: string,
    family: 'COMMERCIAL_CONTEXT' | 'PROMOTION',
    predicateRef: string,
    present: boolean,
    factRef?: string,
  ) => {
    const common = {
      effectiveAt: observedAt,
      family,
      observedAt,
      ownerModuleId,
      ownerRevision: `${predicateRef}:set-r786`,
      predicateRef,
      tenantId,
    };
    return present
      ? currentSource({
          ...common,
          factRefs: [factRef ?? `${predicateRef}:fact`],
          revisionRefs: [`${predicateRef}:fact-r786`],
        })
      : currentSource({ ...common, revisionRefs: [] });
  };
  const revalidatedAt =
    support.currentnessEvidence.evaluationMode === 'CURRENT_WITH_REVALIDATION'
      ? support.currentnessEvidence.revalidatedAt
      : support.observedAt;
  const promotionSelection = total.sourceEvidence.preRound.rawComposition.promotionComposition;
  if (promotionSelection.kind !== 'PROMOTION_SELECTED') {
    throw new Error('Issue #786 fixture requires selected Promotion evaluation');
  }
  const promotionOwnerEvidence = promotionSelection.composition.promotion.ownerEvidence;
  const promotionPredicateRef = promotionOwnerEvidence.exactPredicateRef;
  const promotionOwnerScope = {
    ownerModuleId: 'commerce.promotion',
    ownerRootRef: `pricing-root:PROMOTION:${promotionPredicateRef}`,
    predicateRef: promotionPredicateRef,
    tenantId,
  };
  const promotionRequest = {
    effectiveAt: observedAt,
    family: 'PROMOTION' as const,
    ownerScope: promotionOwnerScope,
    requestedAt: observedAt,
  };
  const promotionTemporalBase = {
    effectiveAt: observedAt,
    evaluatedAt: observedAt,
    evaluationMode: 'HISTORICAL_AS_OF' as const,
    observedAt: promotionOwnerEvidence.completenessEvidence.observedAt,
    requestedAt: observedAt,
  };
  const promotionTemporal =
    promotionOwnerEvidence.completenessEvidence.nextApplicabilityBoundary === undefined
      ? promotionTemporalBase
      : {
          ...promotionTemporalBase,
          nextMaterialBoundary: promotionOwnerEvidence.completenessEvidence.nextApplicabilityBoundary,
        };
  const promotionSource = decodedSource({
    _tag: 'VERIFIED_ABSENT',
    completeness: {
      completenessEvidence: promotionOwnerEvidence.completenessEvidence,
      family: 'PROMOTION',
      ownerScope: promotionOwnerScope,
      ownerSetRevisionRef: promotionOwnerEvidence.ownerRevision,
      temporal: promotionTemporal,
      verification: {
        kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE',
        verificationRef: `pricing-proof:set:PROMOTION:${promotionPredicateRef}`,
      },
    },
    request: promotionRequest,
  });
  const request: PricingMaterialEvidenceAssemblyRequest = {
    commercialTotal: total,
    currencySupport: currentSource({
      effectiveAt: observedAt,
      factRefs: [support.supportRootRef.resourceId],
      family: 'CURRENCY_SUPPORT',
      observedAt: support.observedAt,
      ownerRevision: support.supportRevisionRef.resourceId,
      predicateRef: support.completenessEvidence.scope.predicateRef,
      revisionRefs: [support.supportRevisionRef.resourceId],
      tenantId,
    }),
    externalOwnerEvidence: {
      candidateRef: total.candidateRef,
      catalogSelections: total.decision.lines.map(({ occurrenceId }) => ({
        occurrenceId,
        sourceEvidence: externalSource(
          'commerce.catalog',
          'COMMERCIAL_CONTEXT',
          `catalog-selection:${occurrenceId}`,
          true,
        ),
      })),
      decision: total.decision,
      market: externalSource(
        'commerce.market-catalog',
        'COMMERCIAL_CONTEXT',
        'market-context:786',
        true,
        total.decision.commercialScope.marketId,
      ),
      priceGroupAssignment: externalSource(
        'commerce.customer-context',
        'COMMERCIAL_CONTEXT',
        'price-group-assignment:786',
        false,
      ),
      promotion: { kind: 'PROMOTION_SELECTED', sourceEvidence: promotionSource },
      requestedAt: observedAt,
      subject: {
        authorizationSubject: { kind: 'RETAIL' },
        kind: 'PROFILE',
        profileRef: {
          moduleId: 'commerce.customer-context',
          resourceId: total.decision.purchasingContext.contextRef,
          resourceType: 'commerce.customer-context.retail-customer-profile',
          tenantId,
        },
      },
      validatedAt: revalidatedAt,
    },
    lines: [
      {
        commercialFees: currentSource({
          effectiveAt: observedAt,
          factRefs: feeSet.fees.map(({ definition }) => definition.feeRef.resourceId),
          family: 'COMMERCIAL_FEE',
          observedAt,
          ownerRevision: feeSet.completenessEvidence.ownerRevision,
          predicateRef: feeSet.completenessEvidence.scope.predicateRef,
          revisionRefs: feeSet.fees.map(({ definition }) => definition.revision.revisionId),
          tenantId,
        }),
        lineDiscounts: {
          kind: 'DISCOUNT_SELECTED',
          sourceEvidence: currentSource({
            effectiveAt: observedAt,
            factRefs: totalLine.composition.lineDiscountContributions.map(
              ({ candidate }) => candidate.definition.discountId,
            ),
            family: 'DISCOUNT',
            observedAt,
            ownerRevision: 'pricing-discounts:786',
            predicateRef: pricingLineDiscountApplicabilityPredicateRef(total, totalLine),
            revisionRefs: totalLine.composition.lineDiscountContributions.map(
              ({ candidate }) => candidate.definition.revision.revisionId,
            ),
            tenantId,
          }),
        },
        occurrenceId: line.occurrenceId,
        pricePath: {
          usedPrice: currentSource({
            effectiveAt: observedAt,
            factRefs: [path.usedPrice.priceRef.resourceId],
            family: 'PRICE',
            observedAt: path.usedPrice.evidence.observedAt,
            ownerRevision: path.usedPrice.evidence.ownerRevision,
            predicateRef: unitPriceGroupAbsencePredicateRef(path.usedPrice.request),
            revisionRefs: [path.usedPrice.priceRevision.revisionId],
            tenantId,
          }),
        },
        quantityTiers: currentSource({
          effectiveAt: observedAt,
          family: 'QUANTITY_TIER',
          observedAt: DateTime.formatIso(tierSet.completenessEvidence.observedAt),
          ownerRevision: tierSet.completenessEvidence.ownerRevision,
          predicateRef: tierSet.completenessEvidence.scope.predicateRef,
          revisionRefs: tierSet.currentTiers.map(({ definition }) => definition.revision.revisionId),
          tenantId,
        }),
      },
    ],
    requestedAt: observedAt,
    revalidatedAt,
    wholePurchase: {
      contractualDiscounts: {
        kind: 'DISCOUNT_SELECTED',
        sourceEvidence: currentSource({
          effectiveAt: observedAt,
          family: 'DISCOUNT',
          observedAt,
          ownerRevision: 'pricing-whole-discounts:786',
          predicateRef: pricingWholePurchaseDiscountApplicabilityPredicateRef(total),
          revisionRefs: [],
          tenantId,
        }),
      },
    },
  };
  return request;
});

const ownerExpectation = (sourceEvidence: PricingSourceEvidenceResult) => ({
  expectedOwnerRootRef: sourceEvidence.request.ownerScope.ownerRootRef,
  expectedPredicateRef: sourceEvidence.request.ownerScope.predicateRef,
  requestedAt: sourceEvidence.request.requestedAt,
});

const publicationRequest = Effect.fn('test.issue786PublicationRequest')(function* publicationRequestProgram() {
  const materialEvidence = yield* readyRequest();
  const { commercialTotal, externalOwnerEvidence } = materialEvidence;
  const { decision } = commercialTotal;
  const marketEvidence = externalOwnerEvidence.market;
  if (!Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(marketEvidence)) {
    throw new Error('Issue #786 publication fixture requires present Commerce Market evidence');
  }
  const [marketFact] = marketEvidence.currentFacts;
  if (marketFact === undefined) {
    throw new Error('Issue #786 publication fixture requires one Current Commerce Market fact');
  }
  const marketResponse = yield* Schema.decodeUnknownEffect(PricingCurrentMarketEvidenceResponseSchema)({
    market: {
      channels: [decision.commercialScope.channelId],
      definitionRevisionRef: {
        moduleId: 'commerce.market-catalog',
        resourceId: 'market-definition:786',
        resourceType: 'commerce.market-catalog.market-definition-revision',
        tenantId: decision.tenantId,
      },
      effectivePeriod: { startsAt: marketFact.effectivePeriod.effectiveFrom },
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
      authority: {
        generation: 1,
        nextApplicabilityBoundary: marketEvidence.completeness.temporal.nextMaterialBoundary,
        observedAt: marketEvidence.completeness.temporal.observedAt,
        ownerRootRef: marketEvidence.completeness.ownerScope.ownerRootRef,
        ownerSetRevisionRef: marketEvidence.completeness.ownerSetRevisionRef,
        predicateRef: marketEvidence.completeness.ownerScope.predicateRef,
        verificationRef: marketEvidence.completeness.verification.verificationRef,
      },
      currentFacts: [
        {
          effectivePeriod: { startsAt: marketFact.effectivePeriod.effectiveFrom },
          factRef: marketFact.factRef,
          factRevisionRef: marketFact.factRevisionRef,
          verificationRef: marketFact.verification.verificationRef,
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
      requestedAt: marketEvidence.request.requestedAt,
    },
  });
  const profile = {
    kind: 'RETAIL' as const,
    moduleId: 'commerce.customer-context' as const,
    resourceId: decision.purchasingContext.contextRef,
    resourceType: 'commerce.customer-context.retail-customer-profile' as const,
    tenantId: decision.tenantId,
  };
  const groupResponse = {
    effectiveAt: decision.operationTime,
    profile,
    resolution: { _tag: 'NONE' as const },
  };
  const promotionSelection = commercialTotal.sourceEvidence.preRound.rawComposition.promotionComposition;
  if (promotionSelection.kind !== 'PROMOTION_SELECTED') {
    throw new Error('Issue #786 publication fixture requires selected Promotion evaluation');
  }
  if (externalOwnerEvidence.promotion.kind !== 'PROMOTION_SELECTED') {
    throw new Error('Issue #786 publication fixture requires retained selected Promotion evidence');
  }
  const priceGroupAssignmentEvidence = externalOwnerEvidence.priceGroupAssignment;
  if (priceGroupAssignmentEvidence === undefined) {
    throw new Error('Issue #786 publication fixture requires retained Price Group evidence');
  }
  const promotionComposition = promotionSelection.composition;
  const promotionSourceEvidence = externalOwnerEvidence.promotion.sourceEvidence;
  const { promotion } = promotionComposition;
  if (promotion.outcome !== 'PROMOTION_NOT_APPLICABLE') {
    throw new Error('Issue #786 publication fixture requires a non-applicable Promotion decision');
  }
  const promotionOutcome = yield* Schema.decodeEffect(PromotionContributionOutcomeSchema)({
    _tag: 'PROMOTION_CONTRIBUTION_NOT_APPLICABLE',
    ownerEvidence: promotion.ownerEvidence,
    reason: promotion.reason,
    request: {
      applicationRequestRef: promotion.acceptedRequest.applicationRequestRef,
      candidate: { candidateRef: commercialTotal.candidateRef, decision },
      currencyCompatibility: promotionComposition.currentnessEvidence.currencySupport,
      exactPredicateRef: promotion.acceptedRequest.exactPredicateRef,
      prePromotionBasis: {
        completedPricingAllocationRefs: promotionComposition.completedPricingAllocationRefs,
        currencyCode: decision.currencyCode,
        lines: promotionComposition.lines.map((line) => ({
          amount: line.prePromotionValue,
          catalogSelection: line.catalogSelection,
          occurrenceId: line.occurrenceId,
        })),
        monetaryBoundary: 'PRE_TAX',
        pricingCompositionRef: promotionComposition.currentnessEvidence.pricingCompositionRef,
        pricingCompositionRevision: promotionComposition.currentnessEvidence.pricingCompositionRevision,
        stage: 'AFTER_PRICE_TIER_FEES_AND_ALL_PRICING_DISCOUNTS',
      },
      subjectEvidence: promotion.acceptedRequest.subjectEvidence,
    },
  });
  const catalog = decision.lines.map((line, index) => {
    const retained = externalOwnerEvidence.catalogSelections[index];
    if (retained === undefined) {
      throw new Error('Issue #786 publication fixture requires one Catalog proof for every Pricing line');
    }
    return {
      assessment: line.catalog.evidence,
      expectedEffectiveAt: decision.operationTime,
      expectedSelection: line.catalog.selection,
      ...ownerExpectation(retained.sourceEvidence),
      sourceEvidence: retained.sourceEvidence,
    };
  });
  const [firstCatalog, ...remainingCatalog] = catalog;
  if (firstCatalog === undefined) {
    throw new Error('Issue #786 publication fixture requires at least one Catalog proof');
  }
  return {
    externalOwnerEvidence: {
      catalog: [firstCatalog, ...remainingCatalog],
      market: {
        expectedCommercialScope: decision.commercialScope,
        expectedEffectiveAt: decision.operationTime,
        response: marketResponse,
        ...ownerExpectation(marketEvidence),
        sourceEvidence: marketEvidence,
        tenantId: decision.tenantId,
      },
      priceGroup: {
        expectedEffectiveAt: decision.operationTime,
        expectedProfile: profile,
        response: groupResponse,
        ...ownerExpectation(priceGroupAssignmentEvidence),
        sourceEvidence: priceGroupAssignmentEvidence,
      },
      promotion: {
        kind: 'PROMOTION_SELECTED',
        validation: {
          outcome: promotionOutcome,
          ...ownerExpectation(promotionSourceEvidence),
          sourceEvidence: promotionSourceEvidence,
        },
      },
      subject: externalOwnerEvidence.subject,
    },
    materialEvidence,
  } satisfies PricingOrdinaryCurrentPublicationRequest;
});

const unavailableOwnerFence = (calls: string[]) => ({
  verifyImmediatelyBeforePublication: () => {
    calls.push('unexpected owner fence call');
    return Effect.die(new Error('The owner fence cannot run without exact typed owner authority'));
  },
});

describe('Pricing-owned material evidence assembly #786', () => {
  it.effect('binds independent fact-currentness and complete-set proof to the full commercial result', () =>
    Effect.gen(function* acceptsCompleteEvidence() {
      const request = yield* readyRequest();
      const result = yield* assemblePricingMaterialEvidence(request);

      expect(result.outcome).toBe('PRICING_MATERIAL_EVIDENCE_READY');
      expect(result.sourceEvidence.commercialTotal).toEqual(request.commercialTotal);
      expect(result.calculationVersions).toEqual(request.commercialTotal.calculationVersions);
    }),
  );

  it.effect('fails typed when a required Pricing-owned Current fact is owner-proven absent', () =>
    Effect.gen(function* refusesAbsentUsedPrice() {
      const request = yield* readyRequest();
      const [line] = request.lines;
      if (line === undefined || !Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(line.pricePath.usedPrice)) {
        throw new Error('Issue #786 fixture requires present Price evidence');
      }
      const failure = yield* assemblePricingMaterialEvidence({
        ...request,
        lines: [
          {
            ...line,
            pricePath: {
              usedPrice: {
                _tag: 'VERIFIED_ABSENT',
                completeness: line.pricePath.usedPrice.completeness,
                request: line.pricePath.usedPrice.request,
              },
            },
          },
        ],
      }).pipe(Effect.flip);

      expect(Schema.is(PricingMaterialEvidenceMissingFailure)(failure)).toBe(true);
      expect(failure.family).toBe('PRICE');
    }),
  );

  it.effect('fails typed when final validation reaches an owner-declared material boundary', () =>
    Effect.gen(function* refusesExpiredProof() {
      const request = yield* readyRequest();
      const failure = yield* assemblePricingMaterialEvidence({
        ...request,
        revalidatedAt: '2026-09-28T13:00:00.000Z',
      }).pipe(Effect.flip);

      const isUnverifiable = Schema.is(PricingMaterialEvidenceUnverifiableFailure)(failure);
      expect(isUnverifiable).toBe(true);
      if (!isUnverifiable) {
        throw new Error('Issue #786 fixture requires typed unverifiable failure');
      }
      expect(failure.retryable).toBe(false);
    }),
  );

  it.effect('rejects absence proof for another Variant, line, or applicability scope', () =>
    Effect.gen(function* refusesWrongDiscountAbsencePredicate() {
      const request = yield* readyRequest();
      const [line] = request.lines;
      if (line === undefined) {
        throw new Error('Issue #786 fixture requires one material-evidence line');
      }
      const failure = yield* assemblePricingMaterialEvidence({
        ...request,
        lines: [
          {
            ...line,
            lineDiscounts: {
              kind: 'DISCOUNT_SELECTED',
              sourceEvidence: currentSource({
                effectiveAt: request.commercialTotal.decision.operationTime,
                family: 'DISCOUNT',
                observedAt: request.commercialTotal.decision.operationTime,
                ownerRevision: 'pricing-discounts:wrong-scope-r786',
                predicateRef: 'pricing:discount-applicability:variant-line:v1:another-variant-line-scope',
                revisionRefs: [],
                tenantId: request.commercialTotal.decision.tenantId,
              }),
            },
          },
        ],
      }).pipe(Effect.flip);

      expect(Schema.is(PricingMaterialEvidenceUnverifiableFailure)(failure)).toBe(true);
    }),
  );

  it.effect('rejects fact-currentness evidence that swaps revisions between two Discount facts', () =>
    Effect.gen(function* refusesSwappedDiscountRevisionPairs() {
      const request = yield* readyRequest();
      const [line] = request.lines;
      if (
        line === undefined ||
        line.lineDiscounts.kind !== 'DISCOUNT_SELECTED' ||
        !Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(line.lineDiscounts.sourceEvidence) ||
        line.lineDiscounts.sourceEvidence.currentFacts.length < 2
      ) {
        throw new Error('Issue #786 fixture requires at least two Current line Discount facts');
      }
      const factRefs = line.lineDiscounts.sourceEvidence.currentFacts.map(({ factRef }) => factRef);
      const revisionRefs = line.lineDiscounts.sourceEvidence.currentFacts.map(({ factRevisionRef }) => factRevisionRef);
      const [firstRevision, secondRevision, ...remainingRevisions] = revisionRefs;
      if (firstRevision === undefined || secondRevision === undefined) {
        throw new Error('Issue #786 fixture requires two Discount revisions to swap');
      }
      const failure = yield* assemblePricingMaterialEvidence({
        ...request,
        lines: [
          {
            ...line,
            lineDiscounts: {
              kind: 'DISCOUNT_SELECTED',
              sourceEvidence: currentSource({
                effectiveAt: request.commercialTotal.decision.operationTime,
                factRefs,
                family: 'DISCOUNT',
                observedAt: request.commercialTotal.decision.operationTime,
                ownerRevision: line.lineDiscounts.sourceEvidence.completeness.ownerSetRevisionRef,
                predicateRef: line.lineDiscounts.sourceEvidence.completeness.ownerScope.predicateRef,
                revisionRefs: [secondRevision, firstRevision, ...remainingRevisions],
                tenantId: request.commercialTotal.decision.tenantId,
              }),
            },
          },
        ],
      }).pipe(Effect.flip);

      expect(Schema.is(PricingMaterialEvidenceUnverifiableFailure)(failure)).toBe(true);
    }),
  );
});

describe('ordinary Current Pricing publication #786', () => {
  it.effect('fails closed before owner calls when exact final-fence authority has not been retained', () =>
    Effect.gen(function* refusesPublicationWithoutOwnerAuthority() {
      const request = yield* publicationRequest();
      const ownerCalls: string[] = [];
      const failure = yield* publishOrdinaryCurrentPricingForCustomer(request).pipe(
        Effect.provideService(
          PricingExternalOwnerEvidenceValidation,
          makePricingExternalOwnerEvidenceValidationService(),
        ),
        Effect.provideService(PricingMaterialEvidenceOwnerFinalFence, unavailableOwnerFence(ownerCalls)),
        Effect.flip,
      );

      expect(failure).toBeInstanceOf(PricingOrdinaryCurrentPublicationIndeterminate);
      expect(failure.reasonCode).toBe('OWNER_FINAL_FENCE_UNAVAILABLE');
      expect(failure.retryable).toBe(true);
      expect(ownerCalls).toEqual([]);
    }),
  );
});
