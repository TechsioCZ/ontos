import { CatalogQuantityBasisSchema } from '@app/catalog/domain/catalog-quantity-handoff';
import type { CatalogResourceRef } from '@app/catalog/domain/catalog-revision-reference';
import { ProductUnitRefSchema } from '@app/catalog/resources/product-unit';
import type { ProductUnitRef } from '@app/catalog/resources/product-unit';
import type {
  PricingCatalogCompatibleConversion,
  PricingCatalogNoConversionRequired,
  PricingCatalogQuantityBasisDecision,
  PricingQuantityBasisAssessment,
  PricingQuantityBasisAssessmentInput,
  PricingQuantityBasisAttempt,
} from '@app/pricing-contracts/domain/quantity-unit-package-basis';
import { priceDecimalValuesEqual } from '@app/pricing-contracts/domain/price-definition';
import { Effect, Match, Schema } from 'effect';

const sameCatalogQuantityBasis = Schema.toEquivalence(CatalogQuantityBasisSchema);

const sameResourceRef = (left: CatalogResourceRef, right: CatalogResourceRef): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const exactCatalogTargetFor = (attempt: PricingQuantityBasisAttempt): CatalogResourceRef =>
  attempt.price.identityKey.catalogSelection.packageOption?.optionRef ??
  attempt.price.identityKey.catalogSelection.variantRef;

const failure = (
  attempt: PricingQuantityBasisAttempt,
  outcome: 'INCOMPATIBLE' | 'INVALID' | 'UNAVAILABLE' | 'UNVERIFIABLE',
  reason: string,
): PricingQuantityBasisAssessment => ({
  attempt,
  outcome,
  reason,
});

const unavailableFailure = (
  attempt: PricingQuantityBasisAttempt,
  reason: string,
  retryable: boolean,
): PricingQuantityBasisAssessment => ({ attempt, outcome: 'UNAVAILABLE', reason, retryable });

const sameCompletenessScope = (
  left: PricingCatalogCompatibleConversion['completeness']['scope'],
  right: PricingQuantityBasisAttempt['catalog']['completeness']['scope'],
): boolean =>
  left.kind === right.kind &&
  left.predicateRef === right.predicateRef &&
  (left.kind === 'EXACT_PREDICATE' ||
    (right.kind === 'SAFELY_BROADER_SCOPE' && left.declaredScopeRef === right.declaredScopeRef));

const ownerEvidenceIsBoundToCatalog = (
  attempt: PricingQuantityBasisAttempt,
  evidence: Exclude<PricingCatalogQuantityBasisDecision, { readonly outcome: 'UNAVAILABLE' }>,
  requireCurrent: boolean,
): boolean =>
  Match.value(evidence).pipe(
    Match.when(
      { selection: Match.defined },
      (ownerEvidence) =>
        attempt.effectiveAt === attempt.catalog.evidence.assessedAt &&
        ownerEvidence.effectiveAt === attempt.effectiveAt &&
        ownerEvidence.requestedOwnerRevision === attempt.catalog.ownerRevision &&
        ownerEvidence.observedAt >= ownerEvidence.effectiveAt &&
        ownerEvidence.hierarchyRevision === attempt.catalog.hierarchyRevision &&
        ownerEvidence.equivalentSelectionKey === attempt.catalog.equivalentSelectionKey &&
        ownerEvidence.currentness.observedAt === ownerEvidence.observedAt &&
        ownerEvidence.currentness.ownerRevision === ownerEvidence.ownerRevision &&
        ownerEvidence.currentness.validUntil === ownerEvidence.completeness.nextApplicabilityBoundary &&
        ownerEvidence.completeness.observedAt === ownerEvidence.observedAt &&
        ownerEvidence.completeness.ownerRevision === ownerEvidence.ownerRevision &&
        (!requireCurrent || ownerEvidence.currentness.status === 'CURRENT') &&
        (ownerEvidence.currentness.validUntil === undefined ||
          ownerEvidence.observedAt < ownerEvidence.currentness.validUntil) &&
        sameCompletenessScope(ownerEvidence.completeness.scope, attempt.catalog.completeness.scope),
    ),
    Match.orElse((leanEvidence) => leanEvidence.effectiveAt === attempt.effectiveAt),
  );

