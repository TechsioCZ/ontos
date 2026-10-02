import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import { Schema } from 'effect';

import {
  PricingCurrencyCodeSchema,
  PricingInstantSchema,
  PricingTenantIdSchema,
} from '../apis/current-supported-currencies.ts';
import {
  PricingCatalogSelectionSchema,
  PricingDecisionSchema,
  PricingNonPositiveDecimalSchema,
  PricingPositiveDecimalSchema,
  PricingPurchaseDemandOccurrenceIdSchema,
} from './pricing-decision.ts';

const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());
const boundedReason = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());
const PricingPromotionModuleIdSchema = stableReference.pipe(
  Schema.brand('PricingPromotionModuleId'),
  Schema.decodeTo(Schema.String),
);
const PricingPromotionResourceIdSchema = stableReference.pipe(
  Schema.brand('PricingPromotionResourceId'),
  Schema.decodeTo(Schema.String),
);
const boundedReferences = Schema.Array(stableReference).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(500),
  Schema.makeFilter((references) =>
    new Set(references).size === references.length ? undefined : 'Evidence references must be distinct',
  ),
);

const PricingPromotionSignedMoneySchema = Schema.Struct({
  amount: Schema.Union([PricingNonPositiveDecimalSchema, PricingPositiveDecimalSchema]),
  currencyCode: PricingCurrencyCodeSchema,
});
const PricingPromotionNonPositiveMoneySchema = Schema.Struct({
  amount: PricingNonPositiveDecimalSchema,
  currencyCode: PricingCurrencyCodeSchema,
});

interface DecimalParts {
  readonly coefficient: bigint;
  readonly scale: number;
}

const decimalParts = (value: string): DecimalParts => {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integer = '0', fraction = ''] = unsigned.split('.');
  const coefficient = BigInt(`${integer}${fraction}`);
  return { coefficient: negative ? -coefficient : coefficient, scale: fraction.length };
};

const alignedCoefficient = (parts: DecimalParts, scale: number): bigint =>
  parts.coefficient * 10n ** BigInt(scale - parts.scale);

const decimalSumEquals = (expected: string, values: readonly string[]): boolean => {
  const expectedParts = decimalParts(expected);
  const valueParts = values.map(decimalParts);
  const scale = Math.max(expectedParts.scale, ...valueParts.map((parts) => parts.scale));
  return (
    alignedCoefficient(expectedParts, scale) ===
    valueParts.reduce((sum, parts) => sum + alignedCoefficient(parts, scale), 0n)
  );
};

const decimalAdditionEquals = (result: string, left: string, right: string): boolean =>
  decimalSumEquals(result, [left, right]);

const decimalSum = (values: readonly string[]): DecimalParts => {
  let sum = decimalParts('0');
  for (const value of values) {
    const current = decimalParts(value);
    const scale = Math.max(sum.scale, current.scale);
    sum = {
      coefficient: alignedCoefficient(sum, scale) + alignedCoefficient(current, scale),
      scale,
    };
  }
  return sum;
};

const sameCatalogSelection = Schema.toEquivalence(PricingCatalogSelectionSchema);

const PricingPromotionSubjectResourceRefSchema = Schema.Struct({
  moduleId: PricingPromotionModuleIdSchema,
  resourceId: PricingPromotionResourceIdSchema,
  resourceType: stableReference,
  tenantId: PricingTenantIdSchema,
});

export const PricingPromotionActualSubjectSchema = Schema.Union([
  Schema.Struct({
    guestEvidenceRef: stableReference,
    kind: Schema.Literal('GUEST'),
    tenantId: PricingTenantIdSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('RETAIL_CUSTOMER'),
    profileRef: PricingPromotionSubjectResourceRefSchema,
    tenantId: PricingTenantIdSchema,
  }).check(
    Schema.makeFilter(({ profileRef, tenantId }) =>
      profileRef.tenantId === tenantId ? undefined : 'Retail subject and profile must belong to one Tenant',
    ),
  ),
  Schema.Struct({
    counterpartyRef: PricingPromotionSubjectResourceRefSchema,
    kind: Schema.Literal('COUNTERPARTY'),
    profileRef: PricingPromotionSubjectResourceRefSchema,
    tenantId: PricingTenantIdSchema,
  }).check(
    Schema.makeFilter(({ counterpartyRef, profileRef, tenantId }) =>
      counterpartyRef.tenantId === tenantId && profileRef.tenantId === tenantId
        ? undefined
        : 'Counterparty subject references must belong to one Tenant',
    ),
  ),
]);
export type PricingPromotionActualSubject = typeof PricingPromotionActualSubjectSchema.Type;

