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
import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import { Context, Schema } from 'effect';
import type { Effect } from 'effect';

const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500), Schema.isTrimmed());
const PromotionModuleIdSchema = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u),
  Schema.isMaxLength(200),
).pipe(Schema.brand('PromotionModuleId'), Schema.decodeTo(Schema.String));
const PromotionResourceIdSchema = stableReference.pipe(
  Schema.brand('PromotionResourceId'),
  Schema.decodeTo(Schema.String),
);
const boundedReferences = Schema.Array(stableReference).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(500),
  Schema.makeFilter((references) =>
    new Set(references).size === references.length ? undefined : 'References must be distinct',
  ),
);
const distinctOccurrenceIds = Schema.Array(PricingPurchaseDemandOccurrenceIdSchema).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(500),
  Schema.makeFilter((occurrenceIds) =>
    new Set(occurrenceIds).size === occurrenceIds.length ? undefined : 'Occurrence IDs must be distinct',
  ),
);
const PromotionSignedMoneySchema = Schema.Struct({
  amount: Schema.Union([PricingNonPositiveDecimalSchema, PricingPositiveDecimalSchema]),
  currencyCode: PricingCurrencyCodeSchema,
});
const PromotionNonPositiveMoneySchema = Schema.Struct({
  amount: PricingNonPositiveDecimalSchema,
  currencyCode: PricingCurrencyCodeSchema,
});

const PromotionSubjectResourceRefSchema = Schema.Struct({
  moduleId: PromotionModuleIdSchema,
  resourceId: PromotionResourceIdSchema,
  resourceType: PromotionModuleIdSchema,
  tenantId: PricingTenantIdSchema,
});

export const PromotionActualSubjectSchema = Schema.Union([
  Schema.Struct({
    guestEvidenceRef: stableReference,
    kind: Schema.Literal('GUEST'),
    tenantId: PricingTenantIdSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('RETAIL_CUSTOMER'),
    profileRef: PromotionSubjectResourceRefSchema,
    tenantId: PricingTenantIdSchema,
  }).check(
    Schema.makeFilter(({ profileRef, tenantId }) =>
      profileRef.tenantId === tenantId ? undefined : 'Retail subject and profile must belong to one Tenant',
    ),
  ),
  Schema.Struct({
    counterpartyRef: PromotionSubjectResourceRefSchema,
    kind: Schema.Literal('COUNTERPARTY'),
    profileRef: PromotionSubjectResourceRefSchema,
    tenantId: PricingTenantIdSchema,
  }).check(
    Schema.makeFilter(({ counterpartyRef, profileRef, tenantId }) =>
      counterpartyRef.tenantId === tenantId && profileRef.tenantId === tenantId
        ? undefined
        : 'Counterparty subject references must belong to one Tenant',
    ),
  ),
]);
export type PromotionActualSubject = typeof PromotionActualSubjectSchema.Type;

export const PromotionSubjectEvidenceSchema = Schema.Struct({
  evidenceRef: stableReference,
  observedAt: PricingInstantSchema,
  ownerModuleId: PromotionModuleIdSchema,
  ownerRevision: stableReference,
  provenanceRef: stableReference,
  revalidatedAt: PricingInstantSchema,
  subject: PromotionActualSubjectSchema,
}).check(
  Schema.makeFilter(({ observedAt, revalidatedAt }) =>
    observedAt <= revalidatedAt ? undefined : 'Subject evidence must be revalidated at or after observation',
  ),
);
export type PromotionSubjectEvidence = typeof PromotionSubjectEvidenceSchema.Type;

export const PromotionCurrencyCompatibilitySchema = Schema.Struct({
  currencyCode: PricingCurrencyCodeSchema,
  evidenceRef: stableReference,
  observedAt: PricingInstantSchema,
  ownerRevision: stableReference,
  status: Schema.Literal('SUPPORTED_CURRENT'),
  tenantId: PricingTenantIdSchema,
});
export type PromotionCurrencyCompatibility = typeof PromotionCurrencyCompatibilitySchema.Type;

export const PromotionPrePromotionLineSchema = Schema.Struct({
  amount: PromotionSignedMoneySchema,
  catalogSelection: PricingCatalogSelectionSchema,
  occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
});
export type PromotionPrePromotionLine = typeof PromotionPrePromotionLineSchema.Type;

