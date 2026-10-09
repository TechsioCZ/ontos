import type {
  CatalogPricingPurposeEquivalenceEvidence,
  QuantityTierAggregationAttempt,
  QuantityTierAggregationFailure,
  QuantityTierAggregationFailureReason,
  QuantityTierAggregationRequest,
  QuantityTierAggregationResult,
} from '@app/pricing-contracts/domain/quantity-tier-aggregation';
import { sumQuantityTierNormalizedQuantities } from '@app/pricing-contracts/domain/quantity-tier-aggregation';
import {
  PriceIdentityKeySchema,
  PriceGroupSelectorSchema,
  PriceUnitBasisSchema,
} from '@app/pricing-contracts/domain/price-definition';
import { ScheduledPriceRevisionSchema } from '@app/pricing-contracts/domain/price-schedule';
import { PricingCommercialScopeSchema } from '@app/pricing-contracts/domain/pricing-commercial-scope';
import { PricingCatalogSelectionSchema, PricingLineSchema } from '@app/pricing-contracts/pricing-decision';
import {
  QuantityTierPricePathSchema,
  QuantityTierQuantityBasisSchema,
} from '@app/pricing-contracts/domain/quantity-tier';
import { Effect, Schema } from 'effect';

const sameCatalogSelection = Schema.toEquivalence(PricingCatalogSelectionSchema);
const sameCommercialScope = Schema.toEquivalence(PricingCommercialScopeSchema);
const sameIdentityKey = Schema.toEquivalence(PriceIdentityKeySchema);
const sameLine = Schema.toEquivalence(PricingLineSchema);
const samePath = Schema.toEquivalence(QuantityTierPricePathSchema);
const samePriceGroupSelector = Schema.toEquivalence(PriceGroupSelectorSchema);
const samePriceUnitBasis = Schema.toEquivalence(PriceUnitBasisSchema);
const sameQuantityBasis = Schema.toEquivalence(QuantityTierQuantityBasisSchema);
const sameScheduledPriceRevision = Schema.toEquivalence(ScheduledPriceRevisionSchema);

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

const refusal = (
  attempt: QuantityTierAggregationAttempt,
  reason: QuantityTierAggregationFailureReason,
): QuantityTierAggregationFailure => ({
  attempt,
  outcome: 'QUANTITY_TIER_AGGREGATION_REFUSED',
  participantOccurrenceIds: attempt.participants.map(({ line }) => line.occurrenceId),
  reason,
});

const candidateFailure = (
  attempt: QuantityTierAggregationAttempt,
): QuantityTierAggregationFailureReason | undefined => {
  const { candidate, candidateRef, participants } = attempt;
  const occurrenceIds = participants.map(({ line }) => line.occurrenceId);
  if (new Set(occurrenceIds).size !== occurrenceIds.length) {
    return 'DUPLICATE_OCCURRENCE';
  }
  if (participants.some((participant) => participant.candidateRef !== candidateRef)) {
    return 'PURCHASE_CANDIDATE_MISMATCH';
  }
  for (const { line } of participants) {
    const candidateLine = candidate.lines.find(({ occurrenceId }) => occurrenceId === line.occurrenceId);
    if (candidateLine === undefined) {
      return 'PURCHASE_CANDIDATE_MISMATCH';
    }
    if (!sameLine(candidateLine, line)) {
      return 'RECIPIENT_STRUCTURE_MISMATCH';
    }
  }
  return undefined;
};

