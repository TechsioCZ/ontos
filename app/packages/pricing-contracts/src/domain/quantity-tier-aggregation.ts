import { Schema } from 'effect';

import { PricingInstantSchema } from '../apis/current-supported-currencies.ts';
import { PriceGroupSelectorSchema, priceDecimalValuesEqual } from './price-definition.ts';
import { PricingCommercialScopeSchema } from './pricing-commercial-scope.ts';
import {
  PricingCatalogSelectionSchema,
  PricingDecisionSchema,
  PricingLineSchema,
  PricingPurchaseDemandOccurrenceIdSchema,
} from './pricing-decision.ts';
import {
  QuantityTierExactPriceEffectSchema,
  QuantityTierNormalizedQuantitySchema,
  QuantityTierQuantityBasisSchema,
} from './quantity-tier.ts';

const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());

const samePricingLine = Schema.toEquivalence(PricingLineSchema);
const sameCatalogSelection = Schema.toEquivalence(PricingCatalogSelectionSchema);
const sameExactPrice = Schema.toEquivalence(QuantityTierExactPriceEffectSchema);
const sameQuantityBasis = Schema.toEquivalence(QuantityTierQuantityBasisSchema);
const samePriceGroupSelector = Schema.toEquivalence(PriceGroupSelectorSchema);
const sameCommercialScope = Schema.toEquivalence(PricingCommercialScopeSchema);

const uniqueOccurrenceIds = (ids: readonly string[]): boolean => new Set(ids).size === ids.length;

const sameResourceRef = (
  left: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
  right: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const decimalParts = (value: string): readonly [whole: string, fraction: string] => {
  const [whole = '0', fraction = ''] = value.split('.');
  return [whole, fraction];
};

/** Exact decimal sum for already-validated non-negative Pricing quantities. */
export const sumQuantityTierDecimalValues = (values: readonly string[]): string => {
  const parts = values.map(decimalParts);
  let scale = 0;
  for (const [, fraction] of parts) {
    scale = Math.max(scale, fraction.length);
  }
  let coefficient = 0n;
  for (const [whole, fraction] of parts) {
    coefficient += BigInt(`${whole}${fraction.padEnd(scale, '0')}`);
  }
  if (scale === 0) {
    return coefficient.toString();
  }
  const digits = coefficient.toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/u, '');
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
};

/** Sum only quantities whose complete owner-issued Quantity Basis is exactly compatible. */
export const sumQuantityTierNormalizedQuantities = (
  quantities: readonly (typeof QuantityTierNormalizedQuantitySchema.Type)[],
): typeof QuantityTierNormalizedQuantitySchema.Type | undefined => {
  const [first] = quantities;
  if (
    first === undefined ||
    quantities.some(({ quantityBasis }) => !sameQuantityBasis(quantityBasis, first.quantityBasis))
  ) {
    return undefined;
  }
  return {
    quantity: sumQuantityTierDecimalValues(quantities.map(({ quantity }) => quantity)),
    quantityBasis: first.quantityBasis,
  };
};

export const CatalogPricingPurposeEquivalenceMemberSchema = Schema.Struct({
  occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
  selection: PricingCatalogSelectionSchema,
});
export type CatalogPricingPurposeEquivalenceMember = typeof CatalogPricingPurposeEquivalenceMemberSchema.Type;

export const CatalogPricingPurposeEquivalenceAssessmentIdSchema = stableReference.pipe(
  Schema.brand('CatalogPricingPurposeEquivalenceAssessmentId'),
  Schema.decodeTo(Schema.String),
);
export type CatalogPricingPurposeEquivalenceAssessmentId =
  typeof CatalogPricingPurposeEquivalenceAssessmentIdSchema.Type;

/**
 * Catalog-owner confirmation that the exact member selections have one meaning for Pricing only.
 * The finite validity boundary makes currentness explicit; accepted historical evidence remains replayable.
 */