export const PromotionPrePromotionBasisSchema = Schema.Struct({
  completedPricingAllocationRefs: boundedReferences,
  currencyCode: PricingCurrencyCodeSchema,
  lines: Schema.Array(PromotionPrePromotionLineSchema).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  monetaryBoundary: Schema.Literal('PRE_TAX'),
  pricingCompositionRef: stableReference,
  pricingCompositionRevision: stableReference,
  stage: Schema.Literal('AFTER_PRICE_TIER_FEES_AND_ALL_PRICING_DISCOUNTS'),
}).check(
  Schema.makeFilter(({ currencyCode, lines }) => {
    const ids = lines.map(({ occurrenceId }) => occurrenceId);
    if (new Set(ids).size !== ids.length) {
      return 'Pre-Promotion basis recipients must be distinct original Pricing Line occurrences';
    }
    return lines.every(({ amount }) => amount.currencyCode === currencyCode)
      ? undefined
      : 'Every pre-Promotion line value must use the basis currency';
  }),
);
export type PromotionPrePromotionBasis = typeof PromotionPrePromotionBasisSchema.Type;

const sameSelection = Schema.toEquivalence(PricingCatalogSelectionSchema);

export const PromotionContributionRequestSchema = Schema.Struct({
  applicationRequestRef: stableReference,
  candidate: Schema.Struct({ candidateRef: stableReference, decision: PricingDecisionSchema }),
  currencyCompatibility: PromotionCurrencyCompatibilitySchema,
  exactPredicateRef: stableReference,
  prePromotionBasis: PromotionPrePromotionBasisSchema,
  subjectEvidence: PromotionSubjectEvidenceSchema,
}).check(
  Schema.makeFilter(({ candidate, currencyCompatibility, prePromotionBasis, subjectEvidence }) => {
    const { decision } = candidate;
    if (
      decision.currencyCode !== prePromotionBasis.currencyCode ||
      decision.currencyCode !== currencyCompatibility.currencyCode ||
      decision.tenantId !== currencyCompatibility.tenantId ||
      decision.tenantId !== subjectEvidence.subject.tenantId
    ) {
      return 'Promotion request must preserve one candidate Tenant, subject, and compatible currency';
    }
    if (decision.lines.length !== prePromotionBasis.lines.length) {
      return 'Pre-Promotion basis must preserve every original Pricing Line exactly once';
    }
    return decision.lines.every((line) =>
      prePromotionBasis.lines.some(
        (basisLine) =>
          basisLine.occurrenceId === line.occurrenceId &&
          sameSelection(basisLine.catalogSelection, line.catalog.selection),
      ),
    )
      ? undefined
      : 'Pre-Promotion basis must preserve each original occurrence and exact Variant selection';
  }),
);
export type PromotionContributionRequest = typeof PromotionContributionRequestSchema.Type;

export const PromotionApplicationIdentitySchema = Schema.Struct({
  applicationKind: Schema.Literal('PROMOTION_APPLICATION'),
  applicationRef: stableReference,
  applicationRevision: stableReference,
  originalApplicationRef: stableReference,
});
export type PromotionApplicationIdentity = typeof PromotionApplicationIdentitySchema.Type;

export const PromotionContributionOwnerEvidenceSchema = Schema.Struct({
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
      return 'Promotion owner evidence must bind one owner revision and observation';
    }
    return currentness.evaluatedAt <= currentness.observedAt &&
      currentness.observedAt <= currentness.revalidatedAt &&
      (completenessEvidence.nextApplicabilityBoundary === undefined ||
        currentness.revalidatedAt < completenessEvidence.nextApplicabilityBoundary)
      ? undefined
      : 'Promotion currentness evidence must preserve evaluation, observation, and revalidation order';
  }),
);
export type PromotionContributionOwnerEvidence = typeof PromotionContributionOwnerEvidenceSchema.Type;

export const PromotionContributionTargetSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('MERCHANDISE_ONLY'),
    occurrenceIds: distinctOccurrenceIds,
  }),
  Schema.Struct({
    kind: Schema.Literal('BASKET_WITH_EXPLICIT_SHIPPING'),
    occurrenceIds: distinctOccurrenceIds,
    shippingComponentRefs: boundedReferences,
  }),
]);
export type PromotionContributionTarget = typeof PromotionContributionTargetSchema.Type;

export const PromotionContributionAllocationSchema = Schema.Union([
  Schema.Struct({
    amount: PromotionNonPositiveMoneySchema,
    catalogSelection: PricingCatalogSelectionSchema,
    occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
    recipientKind: Schema.Literal('MERCHANDISE'),
  }),
  Schema.Struct({
    amount: PromotionNonPositiveMoneySchema,
    deliveryComponentRef: stableReference,
    recipientKind: Schema.Literal('SHIPPING'),
  }),
]);
export type PromotionContributionAllocation = typeof PromotionContributionAllocationSchema.Type;

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

const allocationSumEquals = (expected: string, values: readonly string[]): boolean => {
  const expectedPart = decimalParts(expected);
  const valueParts = values.map(decimalParts);
  const parts = [expectedPart, ...valueParts];
  const scale = Math.max(...parts.map((part) => part.scale));
  const aligned = ({ coefficient, scale: partScale }: DecimalParts) => coefficient * 10n ** BigInt(scale - partScale);
  return aligned(expectedPart) === valueParts.reduce((sum, part) => sum + aligned(part), 0n);
};

