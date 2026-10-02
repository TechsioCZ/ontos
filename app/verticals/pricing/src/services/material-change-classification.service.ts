import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { PricingMaterialChangeClassificationSchema } from '@app/pricing-contracts/domain/material-change';
import type {
  PricingMaterialBinding,
  PricingMaterialBindingKind,
  PricingMaterialChangeAssessmentRequest,
  PricingMaterialChangeClassification,
  PricingMaterialChangeReason,
  PricingMaterialOwnerTransitionEvidence,
  PricingMaterialStateSnapshot,
} from '@app/pricing-contracts/domain/material-change';
import { PricingMaterialCalculationVersionsSchema } from '@app/pricing-contracts/domain/material-evidence';
import {
  PricingSourceEvidenceConflictSchema,
  PricingSourceEvidenceMissingSchema,
  PricingSourceEvidenceResultSchema,
  PricingSourceEvidenceUnverifiableSchema,
  PricingSourceEvidenceVerifiedAbsentSchema,
  PricingSourceEvidenceVerifiedPresentSchema,
} from '@app/pricing-contracts/domain/source-revision-evidence';
import type { PricingSourceEvidenceResult } from '@app/pricing-contracts/domain/source-revision-evidence';
import { Schema } from 'effect';

const sameCatalogSelection = Schema.toEquivalence(CatalogSelectionSchema);
const sameCalculationVersions = Schema.toEquivalence(PricingMaterialCalculationVersionsSchema);
const sameSourceEvidence = Schema.toEquivalence(PricingSourceEvidenceResultSchema);

const reasonByBindingKind = {
  AUDIENCE_OR_GROUP: 'AUDIENCE_OR_GROUP_CHANGED',
  CALCULATION_CONTRACT: 'CALCULATION_CONTRACT_CHANGED',
  CATALOG_SELECTION: 'CATALOG_SELECTION_CHANGED',
  COMMERCIAL_FEE_SET: 'COMMERCIAL_FEE_SET_CHANGED',
  COMMERCIAL_SCOPE: 'COMMERCIAL_SCOPE_CHANGED',
  CURRENCY_SUPPORT: 'CURRENCY_SUPPORT_CHANGED',
  DISCOUNT_SET: 'DISCOUNT_SET_CHANGED',
  EXACT_PRICE_SET: 'EXACT_PRICE_KEY_OR_SET_CHANGED',
  PACKAGE_CONFIGURATION_OR_SET: 'PACKAGE_CONFIGURATION_OR_SET_CHANGED',
  PRICE_SCHEDULE: 'PRICE_SCHEDULE_BOUNDARY_CROSSED',
  PROMOTION_OR_ALLOCATION: 'PROMOTION_OR_ALLOCATION_CHANGED',
  PURCHASE_OCCURRENCES: 'PURCHASE_OCCURRENCES_CHANGED',
  QUANTITY_AND_UNIT: 'QUANTITY_OR_UNIT_CHANGED',
  QUANTITY_TIER_SET: 'QUANTITY_TIER_SET_CHANGED',
  ROUNDING_CONTRACT: 'ROUNDING_CONTRACT_CHANGED',
  SUBJECT_OR_GUEST: 'SUBJECT_OR_GUEST_CHANGED',
  WHOLE_PURCHASE_BASIS_OR_ALLOCATION: 'WHOLE_PURCHASE_BASIS_OR_ALLOCATION_CHANGED',
  ZERO_FLOOR_SCOPE_OR_COVERAGE: 'ZERO_FLOOR_SCOPE_OR_COVERAGE_CHANGED',
} as const satisfies Readonly<Record<PricingMaterialBindingKind, PricingMaterialChangeReason>>;

