import type {
  PricingMaterialDiscountSelection,
  PricingMaterialEvidenceAssemblyRequest,
} from '@app/pricing-contracts/domain/material-evidence';
import {
  PricingMaterialEvidenceAssemblyRequestSchema,
  PricingMaterialEvidenceConflictFailure,
  PricingMaterialEvidenceMissingFailure,
  PricingMaterialEvidenceUnverifiableFailure,
} from '@app/pricing-contracts/domain/material-evidence';
import type {
  PricingSourceEvidenceFamily,
  PricingSourceEvidenceResult,
} from '@app/pricing-contracts/domain/source-revision-evidence';
import { PricingSourceEvidenceVerifiedPresentSchema } from '@app/pricing-contracts/domain/source-revision-evidence';
import { PRICING_CZK_PUBLICATION_PROFILE } from '@app/pricing-contracts/domain/exact-decimal';
import type { PricingFinalPreRoundReady } from '@app/pricing-contracts/domain/line-composition';
import type { PricingCommercialTotalReady } from '@app/pricing-contracts/domain/commercial-total';
import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { allocatePricingDiscountsAndFees } from '../../src/services/discount-fee-allocation.service.ts';
import {
  assemblePricingMaterialEvidence,
  pricingLineDiscountApplicabilityPredicateRef,
  pricingWholePurchaseDiscountApplicabilityPredicateRef,
} from '../../src/services/material-evidence-assembly.service.ts';
import { calculatePricingCommercialTotals } from '../../src/services/commercial-totals.service.ts';
import { unitPriceGroupAbsencePredicateRef } from '../../src/services/unit-price-material-evidence.service.ts';
import { candidateRef, makeIssue779PreRoundScenario, money } from './support/issue-779-line-value.fixture.ts';

const requestedAt = '2026-09-28T12:00:00.000Z';
const revalidatedAt = '2026-09-28T12:00:00.200Z';
const nextMaterialBoundary = '2026-10-01T00:00:00.000Z';

const currentSource = (input: {
  readonly currencyCode: string;
  readonly effectivePeriods?: readonly {
    readonly effectiveFrom: string;
    readonly effectiveTo: string | null;
  }[];
  readonly factRefs?: readonly string[];
  readonly family: PricingSourceEvidenceFamily;
  readonly observedAt: string;
  readonly ownerModuleId?: string;
  readonly ownerSetRevisionRef: string;
  readonly predicateRef: string;
  readonly revisionRefs: readonly string[];
  readonly tenantId: string;
}): PricingSourceEvidenceResult => {
  const ownerScope = {
    ownerModuleId: input.ownerModuleId ?? 'commerce.pricing',
    ownerRootRef: `commerce.pricing:${input.family.toLowerCase()}:root`,
    predicateRef: input.predicateRef,
    tenantId: input.tenantId,
  } as const;
  const temporal = {
    effectiveAt: requestedAt,
    evaluatedAt: requestedAt,
    evaluationMode: 'CURRENT_AT_OWNER_EVALUATION' as const,
    nextMaterialBoundary,
    observedAt: input.observedAt,
    requestedAt,
  };
  const request = {
    currencyCode: input.currencyCode,
    effectiveAt: requestedAt,
    family: input.family,
    ownerScope,
    requestedAt,
  };
  const completeness = {
    completenessEvidence: {
      nextApplicabilityBoundary: nextMaterialBoundary,
      observedAt: input.observedAt,
      ownerRevision: input.ownerSetRevisionRef,
      scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: input.predicateRef },
    },
    currencyCode: input.currencyCode,
    family: input.family,
    ownerScope,
    ownerSetRevisionRef: input.ownerSetRevisionRef,
    temporal,
    verification: {
      kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE' as const,
      verificationRef: `proof:${input.ownerSetRevisionRef}`,
    },
  };

  return input.revisionRefs.length === 0
    ? { _tag: 'VERIFIED_ABSENT', completeness, request }
    : {
        _tag: 'VERIFIED_PRESENT',
        completeness,
        currentFacts: input.revisionRefs.map((revisionRef, index) => ({
          currencyCode: input.currencyCode,
          effectivePeriod: input.effectivePeriods?.[index] ?? {
            effectiveFrom: '2026-09-01T00:00:00.000Z',
            effectiveTo: null,
          },
          factRef: input.factRefs?.[index] ?? `fact:${revisionRef}`,
          factRevisionRef: revisionRef,
          family: input.family,
          ownerScope,
          temporal,
          verification: {
            kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE' as const,
            verificationRef: `proof:${revisionRef}`,
          },
        })),
        request,
      };
};