export const PricingPromotionSubjectEvidenceSchema = Schema.Struct({
  evidenceRef: stableReference,
  observedAt: PricingInstantSchema,
  ownerModuleId: PricingPromotionModuleIdSchema,
  ownerRevision: stableReference,
  provenanceRef: stableReference,
  revalidatedAt: PricingInstantSchema,
  subject: PricingPromotionActualSubjectSchema,
}).check(
  Schema.makeFilter(({ observedAt, revalidatedAt }) =>
    observedAt <= revalidatedAt ? undefined : 'Subject evidence must be revalidated at or after observation',
  ),
);
export type PricingPromotionSubjectEvidence = typeof PricingPromotionSubjectEvidenceSchema.Type;

/**
 * Lossless Promotion-owner proof retained by Pricing after consuming the public #775 seam.
 * It is intentionally owner evidence, not campaign, Voucher, eligibility, or usage state.
 */
export const PricingPromotionOwnerCurrentnessEvidenceSchema = Schema.Struct({
  completenessEvidence: Schema.toEncoded(OwnerVerifiableSetCompletenessEvidenceSchema),
  currentness: Schema.Struct({
    evaluatedAt: PricingInstantSchema,
    observedAt: PricingInstantSchema,
    revalidatedAt: PricingInstantSchema,
    status: Schema.Literal('CURRENT'),
  }),
  exactPredicateRef: stableReference,
  ownerModuleId: Schema.Literal('commerce.promotion'),
  ownerRevision: stableReference,
  provenanceRef: stableReference,
}).check(
  Schema.makeFilter(({ completenessEvidence, currentness, exactPredicateRef, ownerRevision }) => {
    if (
      completenessEvidence.ownerRevision !== ownerRevision ||
      completenessEvidence.observedAt !== currentness.observedAt ||
      completenessEvidence.scope.kind !== 'EXACT_PREDICATE' ||
      completenessEvidence.scope.predicateRef !== exactPredicateRef
    ) {
      return 'Promotion currentness must bind one exact predicate, owner Revision, and observation';
    }
    if (
      currentness.evaluatedAt > currentness.observedAt ||
      currentness.observedAt > currentness.revalidatedAt ||
      (completenessEvidence.nextApplicabilityBoundary !== undefined &&
        currentness.revalidatedAt >= completenessEvidence.nextApplicabilityBoundary)
    ) {
      return 'Promotion currentness must preserve evaluation, observation, revalidation, and next-boundary order';
    }
    return [];
  }),
);
export type PricingPromotionOwnerCurrentnessEvidence = typeof PricingPromotionOwnerCurrentnessEvidenceSchema.Type;

export const PricingPromotionCompositionCurrentnessSchema = Schema.Struct({
  applicationRequestRef: stableReference,
  candidateRef: stableReference,
  currencySupport: Schema.Struct({
    currencyCode: PricingCurrencyCodeSchema,
    evidenceRef: stableReference,
    observedAt: PricingInstantSchema,
    ownerRevision: stableReference,
    status: Schema.Literal('SUPPORTED_CURRENT'),
    tenantId: PricingTenantIdSchema,
  }),
  exactPredicateRef: stableReference,
  ownerEvidence: PricingPromotionOwnerCurrentnessEvidenceSchema,
  pricingCompositionRef: stableReference,
  pricingCompositionRevision: stableReference,
  subjectEvidence: PricingPromotionSubjectEvidenceSchema,
}).check(
  Schema.makeFilter(({ exactPredicateRef, ownerEvidence }) =>
    ownerEvidence.exactPredicateRef === exactPredicateRef
      ? undefined
      : 'Pricing must retain the Promotion proof for the exact requested predicate',
  ),
);
export type PricingPromotionCompositionCurrentness = typeof PricingPromotionCompositionCurrentnessSchema.Type;

export const PricingPromotionMerchandiseAllocationSchema = Schema.Struct({
  amount: PricingPromotionNonPositiveMoneySchema,
  catalogSelection: PricingCatalogSelectionSchema,
  occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
  recipientKind: Schema.Literal('MERCHANDISE'),
});
export type PricingPromotionMerchandiseAllocation = typeof PricingPromotionMerchandiseAllocationSchema.Type;