export const CatalogPricingPurposeEquivalenceEvidenceSchema = Schema.Struct({
  anchorSelection: PricingCatalogSelectionSchema,
  assessmentId: CatalogPricingPurposeEquivalenceAssessmentIdSchema,
  effectiveAt: PricingInstantSchema,
  members: Schema.Array(CatalogPricingPurposeEquivalenceMemberSchema).check(
    Schema.isMinLength(1),
    Schema.makeFilter((members) =>
      uniqueOccurrenceIds(members.map(({ occurrenceId }) => occurrenceId))
        ? undefined
        : 'Catalog Pricing-purpose equivalence members must preserve distinct occurrence identities',
    ),
  ),
  observedAt: PricingInstantSchema,
  ownerModuleId: Schema.Literal('commerce.catalog'),
  ownerRevision: stableReference,
  purpose: Schema.Literal('PRICING'),
  status: Schema.Literal('CONFIRMED'),
  validThrough: PricingInstantSchema,
}).check(
  Schema.makeFilter(({ effectiveAt, observedAt, validThrough }) => {
    if (observedAt < effectiveAt) {
      return 'Catalog Pricing-purpose equivalence observation must not predate its effective time';
    }
    return effectiveAt < validThrough
      ? undefined
      : 'Catalog Pricing-purpose equivalence requires a non-empty as-of currentness interval';
  }),
);
export type CatalogPricingPurposeEquivalenceEvidence = typeof CatalogPricingPurposeEquivalenceEvidenceSchema.Type;

/** Owner lookup outcome remains typed even when no valid equivalence evidence can be produced. */
export const CatalogPricingPurposeEquivalenceResolutionSchema = Schema.Union([
  Schema.Struct({
    evidence: CatalogPricingPurposeEquivalenceEvidenceSchema,
    outcome: Schema.Literal('CATALOG_EQUIVALENCE_CONFIRMED'),
  }),
  Schema.Struct({ outcome: Schema.Literal('CATALOG_EQUIVALENCE_UNAVAILABLE') }),
  Schema.Struct({
    evidenceRef: Schema.optionalKey(stableReference),
    outcome: Schema.Literal('CATALOG_EQUIVALENCE_UNVERIFIABLE'),
  }),
]);
export type CatalogPricingPurposeEquivalenceResolution = typeof CatalogPricingPurposeEquivalenceResolutionSchema.Type;

export const QuantityTierAggregationCandidateRefSchema = stableReference.pipe(
  Schema.brand('PricingQuantityTierAggregationCandidateRef'),
  Schema.decodeTo(Schema.String),
);
export type QuantityTierAggregationCandidateRef = typeof QuantityTierAggregationCandidateRefSchema.Type;

/** One original Pricing Line remains the monetary recipient after it contributes Quantity. */
export const QuantityTierAggregationParticipantSchema = Schema.Struct({
  candidateRef: QuantityTierAggregationCandidateRefSchema,
  exactPrice: QuantityTierExactPriceEffectSchema,
  line: PricingLineSchema,
  normalizedQuantity: QuantityTierNormalizedQuantitySchema,
});
export type QuantityTierAggregationParticipant = typeof QuantityTierAggregationParticipantSchema.Type;

/** Evidence available even when a group must be refused. */
export const QuantityTierAggregationAttemptSchema = Schema.Struct({
  candidate: PricingDecisionSchema,
  candidateRef: QuantityTierAggregationCandidateRefSchema,
  evaluatedAt: PricingInstantSchema,
  participants: Schema.Array(QuantityTierAggregationParticipantSchema).check(Schema.isMinLength(1)),
}).check(
  Schema.makeFilter(({ candidate, evaluatedAt }) =>
    evaluatedAt === candidate.operationTime
      ? undefined
      : 'Quantity Tier aggregation must evaluate the exact candidate operation time',
  ),
);
export type QuantityTierAggregationAttempt = typeof QuantityTierAggregationAttemptSchema.Type;