const commercialTotalFor = Effect.fn('test.issue786CommercialTotalFor')(function* commercialTotalForProgram(
  preRound: PricingFinalPreRoundReady,
) {
  const [line] = preRound.lines;
  if (line === undefined) {
    return yield* Effect.die('Issue #786 requires one retained Pricing line');
  }
  const result = yield* calculatePricingCommercialTotals({
    candidateRef,
    decision: preRound.decision,
    preRound,
    publishedLines: [
      {
        occurrenceId: line.occurrenceId,
        publicationProfile: PRICING_CZK_PUBLICATION_PROFILE,
        publishedLineValue: line.nonNegativePreRoundValue,
        roundingAdjustment: money('0'),
      },
    ],
  });
  if (result.outcome !== 'COMMERCIAL_TOTAL_READY') {
    return yield* Effect.die(result);
  }
  return result;
});

const requestFor = (commercialTotal: PricingCommercialTotalReady): PricingMaterialEvidenceAssemblyRequest => {
  const [totalLine] = commercialTotal.sourceEvidence.preRound.lines;
  if (totalLine === undefined) {
    throw new Error('Issue #786 requires one retained Pricing line');
  }
  const { composition, floorEvaluation, occurrenceId } = totalLine;
  const { exactPrice } = composition.unitPriceCalculation.input;
  const { path } = exactPrice;
  if (!('usedPrice' in path)) {
    throw new Error('Issue #786 requires one exact used Price');
  }
  const { tierSet } = composition.unitPriceCalculation.input.tierSelection.evidence.input;
  const tierObservedAt = DateTime.formatIso(tierSet.completenessEvidence.observedAt);
  const { feeSet } = composition.feeCalculation.input;
  const { currencySupport } = exactPrice;
  const allocationAssessment = commercialTotal.sourceEvidence.preRound.rawComposition.wholePurchaseAllocationEvidence;
  const zeroFloor =
    floorEvaluation.kind === 'AUTHORIZED_ZERO_FLOOR'
      ? currentSource({
          currencyCode: commercialTotal.decision.currencyCode,
          effectivePeriods: floorEvaluation.authorizationSet.authorizations.map(({ effectivePeriod }) => ({
            effectiveFrom: effectivePeriod.startsAt,
            effectiveTo: effectivePeriod.endsAt ?? null,
          })),
          factRefs: floorEvaluation.authorizationSet.authorizations.map(({ authorizationRef }) => authorizationRef),
          family: 'ZERO_FLOOR',
          observedAt: floorEvaluation.authorizationSet.currentness.observedAt,
          ownerSetRevisionRef: floorEvaluation.authorizationSet.ownerRevision,
          predicateRef: floorEvaluation.authorizationSet.exactPredicateRef,
          revisionRefs: floorEvaluation.authorizationSet.authorizations.map(
            ({ authorizationRevision }) => authorizationRevision,
          ),
          tenantId: commercialTotal.decision.tenantId,
        })
      : undefined;
  const common = {
    currencyCode: commercialTotal.decision.currencyCode,
    tenantId: commercialTotal.decision.tenantId,
  };
  const externalSource = (
    ownerModuleId: string,
    family: 'COMMERCIAL_CONTEXT' | 'PROMOTION',
    predicateRef: string,
    present: boolean,
  ) =>
    currentSource({
      ...common,
      factRefs: present ? [`${predicateRef}:fact`] : [],
      family,
      observedAt: requestedAt,
      ownerModuleId,
      ownerSetRevisionRef: `${predicateRef}:set-r786`,
      predicateRef,
      revisionRefs: present ? [`${predicateRef}:fact-r786`] : [],
    });

  let lineEvidence: PricingMaterialEvidenceAssemblyRequest['lines'][number] = {
    commercialFees: currentSource({
      ...common,
      factRefs: feeSet.fees.map(({ definition }) => definition.feeRef.resourceId),
      family: 'COMMERCIAL_FEE',
      observedAt: feeSet.observedAt,
      ownerSetRevisionRef: feeSet.completenessEvidence.ownerRevision,
      predicateRef: feeSet.completenessEvidence.scope.predicateRef,
      revisionRefs: feeSet.fees.map(({ definition }) => definition.revision.revisionId),
    }),
    lineDiscounts: {
      kind: 'DISCOUNT_SELECTED',
      sourceEvidence: currentSource({
        ...common,
        factRefs: composition.lineDiscountContributions.map(({ candidate }) => candidate.definition.discountId),
        family: 'DISCOUNT',
        observedAt: requestedAt,
        ownerSetRevisionRef: 'pricing:line-discount-set:786',
        predicateRef: pricingLineDiscountApplicabilityPredicateRef(commercialTotal, totalLine),
        revisionRefs: composition.lineDiscountContributions.map(
          ({ candidate }) => candidate.definition.revision.revisionId,
        ),
      }),
    },
    occurrenceId,
    pricePath: {
      usedPrice: currentSource({
        ...common,
        factRefs: [path.usedPrice.priceRef.resourceId],
        family: 'PRICE',
        observedAt: path.usedPrice.evidence.observedAt,
        ownerSetRevisionRef: path.usedPrice.evidence.ownerRevision,
        predicateRef: unitPriceGroupAbsencePredicateRef(path.usedPrice.request),
        revisionRefs: [path.usedPrice.priceRevision.revisionId],
      }),
    },
    quantityTiers: currentSource({
      ...common,
      family: 'QUANTITY_TIER',
      observedAt: tierObservedAt,
      ownerSetRevisionRef: tierSet.completenessEvidence.ownerRevision,
      predicateRef: tierSet.completenessEvidence.scope.predicateRef,
      revisionRefs: tierSet.currentTiers.map(({ definition }) => definition.revision.revisionId),
    }),
  };
  if (zeroFloor !== undefined) {
    lineEvidence = { ...lineEvidence, zeroFloor };
  }
  const contractualDiscountSourceInput = {
    ...common,
    family: 'DISCOUNT' as const,
    observedAt: requestedAt,
    ownerSetRevisionRef: 'pricing:whole-discount-set:786',
    predicateRef: pricingWholePurchaseDiscountApplicabilityPredicateRef(commercialTotal),
    revisionRefs: allocationAssessment === undefined ? [] : [allocationAssessment.request.source.revisionRef],
  };
  const logicalFactRef = allocationAssessment?.request.source.logicalFactRef;
  const contractualDiscounts = {
    kind: 'DISCOUNT_SELECTED' as const,
    sourceEvidence:
      logicalFactRef === undefined
        ? currentSource(contractualDiscountSourceInput)
        : currentSource({ ...contractualDiscountSourceInput, factRefs: [logicalFactRef] }),
  };
  let wholePurchase: PricingMaterialEvidenceAssemblyRequest['wholePurchase'] = {
    contractualDiscounts,
  };
  if (allocationAssessment !== undefined) {
    wholePurchase = {
      allocationAssessment,
      contractualDiscounts,
    };
  }

  return {
    commercialTotal,
    currencySupport: currentSource({
      ...common,
      factRefs: [currencySupport.supportRootRef.resourceId],
      family: 'CURRENCY_SUPPORT',
      observedAt: currencySupport.observedAt,
      ownerSetRevisionRef: currencySupport.supportRevisionRef.resourceId,
      predicateRef: currencySupport.completenessEvidence.scope.predicateRef,
      revisionRefs: [currencySupport.supportRevisionRef.resourceId],
    }),
    externalOwnerEvidence: {
      candidateRef: commercialTotal.candidateRef,
      catalogSelections: commercialTotal.decision.lines.map(({ occurrenceId: lineOccurrenceId }) => ({
        occurrenceId: lineOccurrenceId,
        sourceEvidence: externalSource(
          'commerce.catalog',
          'COMMERCIAL_CONTEXT',
          `catalog-selection:${lineOccurrenceId}`,
          true,
        ),
      })),
      decision: commercialTotal.decision,
      market: externalSource('commerce.market-catalog', 'COMMERCIAL_CONTEXT', 'market-context:786', true),
      priceGroupAssignment: externalSource(
        'commerce.customer-context',
        'COMMERCIAL_CONTEXT',
        'price-group-assignment:786',
        true,
      ),
      promotion: {
        kind: 'PROMOTION_SELECTED',
        sourceEvidence: externalSource('commerce.promotion', 'PROMOTION', 'promotion:786', false),
      },
      requestedAt,
      subject: {
        authorizationSubject: { kind: 'RETAIL' },
        kind: 'PROFILE',
        profileRef: {
          moduleId: 'commerce.customer-context',
          resourceId: commercialTotal.decision.purchasingContext.contextRef,
          resourceType: 'commerce.customer-context.retail-customer-profile',
          tenantId: commercialTotal.decision.tenantId,
        },
      },
      validatedAt: revalidatedAt,
    },
    lines: [lineEvidence],
    requestedAt,
    revalidatedAt,
    wholePurchase,
  };
};