export const PricingPromotionShippingAllocationSchema = Schema.Struct({
  amount: PricingPromotionNonPositiveMoneySchema,
  deliveryComponentRef: stableReference,
  recipientKind: Schema.Literal('SHIPPING'),
});
export type PricingPromotionShippingAllocation = typeof PricingPromotionShippingAllocationSchema.Type;

export const PricingPromotionTargetSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('MERCHANDISE_ONLY'),
    occurrenceIds: Schema.Array(PricingPurchaseDemandOccurrenceIdSchema).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(500),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal('BASKET_WITH_EXPLICIT_SHIPPING'),
    occurrenceIds: Schema.Array(PricingPurchaseDemandOccurrenceIdSchema).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(500),
    ),
    shippingComponentRefs: boundedReferences,
  }),
]);
export type PricingPromotionTarget = typeof PricingPromotionTargetSchema.Type;

export const PricingPromotionAcceptedRequestSchema = Schema.Struct({
  applicationRequestRef: stableReference,
  candidateRef: stableReference,
  exactPredicateRef: stableReference,
  subjectEvidence: PricingPromotionSubjectEvidenceSchema,
});
export type PricingPromotionAcceptedRequest = typeof PricingPromotionAcceptedRequestSchema.Type;

export const PricingPromotionApplicationSchema = Schema.Union([
  Schema.Struct({
    acceptedRequest: PricingPromotionAcceptedRequestSchema,
    allocations: Schema.Array(PricingPromotionMerchandiseAllocationSchema).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(500),
    ),
    applicationIdentity: Schema.Struct({
      applicationKind: Schema.Literal('PROMOTION_APPLICATION'),
      applicationRef: stableReference,
      applicationRevision: stableReference,
      originalApplicationRef: stableReference,
    }),
    contribution: PricingPromotionNonPositiveMoneySchema,
    outcome: Schema.Literal('PROMOTION_APPLIED'),
    ownerDecisionRevision: stableReference,
    ownerEvidence: PricingPromotionOwnerCurrentnessEvidenceSchema,
    shippingAllocations: Schema.Array(PricingPromotionShippingAllocationSchema).check(Schema.isMaxLength(500)),
    target: PricingPromotionTargetSchema,
  }).check(
    Schema.makeFilter(({ allocations, contribution, shippingAllocations, target }) => {
      const allAllocations = [...allocations, ...shippingAllocations];
      if (
        allAllocations.some(({ amount }) => amount.currencyCode !== contribution.currencyCode) ||
        !decimalSumEquals(
          contribution.amount,
          allAllocations.map(({ amount }) => amount.amount),
        )
      ) {
        return 'Promotion allocations must preserve the exact owner-issued contribution and currency';
      }
      const occurrenceIds = allocations.map(({ occurrenceId }) => occurrenceId);
      const shippingRefs = shippingAllocations.map(({ deliveryComponentRef }) => deliveryComponentRef);
      const occurrenceIdSet = new Set(occurrenceIds);
      const shippingRefSet = new Set(shippingRefs);
      if (
        occurrenceIdSet.size !== occurrenceIds.length ||
        shippingRefSet.size !== shippingRefs.length ||
        target.occurrenceIds.length !== occurrenceIds.length ||
        target.occurrenceIds.some((occurrenceId) => !occurrenceIdSet.has(occurrenceId))
      ) {
        return 'Promotion target and allocations must preserve the distinct original merchandise recipients';
      }
      if (target.kind === 'MERCHANDISE_ONLY') {
        return shippingRefs.length === 0 ? undefined : 'Shipping allocations require an explicit Shipping target';
      }
      return target.shippingComponentRefs.length === shippingRefs.length &&
        target.shippingComponentRefs.every((reference) => shippingRefSet.has(reference))
        ? undefined
        : 'Explicit Shipping targets must match the Delivery-owned allocation recipients exactly';
    }),
  ),
  Schema.Struct({
    acceptedRequest: PricingPromotionAcceptedRequestSchema,
    outcome: Schema.Literal('PROMOTION_NOT_APPLICABLE'),
    ownerDecisionRevision: stableReference,
    ownerEvidence: PricingPromotionOwnerCurrentnessEvidenceSchema,
    reason: Schema.Literals(['APPLICATION_NOT_ELIGIBLE', 'NO_APPLICABLE_APPLICATION']),
  }),
]);
export type PricingPromotionApplication = typeof PricingPromotionApplicationSchema.Type;