const purchaseEndpointsPreserveCatalogHandoff = (
  attempt: PricingQuantityBasisAttempt,
  evidence: PricingCatalogCompatibleConversion | PricingCatalogNoConversionRequired,
): boolean =>
  priceDecimalValuesEqual(evidence.endpoints.requested.quantity, attempt.catalog.quantity.requested) &&
  priceDecimalValuesEqual(evidence.endpoints.purchase.quantity, attempt.catalog.quantity.resulting) &&
  sameCatalogQuantityBasis(evidence.endpoints.requested.quantityBasis, attempt.catalog.quantityBasis) &&
  sameCatalogQuantityBasis(evidence.endpoints.purchase.quantityBasis, attempt.catalog.quantityBasis);

const priceAndTierEndpointsMatchExactCandidate = (
  attempt: PricingQuantityBasisAttempt,
  evidence: PricingCatalogCompatibleConversion | PricingCatalogNoConversionRequired,
): boolean => {
  const exactTarget = exactCatalogTargetFor(attempt);
  const priceEndpoint = evidence.endpoints.price;
  if (
    !sameResourceRef(priceEndpoint.quantityBasis.targetRef, exactTarget) ||
    !sameResourceRef(priceEndpoint.quantityBasis.unitRef, attempt.price.identityKey.unitBasis.unitRef) ||
    !priceDecimalValuesEqual(priceEndpoint.quantity, attempt.price.identityKey.unitBasis.quantity)
  ) {
    return false;
  }

  const tierEndpoint = evidence.endpoints.tier;
  if (attempt.tier === undefined || tierEndpoint === undefined) {
    return attempt.tier === undefined && tierEndpoint === undefined;
  }

  return (
    sameCatalogQuantityBasis(tierEndpoint.quantityBasis, attempt.tier.identityKey.quantityBasis.catalogQuantityBasis) &&
    sameCatalogQuantityBasis(priceEndpoint.quantityBasis, tierEndpoint.quantityBasis) &&
    priceDecimalValuesEqual(tierEndpoint.quantity, attempt.tier.identityKey.quantityBasis.priceUnitBasis.quantity)
  );
};

const success = (
  attempt: PricingQuantityBasisAttempt,
  evidence: PricingCatalogCompatibleConversion | PricingCatalogNoConversionRequired,
  unitRefs: {
    readonly price: ProductUnitRef;
    readonly purchase: ProductUnitRef;
    readonly requested: ProductUnitRef;
    readonly tier?: ProductUnitRef;
  },
): PricingQuantityBasisAssessment => {
  const tierQuantity = evidence.endpoints.tier;
  const result = {
    attempt,
    occurrenceId: attempt.occurrenceId,
    priceQuantity: {
      amount: evidence.endpoints.price.quantity,
      unitRef: unitRefs.price,
    },
    requestedQuantity: {
      amount: attempt.catalog.quantity.requested,
      unitRef: unitRefs.requested,
    },
    resultingPurchaseQuantity: {
      amount: attempt.catalog.quantity.resulting,
      unitRef: unitRefs.purchase,
    },
    selection: attempt.catalog.selection,
  };
  const quantities =
    tierQuantity === undefined || unitRefs.tier === undefined
      ? result
      : {
          ...result,
          tierQuantity: { amount: tierQuantity.quantity, unitRef: unitRefs.tier },
        };
  return Match.value(evidence).pipe(
    Match.when({ outcome: 'COMPATIBLE_CONVERSION' }, (compatibleEvidence) => ({
      ...quantities,
      evidence: compatibleEvidence,
      outcome: 'COMPATIBLE_CONVERSION' as const,
    })),
    Match.when({ outcome: 'NO_CONVERSION_REQUIRED' }, (noConversionEvidence) => ({
      ...quantities,
      evidence: noConversionEvidence,
      outcome: 'NO_CONVERSION_REQUIRED' as const,
    })),
    Match.exhaustive,
  );
};