const guestDiscountNonSelectionFor = (
  commercialTotal: PricingCommercialTotalReady,
): Extract<PricingMaterialDiscountSelection, { readonly kind: 'DISCOUNT_NOT_SELECTED_NO_ELIGIBLE_AUDIENCE' }> => ({
  audienceDecision: { kind: 'GUEST' },
  kind: 'DISCOUNT_NOT_SELECTED_NO_ELIGIBLE_AUDIENCE',
  subjectEvidence: {
    currentness: {
      evaluatedAt: commercialTotal.decision.operationTime,
      observedAt: commercialTotal.decision.operationTime,
      validFrom: commercialTotal.decision.operationTime,
      validTo: null,
    },
    ownerRef: commercialTotal.decision.purchasingContext.contextRef,
    ownerRevisionRef: commercialTotal.decision.purchasingContext.contextRevision,
    subjectAuthority: {
      guestEvidenceAuthorityRef: 'guest-evidence-authority:786',
      guestSessionAuthorityRef: 'guest-session-authority:786',
      kind: 'GUEST',
      subject: {
        guestEvidenceRef: 'guest-evidence:786',
        guestSessionRef: 'guest-session:786',
        kind: 'GUEST',
      },
      subjectAuthorityRevisionRef: 'guest-authority-revision:786',
    },
    verificationRef: 'purchase-context-verification:786',
  },
});