export const PricingPromotionComposedLineSchema = Schema.Struct({
  catalogSelection: PricingCatalogSelectionSchema,
  occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
  prePromotionValue: PricingPromotionSignedMoneySchema,
  promotionAllocation: Schema.optionalKey(PricingPromotionMerchandiseAllocationSchema),
  rawPreTaxValue: PricingPromotionSignedMoneySchema,
  recipientKind: Schema.Literal('MERCHANDISE'),
});
export type PricingPromotionComposedLine = typeof PricingPromotionComposedLineSchema.Type;

const readyBase = {
  candidateRef: stableReference,
  completedPricingAllocationRefs: boundedReferences,
  currentnessEvidence: PricingPromotionCompositionCurrentnessSchema,
  decision: PricingDecisionSchema,
  lines: Schema.Array(PricingPromotionComposedLineSchema).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  outcome: Schema.Literal('PROMOTION_COMPOSITION_READY'),
  promotion: PricingPromotionApplicationSchema,
  stage: Schema.Literal('AFTER_PRICE_TIER_FEES_ALL_PRICING_DISCOUNTS_AND_PROMOTION'),
};

const sameOwnerEvidence = Schema.toEquivalence(PricingPromotionOwnerCurrentnessEvidenceSchema);
const sameSubjectEvidence = Schema.toEquivalence(PricingPromotionSubjectEvidenceSchema);

const compositionEvidenceBindsCandidate = (
  candidateRef: string,
  completedPricingAllocationRefs: readonly string[],
  currentnessEvidence: PricingPromotionCompositionCurrentness,
  decision: typeof PricingDecisionSchema.Type,
): boolean =>
  candidateRef === currentnessEvidence.candidateRef &&
  decision.tenantId === currentnessEvidence.currencySupport.tenantId &&
  decision.tenantId === currentnessEvidence.subjectEvidence.subject.tenantId &&
  decision.currencyCode === currentnessEvidence.currencySupport.currencyCode &&
  decision.operationTime === currentnessEvidence.currencySupport.observedAt &&
  decision.operationTime === currentnessEvidence.subjectEvidence.revalidatedAt &&
  decision.operationTime === currentnessEvidence.ownerEvidence.currentness.evaluatedAt &&
  completedPricingAllocationRefs.includes(currentnessEvidence.pricingCompositionRef);

const publishedEvidenceBindsCurrentness = (
  candidateRef: string,
  currentnessEvidence: PricingPromotionCompositionCurrentness,
  promotion: PricingPromotionApplication,
): boolean =>
  promotion.acceptedRequest.applicationRequestRef === currentnessEvidence.applicationRequestRef &&
  promotion.acceptedRequest.candidateRef === candidateRef &&
  promotion.acceptedRequest.exactPredicateRef === currentnessEvidence.exactPredicateRef &&
  sameSubjectEvidence(promotion.acceptedRequest.subjectEvidence, currentnessEvidence.subjectEvidence) &&
  sameOwnerEvidence(promotion.ownerEvidence, currentnessEvidence.ownerEvidence) &&
  promotion.ownerDecisionRevision === promotion.ownerEvidence.ownerRevision;

const exactDecisionLines = (
  decision: typeof PricingDecisionSchema.Type,
  lines: readonly PricingPromotionComposedLine[],
): boolean =>
  decision.lines.length === lines.length &&
  new Set(lines.map(({ occurrenceId }) => occurrenceId)).size === lines.length &&
  decision.lines.every((decisionLine) =>
    lines.some(
      (line) =>
        line.occurrenceId === decisionLine.occurrenceId &&
        sameCatalogSelection(line.catalogSelection, decisionLine.catalog.selection),
    ),
  );

const linesUseCurrency = (lines: readonly PricingPromotionComposedLine[], currencyCode: string): boolean =>
  lines.every(
    ({ prePromotionValue, promotionAllocation, rawPreTaxValue }) =>
      prePromotionValue.currencyCode === currencyCode &&
      rawPreTaxValue.currencyCode === currencyCode &&
      (promotionAllocation === undefined || promotionAllocation.amount.currencyCode === currencyCode),
  );