const participantMatchesCandidate = (
  participant: QuantityTierAggregationParticipant,
  attempt: QuantityTierAggregationAttempt,
): boolean =>
  participant.candidateRef === attempt.candidateRef &&
  attempt.candidate.lines.some(
    (line) => line.occurrenceId === participant.line.occurrenceId && samePricingLine(line, participant.line),
  );

const exactPriceMatchesCandidate = (
  participant: QuantityTierAggregationParticipant,
  attempt: QuantityTierAggregationAttempt,
): boolean => {
  const identity = participant.exactPrice.price.definition.identityKey;
  return (
    participant.exactPrice.price.definition.priceRef.tenantId === attempt.candidate.tenantId &&
    identity.currencyCode === attempt.candidate.currencyCode &&
    sameCommercialScope(identity.commercialScope, attempt.candidate.commercialScope) &&
    samePriceGroupSelector(identity.priceGroupSelector, participant.exactPrice.path.priceGroupSelector)
  );
};

const selectionHasSameNonMaterialAnchor = (
  anchor: typeof PricingCatalogSelectionSchema.Type,
  member: typeof PricingCatalogSelectionSchema.Type,
): boolean => {
  const anchorOption = anchor.packageOption?.optionRef;
  const memberOption = member.packageOption?.optionRef;
  return (
    sameResourceRef(anchor.productRef, member.productRef) &&
    sameResourceRef(anchor.variantRef, member.variantRef) &&
    ((anchorOption === undefined && memberOption === undefined) ||
      (anchorOption !== undefined && memberOption !== undefined && sameResourceRef(anchorOption, memberOption)))
  );
};

const participantSelectionAndBasisMatch = (participant: QuantityTierAggregationParticipant): boolean => {
  const lineSelection = participant.line.catalog.selection;
  const priceIdentity = participant.exactPrice.price.definition.identityKey;
  const lineTarget = lineSelection.packageOption?.optionRef ?? lineSelection.variantRef;
  const catalogBasis = participant.normalizedQuantity.quantityBasis.catalogQuantityBasis;
  const priceBasis = participant.normalizedQuantity.quantityBasis.priceUnitBasis;
  return (
    selectionHasSameNonMaterialAnchor(priceIdentity.catalogSelection, lineSelection) &&
    sameResourceRef(catalogBasis.targetRef, lineTarget) &&
    sameResourceRef(priceIdentity.unitBasis.unitRef, priceBasis.unitRef) &&
    priceDecimalValuesEqual(priceIdentity.unitBasis.quantity, priceBasis.quantity)
  );
};

const equivalenceMatchesParticipants = (
  evidence: CatalogPricingPurposeEquivalenceEvidence,
  participants: readonly QuantityTierAggregationParticipant[],
): boolean => {
  const anchorPrice = participants[0]?.exactPrice.price.definition.identityKey.catalogSelection;
  return (
    anchorPrice !== undefined &&
    sameCatalogSelection(evidence.anchorSelection, anchorPrice) &&
    evidence.members.length === participants.length &&
    evidence.members.every((member, index) => {
      const participant = participants[index];
      return (
        participant !== undefined &&
        member.occurrenceId === participant.line.occurrenceId &&
        sameCatalogSelection(member.selection, participant.line.catalog.selection) &&
        selectionHasSameNonMaterialAnchor(evidence.anchorSelection, member.selection)
      );
    })
  );
};