const productUnitRefs = (
  evidence: PricingCatalogCompatibleConversion | PricingCatalogNoConversionRequired,
):
  | {
      readonly price: ProductUnitRef;
      readonly purchase: ProductUnitRef;
      readonly requested: ProductUnitRef;
      readonly tier?: ProductUnitRef;
    }
  | undefined => {
  const price = evidence.endpoints.price.quantityBasis.unitRef;
  const purchase = evidence.endpoints.purchase.quantityBasis.unitRef;
  const requested = evidence.endpoints.requested.quantityBasis.unitRef;
  const tier = evidence.endpoints.tier?.quantityBasis.unitRef;
  if (
    !Schema.is(ProductUnitRefSchema)(price) ||
    !Schema.is(ProductUnitRefSchema)(purchase) ||
    !Schema.is(ProductUnitRefSchema)(requested) ||
    (tier !== undefined && !Schema.is(ProductUnitRefSchema)(tier))
  ) {
    return undefined;
  }
  return tier === undefined ? { price, purchase, requested } : { price, purchase, requested, tier };
};

const endpointFor = (
  evidence: PricingCatalogCompatibleConversion,
  role: PricingCatalogCompatibleConversion['mappings'][number]['role'],
) =>
  Match.value(role).pipe(
    Match.when('REQUESTED', () => evidence.endpoints.requested),
    Match.when('PURCHASE', () => evidence.endpoints.purchase),
    Match.when('PRICE', () => evidence.endpoints.price),
    Match.when('TIER', () => evidence.endpoints.tier),
    Match.exhaustive,
  );

const sameRevision = (
  left: PricingCatalogCompatibleConversion['mappings'][number]['physicalUnitRevision'],
  right: PricingCatalogCompatibleConversion['steps'][number]['conversion']['from'],
): boolean => left.revision === right.revision && sameResourceRef(left.resourceRef, right.resourceRef);

const conversionMappingsAreExact = (evidence: PricingCatalogCompatibleConversion): boolean => {
  const mappingsByRole = new Map(evidence.mappings.map((mapping) => [mapping.role, mapping]));
  if (mappingsByRole.size !== evidence.mappings.length) {
    return false;
  }
  return evidence.steps.every(({ conversion, from, to }) => {
    const fromEndpoint = endpointFor(evidence, from);
    const toEndpoint = endpointFor(evidence, to);
    const fromMapping = mappingsByRole.get(from);
    const toMapping = mappingsByRole.get(to);
    return (
      fromEndpoint !== undefined &&
      toEndpoint !== undefined &&
      fromMapping !== undefined &&
      toMapping !== undefined &&
      sameCatalogQuantityBasis(fromMapping.productUnitBasis, fromEndpoint.quantityBasis) &&
      sameCatalogQuantityBasis(toMapping.productUnitBasis, toEndpoint.quantityBasis) &&
      sameRevision(fromMapping.physicalUnitRevision, conversion.from) &&
      sameRevision(toMapping.physicalUnitRevision, conversion.to) &&
      conversion.observedAt === evidence.observedAt &&
      fromMapping.effectiveAt === evidence.effectiveAt &&
      toMapping.effectiveAt === evidence.effectiveAt &&
      fromMapping.observedAt === evidence.observedAt &&
      toMapping.observedAt === evidence.observedAt &&
      fromMapping.ownerRevision === evidence.ownerRevision &&
      toMapping.ownerRevision === evidence.ownerRevision
    );
  });
};

const directPurchaseConversionUsesPreservedQuantity = (
  attempt: PricingQuantityBasisAttempt,
  evidence: PricingCatalogCompatibleConversion,
): boolean =>
  evidence.steps.every(
    ({ from, fromQuantity, to }) =>
      from !== 'PURCHASE' ||
      to !== 'PRICE' ||
      priceDecimalValuesEqual(fromQuantity, attempt.catalog.quantity.resulting),
  );