describe('issue #786 material source-evidence acceptance', () => {
  it.effect('assembles exact Price, Tier, Discount, Fee and Currency Support proofs after real latency', () =>
    Effect.gen(function* assemblesCurrentMaterialEvidence() {
      const { preRound } = yield* makeIssue779PreRoundScenario({ feeAmount: '10', promotionAmount: '-10' });
      const commercialTotal = yield* commercialTotalFor(preRound);
      const request = requestFor(commercialTotal);
      const result = yield* assemblePricingMaterialEvidence(request);

      expect(result).toMatchObject({
        candidateRef,
        outcome: 'PRICING_MATERIAL_EVIDENCE_READY',
        sourceEvidence: request,
        validatedAt: revalidatedAt,
      });
      expect(result.calculationVersions).toMatchObject({
        arithmeticProfileVersions: ['pricing-arithmetic-v1'],
        publicationProfileVersions: ['pricing-czk-publication-v1'],
      });
    }),
  );

  it.effect('accepts independently mixed selected and CCC-backed nonselected Discount scopes', () =>
    Effect.gen(function* acceptsIndependentDiscountScopes() {
      const { preRound } = yield* makeIssue779PreRoundScenario({ discounts: ['0', '0', '0'] });
      const commercialTotal = yield* commercialTotalFor(preRound);
      const request = requestFor(commercialTotal);
      const nonSelection = guestDiscountNonSelectionFor(commercialTotal);
      const { priceGroupAssignment: _priceGroupAssignment, ...guestExternalOwnerEvidence } =
        request.externalOwnerEvidence;
      void _priceGroupAssignment;

      const selectedLineAndNonselectedWhole = {
        ...request,
        externalOwnerEvidence: {
          ...guestExternalOwnerEvidence,
          subject: nonSelection.subjectEvidence.subjectAuthority.subject,
        },
        wholePurchase: { contractualDiscounts: nonSelection },
      };
      expect(Schema.is(PricingMaterialEvidenceAssemblyRequestSchema)(selectedLineAndNonselectedWhole)).toBe(true);
      expect((yield* assemblePricingMaterialEvidence(selectedLineAndNonselectedWhole)).outcome).toBe(
        'PRICING_MATERIAL_EVIDENCE_READY',
      );

      const [line] = request.lines;
      if (line === undefined) {
        throw new Error('Issue #786 requires one line for mixed Discount scope validation');
      }
      expect(
        Schema.is(PricingMaterialEvidenceAssemblyRequestSchema)({
          ...request,
          externalOwnerEvidence: {
            ...guestExternalOwnerEvidence,
            subject: nonSelection.subjectEvidence.subjectAuthority.subject,
          },
          lines: [{ ...line, lineDiscounts: nonSelection }],
        }),
      ).toBe(true);
    }),
  );

  it.effect('rejects detached allocation evidence despite strict B>D, exact sum, capacity, and Revision proof', () =>
    Effect.gen(function* rejectsDetachedWholePurchaseAllocation() {
      const { preRound } = yield* makeIssue779PreRoundScenario({
        discounts: ['0', '0', '0'],
        feeAmount: '0',
        priceAmount: '100',
      });
      const commercialTotal = yield* commercialTotalFor(preRound);
      const request = requestFor(commercialTotal);
      const allocation = yield* allocatePricingDiscountsAndFees({
        allocationKind: 'WHOLE_PURCHASE_CONTRACTUAL',
        decision: commercialTotal.decision,
        eligibleBasis: {
          currencyCode: 'CZK',
          eligibleAmount: '100',
          recipients: [
            {
              intermediateValue: money('100'),
              occurrenceId: commercialTotal.decision.lines[0]?.occurrenceId ?? 'line-779-a',
              recipientKind: 'MERCHANDISE',
            },
          ],
        },
        originalContribution: money('-10'),
        precision: {
          allocationScale: 18,
          amountPrecision: 76,
          contractVersion: 'pricing-allocation-v1',
          remainderRule: 'LARGEST_FRACTION_THEN_STABLE_OCCURRENCE_ID_ASC',
        },
        source: {
          allocationAuthority: 'PRICING_WHOLE_PURCHASE_CONTRACTUAL',
          logicalFactRef: 'whole-discount:786',
          ownerModuleId: 'commerce.pricing',
          revisionRef: 'whole-discount-r786',
          sourceKind: 'PRICING_DISCOUNT',
        },
      });
      if (allocation.outcome !== 'ALLOCATION_APPLIED') {
        return yield* Effect.die('Issue #786 requires an applied whole-purchase allocation');
      }

      expect(allocation).toMatchObject({
        allocations: [{ amount: money('-10') }],
        capacityInvariant: 'EVERY_ALLOCATION_WITHIN_ELIGIBLE_INTERMEDIATE',
        outcome: 'ALLOCATION_APPLIED',
        sumInvariant: 'ALLOCATIONS_SUM_TO_ORIGINAL_CONTRIBUTION',
      });
      const failure = yield* Effect.flip(
        assemblePricingMaterialEvidence({
          ...request,
          wholePurchase: {
            allocationAssessment: allocation,
            contractualDiscounts: {
              kind: 'DISCOUNT_SELECTED',
              sourceEvidence: currentSource({
                currencyCode: commercialTotal.decision.currencyCode,
                factRefs: ['whole-discount:786'],
                family: 'DISCOUNT',
                observedAt: revalidatedAt,
                ownerSetRevisionRef: 'pricing:whole-discount-set:786',
                predicateRef: 'pricing:whole-discounts:candidate-779',
                revisionRefs: ['whole-discount-r786'],
                tenantId: commercialTotal.decision.tenantId,
              }),
            },
          },
        }),
      );
      expect(failure).toBeInstanceOf(PricingMaterialEvidenceUnverifiableFailure);
      return yield* Effect.void;
    }),
  );

  it.effect('retains exact B<D and B=D non-applicability assessments through material assembly', () =>
    Effect.gen(function* retainsWholePurchaseNonApplicability() {
      const { preRound: base } = yield* makeIssue779PreRoundScenario({
        discounts: ['0', '0', '0'],
        feeAmount: '0',
        priceAmount: '100',
      });
      for (const configuredDiscount of ['101', '100']) {
        const assessment = yield* allocatePricingDiscountsAndFees({
          allocationKind: 'WHOLE_PURCHASE_CONTRACTUAL_NOT_APPLICABLE',
          configuredDiscount: money(configuredDiscount),
          decision: base.decision,
          eligibleBasis: {
            currencyCode: 'CZK',
            eligibleAmount: '100',
            recipients: [
              {
                intermediateValue: money('100'),
                occurrenceId: base.decision.lines[0]?.occurrenceId ?? 'line-779',
                recipientKind: 'MERCHANDISE',
              },
            ],
          },
          reason: 'BASIS_NOT_GREATER_THAN_DISCOUNT',
          source: {
            allocationAuthority: 'PRICING_WHOLE_PURCHASE_CONTRACTUAL',
            logicalFactRef: 'whole-discount:786',
            ownerModuleId: 'commerce.pricing',
            revisionRef: `whole-discount-r786:${configuredDiscount}`,
            sourceKind: 'PRICING_DISCOUNT',
          },
        });
        if (assessment.outcome !== 'ALLOCATION_NOT_APPLICABLE') {
          throw new Error('Issue #786 requires a known non-applicable whole-purchase assessment');
        }
        const preRound: PricingFinalPreRoundReady = {
          ...base,
          rawComposition: { ...base.rawComposition, wholePurchaseAllocationEvidence: assessment },
        };
        const commercialTotal = yield* commercialTotalFor(preRound);
        const result = yield* assemblePricingMaterialEvidence(requestFor(commercialTotal));
        expect(result.sourceEvidence.wholePurchase.allocationAssessment).toEqual(assessment);
        expect(
          result.sourceEvidence.commercialTotal.sourceEvidence.preRound.rawComposition.wholePurchaseAllocationEvidence,
        ).toEqual(assessment);
        if (configuredDiscount === '100') {
          const request = requestFor(commercialTotal);
          const failure = yield* assemblePricingMaterialEvidence({
            ...request,
            wholePurchase: {
              ...request.wholePurchase,
              allocationAssessment: {
                ...assessment,
                request: { ...assessment.request, configuredDiscount: money('101') },
              },
            },
          }).pipe(Effect.flip);
          expect(failure).toBeInstanceOf(PricingMaterialEvidenceUnverifiableFailure);
        }
      }
    }),
  );

  it.effect('retains ZERO_FLOOR scope, economic coverage, effectivity, and exact authorization set', () =>
    Effect.gen(function* retainsFloorAuthorization() {
      const { preRound } = yield* makeIssue779PreRoundScenario({ discounts: ['40', '40', '30'] });
      const commercialTotal = yield* commercialTotalFor(preRound);
      const request = requestFor(commercialTotal);
      const result = yield* assemblePricingMaterialEvidence(request);
      const [line] = result.sourceEvidence.commercialTotal.sourceEvidence.preRound.lines;

      expect(line?.floorEvaluation).toMatchObject({
        authorizationSet: {
          authorizations: [
            {
              economicCoverage: { maximumFloorAdjustment: '20', minimumRawAmount: '-20' },
              effectivePeriod: {
                endsAt: '2026-09-29T00:00:00.000Z',
                startsAt: '2026-09-28T00:00:00.000Z',
              },
            },
          ],
          exactPredicateRef: 'zero-floor:exact:779',
        },
        kind: 'AUTHORIZED_ZERO_FLOOR',
      });
      const [evidenceLine] = result.sourceEvidence.lines;
      const floorEvidence = yield* Schema.decodeUnknownEffect(PricingSourceEvidenceVerifiedPresentSchema)(
        evidenceLine?.zeroFloor,
      );
      expect(floorEvidence.currentFacts).toMatchObject([{ factRevisionRef: 'zero-floor-auth-r779' }]);
    }),
  );

  it.effect('keeps missing, conflict, and unverifiable material evidence distinct', () =>
    Effect.gen(function* keepsFailureClassesDistinct() {
      const { preRound } = yield* makeIssue779PreRoundScenario({ feeAmount: '10' });
      const commercialTotal = yield* commercialTotalFor(preRound);
      const request = requestFor(commercialTotal);
      const [line] = request.lines;
      if (line === undefined) {
        throw new Error('Issue #786 requires one evidence line');
      }
      const evidenceRequest = line.quantityTiers.request;
      const missing: PricingSourceEvidenceResult = {
        _tag: 'MISSING',
        observedAt: revalidatedAt,
        reason: 'REQUIRED_CONFIGURATION_MISSING',
        request: evidenceRequest,
        verification: {
          kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE',
          verificationRef: 'proof:missing-tier-set',
        },
      };
      const conflictSource = yield* Schema.decodeUnknownEffect(PricingSourceEvidenceVerifiedPresentSchema)(
        currentSource({
          currencyCode: commercialTotal.decision.currencyCode,
          family: 'COMMERCIAL_FEE',
          observedAt: revalidatedAt,
          ownerSetRevisionRef: 'fee-conflict-set',
          predicateRef: 'fee-conflict-predicate',
          revisionRefs: ['fee-r1', 'fee-r2'],
          tenantId: commercialTotal.decision.tenantId,
        }),
      );
      const conflict: PricingSourceEvidenceResult = { ...conflictSource, _tag: 'CONFLICT' };
      const unverifiable: PricingSourceEvidenceResult = {
        _tag: 'UNVERIFIABLE',
        observedAt: revalidatedAt,
        reason: 'OWNER_UNAVAILABLE',
        request: request.currencySupport.request,
        retryable: true,
      };

      const missingFailure = yield* assemblePricingMaterialEvidence({
        ...request,
        lines: [{ ...line, quantityTiers: missing }],
      }).pipe(Effect.flip);
      const conflictFailure = yield* assemblePricingMaterialEvidence({
        ...request,
        lines: [{ ...line, commercialFees: conflict }],
      }).pipe(Effect.flip);
      const unavailableFailure = yield* assemblePricingMaterialEvidence({
        ...request,
        currencySupport: unverifiable,
      }).pipe(Effect.flip);

      expect(missingFailure).toBeInstanceOf(PricingMaterialEvidenceMissingFailure);
      expect(conflictFailure).toBeInstanceOf(PricingMaterialEvidenceConflictFailure);
      expect(unavailableFailure).toBeInstanceOf(PricingMaterialEvidenceUnverifiableFailure);
    }),
  );
});