const contextFailure = (attempt: QuantityTierAggregationAttempt): QuantityTierAggregationFailureReason | undefined => {
  const { candidate, participants } = attempt;
  const [first] = participants;
  if (first === undefined) {
    return 'PURCHASE_CANDIDATE_MISMATCH';
  }
  const { definition: firstDefinition } = first.exactPrice.price;
  const { identityKey: firstIdentity } = firstDefinition;
  if (
    firstDefinition.priceRef.tenantId !== candidate.tenantId ||
    participants.some(({ exactPrice }) => exactPrice.price.definition.priceRef.tenantId !== candidate.tenantId)
  ) {
    return 'COMMERCIAL_CONTEXT_MISMATCH';
  }
  if (
    firstIdentity.currencyCode !== candidate.currencyCode ||
    participants.some(
      ({ exactPrice }) => exactPrice.price.definition.identityKey.currencyCode !== candidate.currencyCode,
    )
  ) {
    return 'CURRENCY_MISMATCH';
  }
  if (
    !sameCommercialScope(firstIdentity.commercialScope, candidate.commercialScope) ||
    participants.some(
      ({ exactPrice }) =>
        !sameCommercialScope(exactPrice.price.definition.identityKey.commercialScope, candidate.commercialScope),
    )
  ) {
    return 'COMMERCIAL_CONTEXT_MISMATCH';
  }
  if (
    participants.some(
      ({ exactPrice }) =>
        !samePriceGroupSelector(
          exactPrice.price.definition.identityKey.priceGroupSelector,
          firstIdentity.priceGroupSelector,
        ) ||
        !samePriceGroupSelector(
          exactPrice.path.priceGroupSelector,
          exactPrice.price.definition.identityKey.priceGroupSelector,
        ),
    )
  ) {
    return 'GROUP_MISMATCH';
  }
  return undefined;
};

const participantBindingFailure = (
  attempt: QuantityTierAggregationAttempt,
): QuantityTierAggregationFailureReason | undefined => {
  const [first] = attempt.participants;
  if (first === undefined) {
    return 'PURCHASE_CANDIDATE_MISMATCH';
  }
  const { identityKey: firstIdentity, priceRef: firstPriceRef } = first.exactPrice.price.definition;
  for (const participant of attempt.participants) {
    const { identityKey: identity, priceRef } = participant.exactPrice.price.definition;
    const lineSelection = participant.line.catalog.selection;
    const canonicalLineTarget = lineSelection.packageOption?.optionRef ?? lineSelection.variantRef;
    const { catalogQuantityBasis, priceUnitBasis } = participant.normalizedQuantity.quantityBasis;
    if (
      !selectionHasSameNonMaterialAnchor(identity.catalogSelection, lineSelection) ||
      !sameResourceRef(priceRef, firstPriceRef) ||
      !sameCatalogSelection(identity.catalogSelection, firstIdentity.catalogSelection)
    ) {
      return 'PRICE_IDENTITY_MISMATCH';
    }
    if (
      !sameResourceRef(catalogQuantityBasis.targetRef, canonicalLineTarget) ||
      !samePriceUnitBasis(identity.unitBasis, priceUnitBasis)
    ) {
      return 'INCOMPATIBLE_QUANTITY_BASIS';
    }
  }
  return undefined;
};

const priceConsistencyFailure = (
  attempt: QuantityTierAggregationAttempt,
): QuantityTierAggregationFailureReason | undefined => {
  const { participants } = attempt;
  const [first] = participants;
  if (first === undefined) {
    return 'PURCHASE_CANDIDATE_MISMATCH';
  }
  const { identityKey: firstIdentity } = first.exactPrice.price.definition;
  if (
    participants.some(
      ({ exactPrice }) =>
        !samePriceUnitBasis(exactPrice.price.definition.identityKey.unitBasis, firstIdentity.unitBasis),
    ) ||
    participants.some(
      ({ normalizedQuantity }) =>
        !sameQuantityBasis(normalizedQuantity.quantityBasis, first.normalizedQuantity.quantityBasis),
    )
  ) {
    return 'INCOMPATIBLE_QUANTITY_BASIS';
  }

  if (
    participants.some(({ exactPrice }) => {
      const { definition } = exactPrice.price;
      return (
        !sameIdentityKey(definition.identityKey, firstIdentity) ||
        !sameScheduledPriceRevision(exactPrice.price, first.exactPrice.price) ||
        exactPrice.scheduleRevision !== first.exactPrice.scheduleRevision
      );
    })
  ) {
    return 'PRICE_REVISION_MISMATCH';
  }

  if (participants.some(({ exactPrice }) => !samePath(exactPrice.path, first.exactPrice.path))) {
    return 'PRICE_PATH_MISMATCH';
  }
  return undefined;
};