const decimalSumCoefficient = (values: readonly string[]): bigint => {
  const parts = values.map(decimalParts);
  const scale = Math.max(0, ...parts.map((part) => part.scale));
  return parts.reduce(
    (sum, { coefficient, scale: partScale }) => sum + coefficient * 10n ** BigInt(scale - partScale),
    0n,
  );
};

const sameReferences = (left: readonly string[], right: readonly string[]): boolean => {
  const rightSet = new Set(right);
  return left.length === right.length && left.every((value) => rightSet.has(value));
};

const ownerEvidenceMatchesRequest = (
  evidence: PromotionContributionOwnerEvidence,
  request: PromotionContributionRequest,
): boolean =>
  evidence.exactPredicateRef === request.exactPredicateRef &&
  evidence.currentness.evaluatedAt === request.candidate.decision.operationTime;

export const PromotionContributionAppliedSchema = Schema.TaggedStruct('PROMOTION_CONTRIBUTION_APPLIED', {
  allocations: Schema.Array(PromotionContributionAllocationSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(501),
  ),
  applicationIdentity: PromotionApplicationIdentitySchema,
  contribution: PromotionNonPositiveMoneySchema,
  ownerEvidence: PromotionContributionOwnerEvidenceSchema,
  request: PromotionContributionRequestSchema,
  target: PromotionContributionTargetSchema,
}).check(
  Schema.makeFilter(({ allocations, applicationIdentity, contribution, ownerEvidence, request, target }) => {
    if (
      applicationIdentity.originalApplicationRef !== request.applicationRequestRef ||
      contribution.currencyCode !== request.candidate.decision.currencyCode ||
      allocations.some(({ amount }) => amount.currencyCode !== contribution.currencyCode) ||
      !ownerEvidenceMatchesRequest(ownerEvidence, request)
    ) {
      return 'Applied Promotion contribution must bind the original application and exact candidate currency';
    }
    if (
      !allocationSumEquals(
        contribution.amount,
        allocations.map(({ amount }) => amount.amount),
      )
    ) {
      return 'Promotion allocations must sum exactly to the original owner contribution';
    }
    const merchandise = allocations.filter((allocation) => allocation.recipientKind === 'MERCHANDISE');
    const shipping = allocations.filter((allocation) => allocation.recipientKind === 'SHIPPING');
    if (
      new Set(merchandise.map(({ occurrenceId }) => occurrenceId)).size !== merchandise.length ||
      new Set(shipping.map(({ deliveryComponentRef }) => deliveryComponentRef)).size !== shipping.length
    ) {
      return 'Promotion allocations must preserve distinct merchandise and Shipping recipients';
    }
    if (decimalSumCoefficient(request.prePromotionBasis.lines.map(({ amount }) => amount.amount)) <= 0n) {
      return 'A zero or non-positive eligible pre-Promotion basis requires the parked owner outcome';
    }
    if (
      merchandise.some(
        (allocation) =>
          !request.candidate.decision.lines.some(
            (line) =>
              line.occurrenceId === allocation.occurrenceId &&
              sameSelection(line.catalog.selection, allocation.catalogSelection),
          ),
      )
    ) {
      return 'Promotion merchandise allocations must bind original occurrences and exact Variant selections';
    }
    const occurrenceIds = merchandise.map(({ occurrenceId }) => occurrenceId);
    if (!sameReferences(target.occurrenceIds, occurrenceIds)) {
      return 'Promotion target and merchandise allocation recipients must match exactly';
    }
    if (target.kind === 'MERCHANDISE_ONLY') {
      return shipping.length === 0 ? undefined : 'Shipping requires an explicit basket-with-Shipping target';
    }
    const shippingRefs = shipping.map(({ deliveryComponentRef }) => deliveryComponentRef);
    if (!sameReferences(target.shippingComponentRefs, shippingRefs)) {
      return 'Explicit Shipping targets and Delivery-owned component allocations must match exactly';
    }
    return ownerEvidence.completenessEvidence.scope.kind === 'EXACT_PREDICATE'
      ? undefined
      : 'Applied Promotion contribution requires exact-predicate owner completeness';
  }),
);
export type PromotionContributionApplied = typeof PromotionContributionAppliedSchema.Type;

export const PromotionContributionNotApplicableSchema = Schema.TaggedStruct('PROMOTION_CONTRIBUTION_NOT_APPLICABLE', {
  ownerEvidence: PromotionContributionOwnerEvidenceSchema,
  reason: Schema.Literals(['NO_APPLICABLE_APPLICATION', 'APPLICATION_NOT_ELIGIBLE']),
  request: PromotionContributionRequestSchema,
}).check(
  Schema.makeFilter(({ ownerEvidence, request }) =>
    ownerEvidenceMatchesRequest(ownerEvidence, request)
      ? undefined
      : 'Promotion non-applicability evidence must bind the exact request predicate and operation time',
  ),
);
export type PromotionContributionNotApplicable = typeof PromotionContributionNotApplicableSchema.Type;