/** A valid group is one exact candidate, Price path/revision, backend context, basis, and Catalog equivalence set. */
export const QuantityTierAggregationInputSchema = Schema.Struct({
  attempt: QuantityTierAggregationAttemptSchema,
  catalogEquivalence: CatalogPricingPurposeEquivalenceEvidenceSchema,
}).check(
  Schema.makeFilter(({ attempt, catalogEquivalence }) => {
    const { participants } = attempt;
    const occurrenceIds = participants.map(({ line }) => line.occurrenceId);
    if (!uniqueOccurrenceIds(occurrenceIds)) {
      return 'Quantity Tier aggregation cannot duplicate a Purchase Demand occurrence';
    }
    if (!participants.every((participant) => participantMatchesCandidate(participant, attempt))) {
      return 'Quantity Tier aggregation participants must be exact lines of one purchase candidate';
    }
    const [first] = participants;
    if (
      first === undefined ||
      !participants.every(
        (participant) =>
          sameExactPrice(participant.exactPrice, first.exactPrice) &&
          exactPriceMatchesCandidate(participant, attempt) &&
          participantSelectionAndBasisMatch(participant),
      )
    ) {
      return 'Quantity Tier aggregation requires one exact Price identity, Revision, path, and backend context';
    }
    if (
      !participants.every((participant) =>
        sameQuantityBasis(participant.normalizedQuantity.quantityBasis, first.normalizedQuantity.quantityBasis),
      )
    ) {
      return 'Quantity Tier aggregation requires one exact compatible Quantity Basis without conversion';
    }
    if (!equivalenceMatchesParticipants(catalogEquivalence, participants)) {
      return 'Quantity Tier aggregation requires exact Catalog-owner-confirmed Pricing-purpose equivalence';
    }
    return catalogEquivalence.effectiveAt === attempt.evaluatedAt &&
      attempt.evaluatedAt < catalogEquivalence.validThrough
      ? undefined
      : 'Quantity Tier aggregation requires Current Catalog equivalence evidence';
  }),
);
export type QuantityTierAggregationInput = typeof QuantityTierAggregationInputSchema.Type;

/** Runtime request shape deliberately accepts owner lookup failures and invalid group attempts for typed refusal. */
export const QuantityTierAggregationRequestSchema = Schema.Struct({
  attempt: QuantityTierAggregationAttemptSchema,
  catalogEquivalence: CatalogPricingPurposeEquivalenceResolutionSchema,
});
export type QuantityTierAggregationRequest = typeof QuantityTierAggregationRequestSchema.Type;

/** Exact snapshots that make line structure, material selection meaning, and owner currentness replayable. */
export const QuantityTierAggregationCurrentnessEvidenceSchema = Schema.Struct({
  candidate: PricingDecisionSchema,
  candidateRef: QuantityTierAggregationCandidateRefSchema,
  catalogEquivalence: CatalogPricingPurposeEquivalenceEvidenceSchema,
  evaluatedAt: PricingInstantSchema,
  exactPrice: QuantityTierExactPriceEffectSchema,
  participantOccurrenceIds: Schema.Array(PricingPurchaseDemandOccurrenceIdSchema).check(Schema.isMinLength(1)),
});
export type QuantityTierAggregationCurrentnessEvidence = typeof QuantityTierAggregationCurrentnessEvidenceSchema.Type;

export const QuantityTierAggregationEvidenceSchema = Schema.Struct({
  currentness: QuantityTierAggregationCurrentnessEvidenceSchema,
  input: QuantityTierAggregationInputSchema,
});
export type QuantityTierAggregationEvidence = typeof QuantityTierAggregationEvidenceSchema.Type;

const sameDecision = Schema.toEquivalence(PricingDecisionSchema);
const sameEquivalenceEvidence = Schema.toEquivalence(CatalogPricingPurposeEquivalenceEvidenceSchema);