const equivalenceFailure = (
  attempt: QuantityTierAggregationAttempt,
  catalogEquivalence: CatalogPricingPurposeEquivalenceEvidence,
): QuantityTierAggregationFailureReason | undefined => {
  const { evaluatedAt, participants } = attempt;
  const [first] = participants;
  if (first === undefined) {
    return 'PURCHASE_CANDIDATE_MISMATCH';
  }
  if (catalogEquivalence.effectiveAt !== evaluatedAt || evaluatedAt >= catalogEquivalence.validThrough) {
    return 'STALE_CATALOG_EQUIVALENCE';
  }
  const { identityKey: firstIdentity } = first.exactPrice.price.definition;
  if (!sameCatalogSelection(catalogEquivalence.anchorSelection, firstIdentity.catalogSelection)) {
    return 'CATALOG_EQUIVALENCE_MISMATCH';
  }
  if (
    catalogEquivalence.members.length !== participants.length ||
    catalogEquivalence.members.some((member, index) => {
      const participant = participants[index];
      return (
        participant === undefined ||
        member.occurrenceId !== participant.line.occurrenceId ||
        !sameCatalogSelection(member.selection, participant.line.catalog.selection)
      );
    })
  ) {
    return 'CATALOG_EQUIVALENCE_MISMATCH';
  }
  return undefined;
};

const firstFailure = (
  attempt: QuantityTierAggregationAttempt,
  catalogEquivalence: CatalogPricingPurposeEquivalenceEvidence,
): QuantityTierAggregationFailureReason | undefined =>
  candidateFailure(attempt) ??
  contextFailure(attempt) ??
  participantBindingFailure(attempt) ??
  priceConsistencyFailure(attempt) ??
  equivalenceFailure(attempt, catalogEquivalence);

export const aggregateQuantityTierLines = (
  request: QuantityTierAggregationRequest,
): Effect.Effect<QuantityTierAggregationResult> => {
  if (request.catalogEquivalence.outcome !== 'CATALOG_EQUIVALENCE_CONFIRMED') {
    return Effect.succeed(refusal(request.attempt, request.catalogEquivalence.outcome));
  }

  const input = {
    attempt: request.attempt,
    catalogEquivalence: request.catalogEquivalence.evidence,
  };
  const reason = firstFailure(input.attempt, input.catalogEquivalence);
  if (reason !== undefined) {
    return Effect.succeed(refusal(input.attempt, reason));
  }

  const { attempt } = input;
  const aggregatedQuantity = sumQuantityTierNormalizedQuantities(
    attempt.participants.map(({ normalizedQuantity }) => normalizedQuantity),
  );
  const exactPrice = attempt.participants[0]?.exactPrice;
  if (aggregatedQuantity === undefined || exactPrice === undefined) {
    return Effect.succeed(refusal(attempt, 'INCOMPATIBLE_QUANTITY_BASIS'));
  }

  return Effect.succeed({
    aggregatedQuantity,
    evidence: {
      currentness: {
        candidate: attempt.candidate,
        candidateRef: attempt.candidateRef,
        catalogEquivalence: input.catalogEquivalence,
        evaluatedAt: attempt.evaluatedAt,
        exactPrice,
        participantOccurrenceIds: attempt.participants.map(({ line }) => line.occurrenceId),
      },
      input,
    },
    outcome: 'QUANTITY_TIER_QUANTITY_AGGREGATED',
    recipientLines: attempt.participants.map(({ line }) => line),
  });
};
