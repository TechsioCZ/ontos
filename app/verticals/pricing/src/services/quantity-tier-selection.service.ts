import { priceDecimalValuesEqual } from '@app/pricing-contracts/domain/price-definition';
import { compareQuantityTierDecimalValues } from '@app/pricing-contracts/domain/quantity-tier';
import type {
  OwnerProvenCurrentQuantityTierSet,
  QuantityTierQuantityBasis,
  QuantityTierSelectionAttempt,
  QuantityTierSelectionFailureReason,
  QuantityTierSelectionInput,
  QuantityTierSelectionResult,
  ScheduledQuantityTierRevision,
} from '@app/pricing-contracts/domain/quantity-tier';
import { DateTime, Effect, Option } from 'effect';

export type QuantityTierSelectionRequest =
  | {
      readonly attempt: QuantityTierSelectionAttempt;
      readonly candidateTierRevisionIds?: readonly string[];
      readonly outcome: 'TIER_SET_INCOMPLETE' | 'TIER_SET_UNAVAILABLE' | 'TIER_SET_UNVERIFIABLE';
    }
  | {
      readonly input: QuantityTierSelectionInput;
      readonly outcome: 'TIER_SET_CURRENT';
    };

type HighestReachedTierResolution =
  | { readonly outcome: 'NO_THRESHOLD_REACHED' }
  | {
      readonly candidateRevisionIds: readonly string[];
      readonly outcome: 'AMBIGUOUS_THRESHOLD' | 'CONFLICTING_CURRENT_TIERS';
    }
  | {
      readonly outcome: 'HIGHEST_REACHED_THRESHOLD';
      readonly winningTier: ScheduledQuantityTierRevision;
    };

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

const sameQuantityBasis = (left: QuantityTierQuantityBasis, right: QuantityTierQuantityBasis): boolean =>
  sameResourceRef(left.priceUnitBasis.unitRef, right.priceUnitBasis.unitRef) &&
  priceDecimalValuesEqual(left.priceUnitBasis.quantity, right.priceUnitBasis.quantity) &&
  sameResourceRef(left.catalogQuantityBasis.targetRef, right.catalogQuantityBasis.targetRef) &&
  sameResourceRef(left.catalogQuantityBasis.unitRef, right.catalogQuantityBasis.unitRef) &&
  left.catalogQuantityBasis.targetDivisibilityRevision === right.catalogQuantityBasis.targetDivisibilityRevision &&
  left.catalogQuantityBasis.unitRuleRevision === right.catalogQuantityBasis.unitRuleRevision;

const candidateRevisionIds = (tierSet: OwnerProvenCurrentQuantityTierSet): readonly string[] =>
  tierSet.currentTiers.map(({ definition }) => definition.revision.revisionId);

const failure = (
  attempt: QuantityTierSelectionAttempt,
  reason: QuantityTierSelectionFailureReason,
  candidates: readonly string[],
  input?: QuantityTierSelectionInput,
): QuantityTierSelectionResult => {
  const failed = {
    attempt,
    candidateTierRevisionIds: candidates,
    outcome: 'QUANTITY_TIER_SELECTION_FAILED' as const,
    reason,
  };
  return input === undefined ? failed : { ...failed, input };
};

type AcquisitionFailureOutcome = Exclude<
  QuantityTierSelectionRequest,
  { readonly outcome: 'TIER_SET_CURRENT' }
>['outcome'];

const acquisitionFailureReasons = {
  TIER_SET_INCOMPLETE: 'INCOMPLETE_TIER_SET',
  TIER_SET_UNAVAILABLE: 'UNAVAILABLE_TIER_SET',
  TIER_SET_UNVERIFIABLE: 'UNVERIFIABLE_TIER_SET',
} satisfies Readonly<Record<AcquisitionFailureOutcome, QuantityTierSelectionFailureReason>>;

const isEffectiveAt = (revision: ScheduledQuantityTierRevision, evaluatedAt: string): boolean =>
  revision.effectivePeriod.effectiveFrom <= evaluatedAt &&
  (revision.effectivePeriod.effectiveTo === null || evaluatedAt < revision.effectivePeriod.effectiveTo);

const isCompletenessEvidenceStale = (tierSet: OwnerProvenCurrentQuantityTierSet, evaluatedAt: string): boolean => {
  const evaluated = DateTime.make(evaluatedAt);
  const boundary = tierSet.completenessEvidence.nextApplicabilityBoundary;
  if (Option.isNone(evaluated) || boundary === undefined) {
    return false;
  }
  return DateTime.toEpochMillis(boundary) <= DateTime.toEpochMillis(evaluated.value);
};

/**
 * Resolves only the inclusive threshold rule. The caller must first prove the
 * set complete/current and bind every Tier to the exact Price and Quantity basis.
 */