export const QuantityTierAggregationSuccessSchema = Schema.Struct({
  aggregatedQuantity: QuantityTierNormalizedQuantitySchema,
  evidence: QuantityTierAggregationEvidenceSchema,
  outcome: Schema.Literal('QUANTITY_TIER_QUANTITY_AGGREGATED'),
  recipientLines: Schema.Array(PricingLineSchema).check(Schema.isMinLength(1)),
}).check(
  Schema.makeFilter(({ aggregatedQuantity, evidence, recipientLines }) => {
    const { attempt, catalogEquivalence } = evidence.input;
    const expectedRecipients = attempt.participants.map(({ line }) => line);
    const expectedQuantity = sumQuantityTierNormalizedQuantities(
      attempt.participants.map(({ normalizedQuantity }) => normalizedQuantity),
    );
    const firstPrice = attempt.participants[0]?.exactPrice;
    const { currentness } = evidence;
    const occurrenceIds = attempt.participants.map(({ line }) => line.occurrenceId);
    const currentnessMatches =
      firstPrice !== undefined &&
      currentness.candidateRef === attempt.candidateRef &&
      currentness.evaluatedAt === attempt.evaluatedAt &&
      sameDecision(currentness.candidate, attempt.candidate) &&
      sameExactPrice(currentness.exactPrice, firstPrice) &&
      sameEquivalenceEvidence(currentness.catalogEquivalence, catalogEquivalence) &&
      currentness.participantOccurrenceIds.length === occurrenceIds.length &&
      currentness.participantOccurrenceIds.every((occurrenceId, index) => occurrenceId === occurrenceIds[index]);
    const recipientsMatch =
      recipientLines.length === expectedRecipients.length &&
      recipientLines.every((line, index) => {
        const expected = expectedRecipients[index];
        return expected !== undefined && samePricingLine(line, expected);
      });
    return expectedQuantity !== undefined &&
      sameQuantityBasis(aggregatedQuantity.quantityBasis, expectedQuantity.quantityBasis) &&
      priceDecimalValuesEqual(aggregatedQuantity.quantity, expectedQuantity.quantity) &&
      recipientsMatch &&
      currentnessMatches
      ? undefined
      : 'Quantity Tier aggregation must preserve recipients, exact decimal sum, and replayable Current evidence';
  }),
);
export type QuantityTierAggregationSuccess = typeof QuantityTierAggregationSuccessSchema.Type;

export const QuantityTierAggregationFailureReasonSchema = Schema.Literals([
  'PURCHASE_CANDIDATE_MISMATCH',
  'DUPLICATE_OCCURRENCE',
  'RECIPIENT_STRUCTURE_MISMATCH',
  'PRICE_IDENTITY_MISMATCH',
  'PRICE_REVISION_MISMATCH',
  'PRICE_PATH_MISMATCH',
  'COMMERCIAL_CONTEXT_MISMATCH',
  'GROUP_MISMATCH',
  'CURRENCY_MISMATCH',
  'INCOMPATIBLE_QUANTITY_BASIS',
  'CATALOG_EQUIVALENCE_UNAVAILABLE',
  'CATALOG_EQUIVALENCE_UNVERIFIABLE',
  'CATALOG_EQUIVALENCE_MISMATCH',
  'STALE_CATALOG_EQUIVALENCE',
]);
export type QuantityTierAggregationFailureReason = typeof QuantityTierAggregationFailureReasonSchema.Type;

export const QuantityTierAggregationFailureSchema = Schema.Struct({
  attempt: QuantityTierAggregationAttemptSchema,
  input: Schema.optionalKey(QuantityTierAggregationInputSchema),
  outcome: Schema.Literal('QUANTITY_TIER_AGGREGATION_REFUSED'),
  participantOccurrenceIds: Schema.Array(PricingPurchaseDemandOccurrenceIdSchema),
  reason: QuantityTierAggregationFailureReasonSchema,
}).check(
  Schema.makeFilter(({ attempt, participantOccurrenceIds }) => {
    const expected = attempt.participants.map(({ line }) => line.occurrenceId);
    return participantOccurrenceIds.length === expected.length &&
      participantOccurrenceIds.every((occurrenceId, index) => occurrenceId === expected[index])
      ? undefined
      : 'Quantity Tier aggregation refusal must preserve the exact attempted occurrence identities';
  }),
);
export type QuantityTierAggregationFailure = typeof QuantityTierAggregationFailureSchema.Type;

export const QuantityTierAggregationResultSchema = Schema.Union([
  QuantityTierAggregationSuccessSchema,
  QuantityTierAggregationFailureSchema,
]);
export type QuantityTierAggregationResult = typeof QuantityTierAggregationResultSchema.Type;