export const PricingPromotionCompositionReadySchema = Schema.Struct(readyBase).check(
  Schema.makeFilter(
    ({ candidateRef, completedPricingAllocationRefs, currentnessEvidence, decision, lines, promotion }) => {
      if (
        !compositionEvidenceBindsCandidate(candidateRef, completedPricingAllocationRefs, currentnessEvidence, decision)
      ) {
        return 'Promotion composition evidence must bind the exact candidate Tenant and currency';
      }
      if (!publishedEvidenceBindsCurrentness(candidateRef, currentnessEvidence, promotion)) {
        return 'Published Promotion evidence must bind the exact accepted subject, owner proof, and decision Revision';
      }
      if (!exactDecisionLines(decision, lines)) {
        return 'Promotion composition must preserve every original Pricing Line and exact Variant selection once';
      }
      if (!linesUseCurrency(lines, decision.currencyCode)) {
        return 'Every Promotion composition amount must use the exact Pricing Decision currency';
      }
      if (promotion.outcome === 'PROMOTION_NOT_APPLICABLE') {
        return lines.every(
          ({ prePromotionValue, promotionAllocation, rawPreTaxValue }) =>
            promotionAllocation === undefined && rawPreTaxValue.amount === prePromotionValue.amount,
        )
          ? undefined
          : 'A non-applicable Promotion must not fabricate or deduct an allocation';
      }
      const allocationByOccurrence = new Map(
        promotion.allocations.map((allocation) => [allocation.occurrenceId, allocation]),
      );
      if (
        promotion.applicationIdentity.originalApplicationRef !== currentnessEvidence.applicationRequestRef ||
        promotion.contribution.currencyCode !== decision.currencyCode ||
        promotion.allocations.some((allocation) => {
          const line = lines.find(({ occurrenceId }) => occurrenceId === allocation.occurrenceId);
          return line === undefined || !sameCatalogSelection(allocation.catalogSelection, line.catalogSelection);
        })
      ) {
        return 'Applied Promotion evidence must bind the original request and exact Pricing recipients';
      }
      const prePromotionTotal = decimalSum(lines.map((line) => line.prePromotionValue.amount));
      if (prePromotionTotal.coefficient <= 0n) {
        return 'A zero or non-positive eligible pre-Promotion basis must remain on the parked owner path';
      }
      return lines.every(({ occurrenceId, prePromotionValue, promotionAllocation, rawPreTaxValue }) => {
        const ownerAllocation = allocationByOccurrence.get(occurrenceId);
        if (ownerAllocation === undefined) {
          return promotionAllocation === undefined && rawPreTaxValue.amount === prePromotionValue.amount;
        }
        return (
          promotionAllocation !== undefined &&
          promotionAllocation.amount.amount === ownerAllocation.amount.amount &&
          sameCatalogSelection(promotionAllocation.catalogSelection, ownerAllocation.catalogSelection) &&
          decimalAdditionEquals(rawPreTaxValue.amount, prePromotionValue.amount, ownerAllocation.amount.amount)
        );
      })
        ? undefined
        : 'Each owner-issued Promotion allocation must be applied to its original line exactly once';
    },
  ),
);
export type PricingPromotionCompositionReady = typeof PricingPromotionCompositionReadySchema.Type;

export const PricingPromotionCompositionFailureReasonSchema = Schema.Literals([
  'INPUT_INVALID',
  'OWNER_CONFLICT',
  'OWNER_UNAVAILABLE',
  'OWNER_UNVERIFIABLE',
  'ZERO_OR_NON_POSITIVE_ELIGIBLE_BASIS_PARKED',
]);
export type PricingPromotionCompositionFailureReason = typeof PricingPromotionCompositionFailureReasonSchema.Type;

export const PricingPromotionCompositionFailedSchema = Schema.Struct({
  candidateRef: stableReference,
  failure: Schema.Struct({
    reason: boundedReason,
    retryable: Schema.Boolean,
    type: PricingPromotionCompositionFailureReasonSchema,
  }),
  outcome: Schema.Literal('PROMOTION_COMPOSITION_FAILED'),
}).check(
  Schema.makeFilter(({ failure }) => {
    const retryable = failure.type === 'OWNER_UNAVAILABLE' || failure.type === 'OWNER_UNVERIFIABLE';
    return failure.retryable === retryable
      ? undefined
      : 'Only unavailable or unverifiable Promotion owner evidence is retryable';
  }),
);
export type PricingPromotionCompositionFailed = typeof PricingPromotionCompositionFailedSchema.Type;

export const PricingPromotionCompositionResultSchema = Schema.Union([
  PricingPromotionCompositionReadySchema,
  PricingPromotionCompositionFailedSchema,
]);
export type PricingPromotionCompositionResult = typeof PricingPromotionCompositionResultSchema.Type;