const sameResourceReference = (
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

const addWhen = (reasons: Set<PricingMaterialChangeReason>, changed: boolean, reason: PricingMaterialChangeReason) => {
  if (changed) {
    reasons.add(reason);
  }
};

const classifyDecision = (
  previous: PricingMaterialStateSnapshot,
  current: PricingMaterialStateSnapshot,
  reasons: Set<PricingMaterialChangeReason>,
): void => {
  const left = previous.decision;
  const right = current.decision;

  addWhen(
    reasons,
    left.lines.length !== right.lines.length ||
      left.lines.some(({ occurrenceId }, index) => right.lines[index]?.occurrenceId !== occurrenceId),
    'PURCHASE_OCCURRENCES_CHANGED',
  );
  addWhen(
    reasons,
    left.commercialScope.sellingLegalEntityId !== right.commercialScope.sellingLegalEntityId ||
      left.commercialScope.channelId !== right.commercialScope.channelId ||
      left.commercialScope.marketId !== right.commercialScope.marketId,
    'COMMERCIAL_SCOPE_CHANGED',
  );
  addWhen(
    reasons,
    left.tenantId !== right.tenantId ||
      left.purchasingContext.contextRef !== right.purchasingContext.contextRef ||
      left.purchasingContext.contextRevision !== right.purchasingContext.contextRevision,
    'SUBJECT_OR_GUEST_CHANGED',
  );
  addWhen(
    reasons,
    left.currencyCode !== right.currencyCode || left.monetaryBoundary !== right.monetaryBoundary,
    'CURRENCY_OR_BASIS_CHANGED',
  );

  for (const [index, leftLine] of left.lines.entries()) {
    const rightLine = right.lines[index];
    if (rightLine === undefined || rightLine.occurrenceId !== leftLine.occurrenceId) {
      continue;
    }
    const sameProductAndVariant =
      sameResourceReference(leftLine.catalog.selection.productRef, rightLine.catalog.selection.productRef) &&
      sameResourceReference(leftLine.catalog.selection.variantRef, rightLine.catalog.selection.variantRef);
    addWhen(reasons, !sameProductAndVariant, 'CATALOG_SELECTION_CHANGED');
    addWhen(
      reasons,
      sameProductAndVariant && !sameCatalogSelection(leftLine.catalog.selection, rightLine.catalog.selection),
      'PACKAGE_CONFIGURATION_OR_SET_CHANGED',
    );
    addWhen(
      reasons,
      leftLine.catalog.quantity.requested !== rightLine.catalog.quantity.requested ||
        leftLine.catalog.quantity.resulting !== rightLine.catalog.quantity.resulting ||
        !sameResourceReference(leftLine.catalog.unitRef, rightLine.catalog.unitRef),
      'QUANTITY_OR_UNIT_CHANGED',
    );
    addWhen(
      reasons,
      leftLine.pricingBasis.quantity !== rightLine.pricingBasis.quantity ||
        !sameResourceReference(leftLine.pricingBasis.unitRef, rightLine.pricingBasis.unitRef),
      'CURRENCY_OR_BASIS_CHANGED',
    );
  }
};

const classifyCalculationVersions = (
  previous: PricingMaterialStateSnapshot,
  current: PricingMaterialStateSnapshot,
  reasons: Set<PricingMaterialChangeReason>,
): void => {
  if (sameCalculationVersions(previous.calculationVersions, current.calculationVersions)) {
    return;
  }
  addWhen(
    reasons,
    previous.calculationVersions.arithmeticProfileVersions.join('\u0000') !==
      current.calculationVersions.arithmeticProfileVersions.join('\u0000'),
    'CALCULATION_CONTRACT_CHANGED',
  );
  addWhen(
    reasons,
    previous.calculationVersions.publicationProfileVersions.join('\u0000') !==
      current.calculationVersions.publicationProfileVersions.join('\u0000'),
    'ROUNDING_CONTRACT_CHANGED',
  );
  addWhen(
    reasons,
    previous.calculationVersions.allocationContractVersions.join('\u0000') !==
      current.calculationVersions.allocationContractVersions.join('\u0000'),
    'WHOLE_PURCHASE_BASIS_OR_ALLOCATION_CHANGED',
  );
};

const sourceBoundary = (source: PricingSourceEvidenceResult): string | undefined =>
  Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(source) ||
  Schema.is(PricingSourceEvidenceVerifiedAbsentSchema)(source) ||
  Schema.is(PricingSourceEvidenceConflictSchema)(source)
    ? source.completeness.temporal.nextMaterialBoundary
    : undefined;

const sourceOutcomesMatch = (previous: PricingSourceEvidenceResult, current: PricingSourceEvidenceResult): boolean =>
  (Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(previous) &&
    Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(current)) ||
  (Schema.is(PricingSourceEvidenceVerifiedAbsentSchema)(previous) &&
    Schema.is(PricingSourceEvidenceVerifiedAbsentSchema)(current));

const sameVerifiedTransitionEvidence = (
  transition: PricingMaterialOwnerTransitionEvidence,
  previous: PricingMaterialBinding,
  current: PricingMaterialBinding,
): boolean =>
  transition.bindingRef === current.bindingRef &&
  sourceOutcomesMatch(previous.sourceEvidence, current.sourceEvidence) &&
  transition.previousSnapshotId !== transition.currentSnapshotId &&
  transition.previousSnapshotId.length > 0 &&
  transition.currentSnapshotId.length > 0 &&
  sameSourceEvidence(transition.previousEvidence, previous.sourceEvidence) &&
  sameSourceEvidence(transition.currentEvidence, current.sourceEvidence) &&
  transition.family === current.sourceEvidence.request.family;

const matchingOwnerTransition = (
  request: PricingMaterialChangeAssessmentRequest,
  previous: PricingMaterialBinding,
  current: PricingMaterialBinding,
): PricingMaterialOwnerTransitionEvidence | undefined =>
  request.ownerTransitions.find(
    (transition) =>
      transition.previousSnapshotId === request.previous.snapshotId &&
      transition.currentSnapshotId === request.current.snapshotId &&
      sameVerifiedTransitionEvidence(transition, previous, current),
  );

const currentSourceIsUnverifiable = (source: PricingSourceEvidenceResult): boolean =>
  Schema.is(PricingSourceEvidenceMissingSchema)(source) || Schema.is(PricingSourceEvidenceUnverifiableSchema)(source);

const bindingChanged = (previous: PricingMaterialBinding, current: PricingMaterialBinding): boolean =>
  previous.kind !== current.kind ||
  previous.meaningRef !== current.meaningRef ||
  !sameSourceEvidence(previous.sourceEvidence, current.sourceEvidence);

const scheduledBoundaryCrossed = (previous: PricingMaterialBinding, current: PricingMaterialStateSnapshot): boolean => {
  const boundary = sourceBoundary(previous.sourceEvidence);
  return boundary !== undefined && current.decision.operationTime >= boundary;
};

interface BindingClassification {
  readonly transitions: readonly PricingMaterialOwnerTransitionEvidence[];
  readonly unverifiable: readonly string[];
}

type BindingPairClassification =
  | { readonly kind: 'MATERIAL'; readonly reason: PricingMaterialChangeReason }
  | { readonly kind: 'TRANSITION'; readonly transition: PricingMaterialOwnerTransitionEvidence }
  | { readonly kind: 'UNCHANGED' }
  | { readonly kind: 'UNVERIFIABLE'; readonly reason: string };

const classifyBindingPair = (
  request: PricingMaterialChangeAssessmentRequest,
  previous: PricingMaterialBinding,
  current: PricingMaterialBinding,
): BindingPairClassification => {
  if (currentSourceIsUnverifiable(current.sourceEvidence)) {
    return { kind: 'UNVERIFIABLE', reason: `Current owner state is not verifiable for binding ${current.bindingRef}` };
  }
  if (Schema.is(PricingSourceEvidenceConflictSchema)(current.sourceEvidence)) {
    return { kind: 'MATERIAL', reason: reasonByBindingKind[current.kind] };
  }
  if (scheduledBoundaryCrossed(previous, request.current)) {
    return {
      kind: 'MATERIAL',
      reason:
        previous.kind === 'PRICE_SCHEDULE' || previous.sourceEvidence.request.family === 'PRICE'
          ? 'PRICE_SCHEDULE_BOUNDARY_CROSSED'
          : reasonByBindingKind[previous.kind],
    };
  }
  if (!bindingChanged(previous, current)) {
    return { kind: 'UNCHANGED' };
  }
  const transition = matchingOwnerTransition(request, previous, current);
  return transition === undefined
    ? {
        kind: 'MATERIAL',
        reason: previous.kind === current.kind ? reasonByBindingKind[current.kind] : reasonByBindingKind[previous.kind],
      }
    : { kind: 'TRANSITION', transition };
};

const classifyBindings = (
  request: PricingMaterialChangeAssessmentRequest,
  reasons: Set<PricingMaterialChangeReason>,
): BindingClassification => {
  const currentByRef = new Map(request.current.materialBindings.map((binding) => [binding.bindingRef, binding]));
  const transitions: PricingMaterialOwnerTransitionEvidence[] = [];
  const unverifiable: string[] = [];

  for (const previous of request.previous.materialBindings) {
    const current = currentByRef.get(previous.bindingRef);
    if (current === undefined) {
      reasons.add(reasonByBindingKind[previous.kind]);
    } else {
      currentByRef.delete(previous.bindingRef);
      const classification = classifyBindingPair(request, previous, current);
      if (classification.kind === 'MATERIAL') {
        reasons.add(classification.reason);
      } else if (classification.kind === 'TRANSITION') {
        transitions.push(classification.transition);
      } else if (classification.kind === 'UNVERIFIABLE') {
        unverifiable.push(classification.reason);
      }
    }
  }

  for (const current of currentByRef.values()) {
    if (currentSourceIsUnverifiable(current.sourceEvidence)) {
      unverifiable.push(`Current owner state is not verifiable for binding ${current.bindingRef}`);
    } else {
      reasons.add(reasonByBindingKind[current.kind]);
    }
  }
  return { transitions, unverifiable };
};

const observationsChanged = (
  previous: PricingMaterialStateSnapshot,
  current: PricingMaterialStateSnapshot,
): boolean => {
  const left = previous.nonMaterialObservations ?? [];
  const right = current.nonMaterialObservations ?? [];
  return (
    left.length !== right.length ||
    left.some((observation, index) => {
      const compared = right[index];
      return (
        compared === undefined ||
        observation.kind !== compared.kind ||
        observation.observationRef !== compared.observationRef
      );
    })
  );
};

/**
 * Compares two coherent #786 proof snapshots. Only exact Pricing state or an exact owner-bound
 * transition can remain non-material; amount equality, Revision IDs, TTL, and event silence are
 * never consulted. Storefront and Tax observations remain explicitly outside monetary selection.
 */
export const classifyPricingMaterialChange = (
  request: PricingMaterialChangeAssessmentRequest,
): PricingMaterialChangeClassification => {
  const reasons = new Set<PricingMaterialChangeReason>();
  classifyDecision(request.previous, request.current, reasons);
  classifyCalculationVersions(request.previous, request.current, reasons);
  const bindingClassification = classifyBindings(request, reasons);

  let result: PricingMaterialChangeClassification;
  if (bindingClassification.unverifiable.length > 0) {
    result = {
      _tag: 'UNVERIFIABLE',
      currentSnapshotId: request.current.snapshotId,
      previousSnapshotId: request.previous.snapshotId,
      reasons: bindingClassification.unverifiable,
    };
  } else if (reasons.size > 0) {
    result = {
      _tag: 'MATERIAL_CHANGED',
      currentSnapshotId: request.current.snapshotId,
      previousSnapshotId: request.previous.snapshotId,
      reasons: [...reasons].toSorted(),
    };
  } else if (bindingClassification.transitions.length > 0) {
    result = {
      _tag: 'OWNER_CONFIRMED_NON_MATERIAL',
      currentSnapshotId: request.current.snapshotId,
      previousSnapshotId: request.previous.snapshotId,
      transitions: bindingClassification.transitions,
    };
  } else {
    result = {
      _tag: 'NON_MATERIAL',
      currentSnapshotId: request.current.snapshotId,
      previousSnapshotId: request.previous.snapshotId,
      reason: observationsChanged(request.previous, request.current)
        ? 'STOREFRONT_OR_TAX_ONLY'
        : 'EXACT_MATERIAL_STATE',
    };
  }
  return Schema.is(PricingMaterialChangeClassificationSchema)(result)
    ? result
    : {
        _tag: 'UNVERIFIABLE',
        currentSnapshotId: request.current.snapshotId,
        previousSnapshotId: request.previous.snapshotId,
        reasons: ['Material-change classification could not be proven'],
      };
};