export const resolveHighestReachedQuantityTier = (
  normalizedQuantity: string,
  currentTiers: readonly ScheduledQuantityTierRevision[],
): HighestReachedTierResolution => {
  const byThreshold = new Map<string, ScheduledQuantityTierRevision[]>();
  for (const tier of currentTiers) {
    const threshold = tier.definition.identityKey.thresholdQuantity;
    const existingKey = [...byThreshold.keys()].find(
      (candidate) => compareQuantityTierDecimalValues(candidate, threshold) === 0,
    );
    const key = existingKey ?? threshold;
    byThreshold.set(key, [...(byThreshold.get(key) ?? []), tier]);
  }

  for (const tiers of byThreshold.values()) {
    const [first, ...rest] = tiers;
    if (tiers.length >= 2 && first !== undefined) {
      const firstEffect = first.definition.revision.resultingUnitPrice;
      const hasConflictingEffect = rest.some(({ definition }) => {
        const effect = definition.revision.resultingUnitPrice;
        return (
          effect.currencyCode !== firstEffect.currencyCode ||
          !priceDecimalValuesEqual(effect.amount, firstEffect.amount)
        );
      });
      return {
        candidateRevisionIds: tiers.map(({ definition }) => definition.revision.revisionId),
        outcome: hasConflictingEffect ? 'CONFLICTING_CURRENT_TIERS' : 'AMBIGUOUS_THRESHOLD',
      };
    }
  }

  const reached = currentTiers
    .filter(
      ({ definition }) =>
        compareQuantityTierDecimalValues(definition.identityKey.thresholdQuantity, normalizedQuantity) <= 0,
    )
    .toSorted((left, right) =>
      compareQuantityTierDecimalValues(
        right.definition.identityKey.thresholdQuantity,
        left.definition.identityKey.thresholdQuantity,
      ),
    );
  const [winningTier] = reached;
  return winningTier === undefined
    ? { outcome: 'NO_THRESHOLD_REACHED' }
    : { outcome: 'HIGHEST_REACHED_THRESHOLD', winningTier };
};

/**
 * Pure owner-local selection over an already-resolved exact Price and an
 * already-obtained Tier-set proof. Acquisition failures are explicit inputs so
 * unavailable or unverifiable evidence can never be mistaken for an empty set.
 */
export const selectQuantityTier = (
  request: QuantityTierSelectionRequest,
): Effect.Effect<QuantityTierSelectionResult> => {
  if (request.outcome !== 'TIER_SET_CURRENT') {
    return Effect.succeed(
      failure(request.attempt, acquisitionFailureReasons[request.outcome], request.candidateTierRevisionIds ?? []),
    );
  }

  const { input } = request;
  const { attempt, tierSet } = input;
  const { evaluatedAt, exactPrice, normalizedQuantity, tierSetPriceRef } = attempt;
  const exactPriceDefinition = exactPrice.price.definition;
  const exactPriceRef = exactPriceDefinition.priceRef;
  const canonicalCatalogTarget =
    exactPriceDefinition.identityKey.catalogSelection.packageOption?.optionRef ??
    exactPriceDefinition.identityKey.catalogSelection.variantRef;
  const candidates = candidateRevisionIds(tierSet);

  if (
    !sameResourceRef(tierSetPriceRef, exactPriceRef) ||
    !sameResourceRef(tierSet.priceRef, exactPriceRef) ||
    tierSet.currentTiers.some(({ definition }) => !sameResourceRef(definition.identityKey.priceRef, exactPriceRef))
  ) {
    return Effect.succeed(failure(attempt, 'PRICE_BINDING_MISMATCH', candidates, input));
  }

  if (
    !sameResourceRef(normalizedQuantity.quantityBasis.catalogQuantityBasis.targetRef, canonicalCatalogTarget) ||
    !sameQuantityBasis(normalizedQuantity.quantityBasis, {
      catalogQuantityBasis: normalizedQuantity.quantityBasis.catalogQuantityBasis,
      priceUnitBasis: exactPriceDefinition.identityKey.unitBasis,
    }) ||
    tierSet.currentTiers.some(
      ({ definition }) => !sameQuantityBasis(definition.identityKey.quantityBasis, normalizedQuantity.quantityBasis),
    )
  ) {
    return Effect.succeed(failure(attempt, 'INCOMPATIBLE_QUANTITY_BASIS', candidates, input));
  }

  const priceCurrency = exactPriceDefinition.identityKey.currencyCode;
  if (
    exactPriceDefinition.revision.monetaryAmount.currencyCode !== priceCurrency ||
    tierSet.currentTiers.some(({ definition }) => definition.revision.resultingUnitPrice.currencyCode !== priceCurrency)
  ) {
    return Effect.succeed(failure(attempt, 'CURRENCY_MISMATCH', candidates, input));
  }

  if (
    isCompletenessEvidenceStale(tierSet, evaluatedAt) ||
    tierSet.currentTiers.some((tier) => !isEffectiveAt(tier, evaluatedAt))
  ) {
    return Effect.succeed(failure(attempt, 'STALE_TIER_SET', candidates, input));
  }

  const resolution = resolveHighestReachedQuantityTier(normalizedQuantity.quantity, tierSet.currentTiers);
  if ('candidateRevisionIds' in resolution) {
    return Effect.succeed(failure(attempt, resolution.outcome, resolution.candidateRevisionIds, input));
  }

  if (resolution.outcome === 'NO_THRESHOLD_REACHED') {
    return Effect.succeed({
      appliesToQuantity: normalizedQuantity,
      evidence: { decision: { kind: 'NO_THRESHOLD_REACHED' }, input },
      monetaryBoundary: 'PRE_TAX',
      outcome: 'BASE_PRICE_RETAINED',
      resultingUnitPrice: exactPriceDefinition.revision.monetaryAmount,
    });
  }

  return Effect.succeed({
    appliesToQuantity: normalizedQuantity,
    evidence: {
      decision: { kind: 'HIGHEST_REACHED_THRESHOLD', winningTier: resolution.winningTier },
      input,
    },
    monetaryBoundary: 'PRE_TAX',
    outcome: 'QUANTITY_TIER_APPLIED',
    resultingUnitPrice: resolution.winningTier.definition.revision.resultingUnitPrice,
  });
};