const assessSuccessfulEvidence = (
  attempt: PricingQuantityBasisAttempt,
  evidence: PricingCatalogCompatibleConversion | PricingCatalogNoConversionRequired,
): Effect.Effect<PricingQuantityBasisAssessment> => {
  if (!ownerEvidenceIsBoundToCatalog(attempt, evidence, true)) {
    return Effect.succeed(
      failure(attempt, 'UNVERIFIABLE', 'CATALOG_QUANTITY_BASIS_EVIDENCE_DOES_NOT_BIND_CURRENT_HANDOFF'),
    );
  }
  if (!purchaseEndpointsPreserveCatalogHandoff(attempt, evidence)) {
    return Effect.succeed(
      failure(attempt, 'UNVERIFIABLE', 'CATALOG_QUANTITY_ENDPOINTS_DO_NOT_PRESERVE_PURCHASE_HANDOFF'),
    );
  }
  if (!priceAndTierEndpointsMatchExactCandidate(attempt, evidence)) {
    return Effect.succeed(
      failure(attempt, 'INCOMPATIBLE', 'CATALOG_QUANTITY_BASIS_DOES_NOT_MATCH_EXACT_PRICE_OR_TIER'),
    );
  }
  if (
    evidence.outcome === 'COMPATIBLE_CONVERSION' &&
    !directPurchaseConversionUsesPreservedQuantity(attempt, evidence)
  ) {
    return Effect.succeed(
      failure(attempt, 'UNVERIFIABLE', 'CATALOG_PURCHASE_TO_PRICE_CONVERSION_DOES_NOT_USE_PRESERVED_QUANTITY'),
    );
  }
  if (evidence.outcome === 'COMPATIBLE_CONVERSION' && !conversionMappingsAreExact(evidence)) {
    return Effect.succeed(
      failure(attempt, 'UNVERIFIABLE', 'CATALOG_PRODUCT_UNIT_TO_PHYSICAL_UNIT_MAPPING_IS_NOT_EXACT'),
    );
  }
  const unitRefs = productUnitRefs(evidence);
  return Effect.succeed(
    unitRefs === undefined
      ? failure(attempt, 'INCOMPATIBLE', 'CATALOG_QUANTITY_ENDPOINT_USES_NON_PRODUCT_UNIT')
      : success(attempt, evidence, unitRefs),
  );
};

/**
 * Converts no facts itself. It validates and projects Catalog-owner evidence into the exact
 * Price/Tier Quantity consumed by #767 and #768 while preserving the original line identity.
 */
export const assessPricingQuantityBasis = (
  input: PricingQuantityBasisAssessmentInput,
): Effect.Effect<PricingQuantityBasisAssessment> =>
  Match.value(input.ownerDecision).pipe(
    Match.when({ outcome: 'UNAVAILABLE' }, (ownerDecision) =>
      Effect.succeed(unavailableFailure(input.attempt, ownerDecision.reason, ownerDecision.retryable)),
    ),
    Match.when({ selection: Match.defined }, (ownerDecision) => {
      if (!ownerEvidenceIsBoundToCatalog(input.attempt, ownerDecision, false)) {
        return Effect.succeed(
          failure(input.attempt, 'UNVERIFIABLE', 'CATALOG_QUANTITY_BASIS_EVIDENCE_DOES_NOT_BIND_CURRENT_HANDOFF'),
        );
      }
      if (ownerDecision.outcome === 'INCOMPATIBLE') {
        return Effect.succeed(failure(input.attempt, 'INCOMPATIBLE', ownerDecision.reason));
      }
      if (ownerDecision.outcome === 'UNVERIFIABLE') {
        return Effect.succeed(failure(input.attempt, 'UNVERIFIABLE', ownerDecision.reason));
      }
      return assessSuccessfulEvidence(input.attempt, ownerDecision);
    }),
    Match.orElse((ownerDecision) =>
      Effect.succeed(failure(input.attempt, ownerDecision.outcome, ownerDecision.reason)),
    ),
  );