export const PromotionContributionParkedSchema = Schema.TaggedStruct(
  'PROMOTION_CONTRIBUTION_PARKED_NON_POSITIVE_BASIS',
  {
    applicationIdentity: PromotionApplicationIdentitySchema,
    ownerEvidence: PromotionContributionOwnerEvidenceSchema,
    reason: Schema.Literal('NON_POSITIVE_ELIGIBLE_PRE_PROMOTION_BASIS_REQUIRES_OWNER_DECISION'),
    request: PromotionContributionRequestSchema,
  },
).check(
  Schema.makeFilter(({ applicationIdentity, ownerEvidence, request }) => {
    if (
      applicationIdentity.originalApplicationRef !== request.applicationRequestRef ||
      !ownerEvidenceMatchesRequest(ownerEvidence, request)
    ) {
      return 'Parked Promotion outcome must bind the original application and exact request evidence';
    }
    return decimalSumCoefficient(request.prePromotionBasis.lines.map(({ amount }) => amount.amount)) <= 0n
      ? undefined
      : 'The parked Promotion outcome is only valid for a zero or non-positive eligible basis';
  }),
);
export type PromotionContributionParked = typeof PromotionContributionParkedSchema.Type;

export const PromotionContributionInvalidSchema = Schema.TaggedStruct('PROMOTION_CONTRIBUTION_INVALID', {
  reason: Schema.Literals(['CANDIDATE_BINDING_MISMATCH', 'APPLICATION_INVALID', 'CURRENCY_MISMATCH', 'TARGET_INVALID']),
  request: PromotionContributionRequestSchema,
  retryable: Schema.Literal(false),
});
export type PromotionContributionInvalid = typeof PromotionContributionInvalidSchema.Type;

export const PromotionContributionConflictSchema = Schema.TaggedStruct('PROMOTION_CONTRIBUTION_CONFLICT', {
  conflictingApplicationRefs: boundedReferences,
  reason: Schema.Literal('MULTIPLE_AUTHORITATIVE_CONTRIBUTIONS'),
  request: PromotionContributionRequestSchema,
  retryable: Schema.Literal(false),
});
export type PromotionContributionConflict = typeof PromotionContributionConflictSchema.Type;

export const PromotionContributionUnavailableSchema = Schema.TaggedStruct('PROMOTION_CONTRIBUTION_UNAVAILABLE', {
  reason: Schema.Literals(['OWNER_UNAVAILABLE', 'CURRENT_SET_UNAVAILABLE']),
  request: PromotionContributionRequestSchema,
  retryable: Schema.Literal(true),
});
export type PromotionContributionUnavailable = typeof PromotionContributionUnavailableSchema.Type;

export const PromotionContributionUnverifiableSchema = Schema.TaggedStruct('PROMOTION_CONTRIBUTION_UNVERIFIABLE', {
  missingEvidenceRefs: boundedReferences,
  reason: Schema.Literals(['EVIDENCE_INCOMPLETE', 'EVIDENCE_STALE', 'EVIDENCE_UNVERIFIABLE']),
  request: PromotionContributionRequestSchema,
  retryable: Schema.Literal(true),
});
export type PromotionContributionUnverifiable = typeof PromotionContributionUnverifiableSchema.Type;

export const PromotionContributionDecisionSchema = Schema.Union([
  PromotionContributionAppliedSchema,
  PromotionContributionNotApplicableSchema,
  PromotionContributionParkedSchema,
]);
export type PromotionContributionDecision = typeof PromotionContributionDecisionSchema.Type;

export const PromotionContributionFailureSchema = Schema.Union([
  PromotionContributionInvalidSchema,
  PromotionContributionConflictSchema,
  PromotionContributionUnavailableSchema,
  PromotionContributionUnverifiableSchema,
]);
export type PromotionContributionFailure = typeof PromotionContributionFailureSchema.Type;

export const PromotionContributionOutcomeSchema = Schema.Union([
  PromotionContributionDecisionSchema,
  PromotionContributionFailureSchema,
]);
export type PromotionContributionOutcome = typeof PromotionContributionOutcomeSchema.Type;

export interface PromotionContributionSourcePort {
  readonly evaluate: (request: PromotionContributionRequest) => Effect.Effect<PromotionContributionOutcome>;
}

/** Injectable owner seam only. No Promotion provider or transport exists until that parked capability is activated. */
export class PromotionContributionSource extends Context.Service<
  PromotionContributionSource,
  PromotionContributionSourcePort
>()('@app/pricing-contracts/domain/promotion-contribution/PromotionContributionSource') {}
