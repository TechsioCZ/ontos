import type { PricingUnitPriceCalculationAttempt } from '@app/pricing-contracts/domain/unit-price-calculation';
import { PricingUnitPriceCalculationAttemptSchema } from '@app/pricing-contracts/domain/unit-price-calculation';
import type { PricingQuantityBasisAssessment } from '@app/pricing-contracts/domain/quantity-unit-package-basis';
import {
  PricingQuantityBasisAssessmentInputSchema,
  PricingQuantityBasisAssessmentSchema,
} from '@app/pricing-contracts/domain/quantity-unit-package-basis';
import {
  QuantityTierSelectionInputSchema,
  QuantityTierSelectionResultSchema,
} from '@app/pricing-contracts/domain/quantity-tier';
import { Effect, Schema } from 'effect';

import { assessPricingQuantityBasis } from '../../../src/services/quantity-unit-package-basis.service.ts';
import { selectQuantityTier } from '../../../src/services/quantity-tier-selection.service.ts';

export const UnitPriceTierStateSchema = Schema.Literals(['CURRENT', 'INCOMPLETE', 'UNAVAILABLE', 'UNVERIFIABLE']);
export type UnitPriceTierState = typeof UnitPriceTierStateSchema.Type;

export interface UnitPriceCalculationFixtureOptions {
  readonly currencyCode?: 'CZK' | 'EUR';
  readonly groupPath?: boolean;
  readonly historicalCurrencySupport?: boolean;
  readonly occurrenceId?: string;
  readonly priceAmount?: string;
  readonly quantity?: string;
  readonly staleTierSet?: boolean;
  readonly tiers?: readonly {
    readonly amount: string;
    readonly revisionId: string;
    readonly thresholdQuantity: string;
  }[];
  readonly tierState?: UnitPriceTierState;
}

export const unitPriceFixtureTenantId = '11111111-1111-4111-8111-111111111111';
export const unitPriceFixtureEffectiveAt = '2026-09-28T12:00:00.000Z';

const tenantId = unitPriceFixtureTenantId;
const effectiveAt = unitPriceFixtureEffectiveAt;
const observedAt = '2026-09-28T12:00:00.050Z';
const revalidatedAt = '2026-09-28T12:00:00.100Z';
const catalogObservedAt = effectiveAt;
const tierObservedAt = '2026-09-28T12:00:00.100Z';
const effectiveFrom = '2026-09-01T00:00:00.000Z';
const nextBoundary = '2026-10-01T00:00:00.000Z';
const catalogModuleId = 'commerce.catalog' as const;
const productUnitResourceType = 'commerce.catalog.product-unit';
const pricingModuleId = 'commerce.pricing';

const catalogRef = <const ResourceType extends string>(resourceType: ResourceType, resourceId: string) => ({
  moduleId: catalogModuleId,
  resourceId,
  resourceType,
  tenantId,
});

export const unitPriceFixtureProductRef = catalogRef(
  'commerce.catalog.product',
  '22222222-2222-4222-8222-222222222222',
);
export const unitPriceFixtureVariantRef = catalogRef(
  'commerce.catalog.variant',
  '33333333-3333-4333-8333-333333333333',
);
export const unitPriceFixtureUnitRef = catalogRef(productUnitResourceType, '44444444-4444-4444-8444-444444444444');
export const unitPriceFixturePriceRef = {
  moduleId: pricingModuleId,
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'commerce.pricing.price' as const,
  tenantId,
};
export const unitPriceFixturePriceGroupRef = {
  moduleId: 'pricing.price-group-catalog' as const,
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'pricing.price-group-catalog.price-group' as const,
  tenantId,
};

const catalogSelection = {
  productRef: unitPriceFixtureProductRef,
  variantRef: unitPriceFixtureVariantRef,
};
const catalogQuantityBasis = {
  targetDivisibilityRevision: 3,
  targetRef: unitPriceFixtureVariantRef,
  unitRef: unitPriceFixtureUnitRef,
  unitRuleRevision: 7,
};

const catalogOwnerRevision = 'catalog-quantity:778';

const makeCatalogHandoff = (quantity: string, predicateRef: string) => ({
  completeness: {
    nextApplicabilityBoundary: nextBoundary,
    observedAt: catalogObservedAt,
    ownerRevision: catalogOwnerRevision,
    scope: { kind: 'EXACT_PREDICATE' as const, predicateRef },
  },
  divisible: true,
  equivalentSelectionKey: `pricing-purpose:${unitPriceFixtureVariantRef.resourceId}`,
  evidence: {
    assessedAt: catalogObservedAt,
    basis: [
      { role: 'PRODUCT' as const, source: { resourceRef: unitPriceFixtureProductRef, revision: 1 } },
      { role: 'VARIANT' as const, source: { resourceRef: unitPriceFixtureVariantRef, revision: 2 } },
      {
        provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' as const,
        role: 'PRODUCT_TYPE_UNTYPED_DECISION' as const,
        source: { resourceRef: unitPriceFixtureProductRef, revision: 1 },
      },
    ],
    membership: {
      attestationId: '77777777-7777-4777-8777-777777777777',
      observedAt: catalogObservedAt,
      productRef: unitPriceFixtureProductRef,
      source: 'CATALOG_OWNER_CURRENT_READ' as const,
      variant: { resourceRef: unitPriceFixtureVariantRef, revision: 2 },
    },
    purpose: 'PRICING' as const,
    selection: catalogSelection,
    status: 'VALID' as const,
    validUntil: nextBoundary,
  },
  hierarchyRevision: 'catalog-hierarchy:778',
  ownerRevision: catalogOwnerRevision,
  quantity: {
    changed: false,
    notice: null,
    requested: quantity,
    resulting: quantity,
    rounding: 'HALF_UP' as const,
    status: 'VALID' as const,
    step: '0.000000001',
    targetId: unitPriceFixtureVariantRef.resourceId,
    tenantId,
    unitId: unitPriceFixtureUnitRef.resourceId,
    unitRuleRevision: 7,
  },
  quantityBasis: catalogQuantityBasis,
  selection: catalogSelection,
  status: 'READY' as const,
  unitRef: unitPriceFixtureUnitRef,
});

const supportRootId = '88888888-8888-4888-8888-888888888888';
const supportRevisionId = '99999999-9999-4999-8999-999999999999';
const supportRootRef = {
  moduleId: pricingModuleId,
  resourceId: supportRootId,
  resourceType: 'commerce.pricing.currency-support' as const,
  tenantId,
};
const supportRevisionRef = {
  moduleId: pricingModuleId,
  resourceId: supportRevisionId,
  resourceType: 'commerce.pricing.currency-support-revision' as const,
  supportRootId,
  tenantId,
};

const makeCurrencySupport = (currencyCode: 'CZK' | 'EUR', historical: boolean) => {
  const verificationRef = [
    'commerce.pricing.currency-support-proof',
    tenantId,
    supportRootId,
    supportRevisionId,
    currencyCode,
    effectiveAt,
    observedAt,
  ].join(':');
  return {
    completenessEvidence: {
      nextApplicabilityBoundary: nextBoundary,
      observedAt,
      ownerRevision: supportRevisionId,
      scope: {
        kind: 'EXACT_PREDICATE' as const,
        predicateRef: `commerce.pricing.current-supported-currencies:${tenantId}`,
      },
    },
    currentnessEvidence: historical
      ? {
          evaluatedAt: effectiveAt,
          evaluationMode: 'HISTORICAL_AS_OF' as const,
          observedAt,
          scheduleRevision: 1,
          supportRevisionRef,
          supportRootRef,
        }
      : {
          evaluatedAt: effectiveAt,
          evaluationMode: 'CURRENT_WITH_REVALIDATION' as const,
          observedAt,
          revalidatedAt,
          scheduleRevision: 1,
          supportRevisionRef,
          supportRootRef,
        },
    effectiveAt,
    effectivePeriod: { effectiveFrom, effectiveTo: null },
    factProofs: [
      {
        factRef: supportRootId,
        factRevisionRef: supportRevisionId,
        verificationRef,
      },
    ],
    generation: 1,
    nextApplicabilityBoundary: nextBoundary,
    observedAt,
    outcome: 'SUPPORTED_CURRENCIES_CURRENT' as const,
    pricingRevision: 'pricing-currency-support:778',
    scheduleRevision: 1,
    supportedCurrencies: [currencyCode],
    supportRevisionRef,
    supportRootRef,
    tenantId,
    verificationRef,
  };
};

const acquisitionOutcome = (
  tierState: Exclude<UnitPriceTierState, 'CURRENT'>,
): 'TIER_SET_INCOMPLETE' | 'TIER_SET_UNAVAILABLE' | 'TIER_SET_UNVERIFIABLE' => {
  if (tierState === 'INCOMPLETE') {
    return 'TIER_SET_INCOMPLETE';
  }
  return tierState === 'UNAVAILABLE' ? 'TIER_SET_UNAVAILABLE' : 'TIER_SET_UNVERIFIABLE';
};

const normalizeFixtureOptions = (
  options: UnitPriceCalculationFixtureOptions,
): Required<UnitPriceCalculationFixtureOptions> => ({
  currencyCode: options.currencyCode ?? 'CZK',
  groupPath: options.groupPath ?? false,
  historicalCurrencySupport: options.historicalCurrencySupport ?? false,
  occurrenceId: options.occurrenceId ?? 'line-778-a',
  priceAmount: options.priceAmount ?? '120',
  quantity: options.quantity ?? '2.54',
  staleTierSet: options.staleTierSet ?? false,
  tiers: options.tiers ?? [],
  tierState: options.tierState ?? 'CURRENT',
});

const makeAttempt = (options: UnitPriceCalculationFixtureOptions) =>
  Effect.gen(function* makeUnitPriceAttempt() {
    const normalizedOptions = normalizeFixtureOptions(options);
    const { currencyCode, groupPath, occurrenceId, quantity } = normalizedOptions;
    const priceGroupSelector = groupPath
      ? ({ kind: 'PRICE_GROUP', priceGroupRef: unitPriceFixturePriceGroupRef } as const)
      : ({ kind: 'NO_GROUP' } as const);
    const priceUnitBasis = { quantity: '1', unitRef: unitPriceFixtureUnitRef };
    const quantityBasis = { catalogQuantityBasis, priceUnitBasis };
    const identityKey = {
      catalogSelection,
      commercialScope: {
        channelId: 'B2C' as const,
        marketId: 'cz-launch',
        sellingLegalEntityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
      currencyCode,
      priceGroupSelector,
      unitBasis: priceUnitBasis,
    };
    const priceRevision = {
      effectiveFrom,
      monetaryAmount: { amount: normalizedOptions.priceAmount, currencyCode },
      monetaryBoundary: 'PRE_TAX' as const,
      revision: 1,
      revisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    };
    const priceDefinition = { identityKey, priceRef: unitPriceFixturePriceRef, revision: priceRevision };
    const scheduledPrice = {
      definition: priceDefinition,
      effectivePeriod: { effectiveFrom, effectiveTo: null },
      lineage: { correctedRevisionId: null, kind: 'INITIAL' as const, previousRevisionId: null },
    };
    const scheduledTiers = normalizedOptions.tiers.map((tier) => ({
      definition: {
        identityKey: { priceRef: unitPriceFixturePriceRef, quantityBasis, thresholdQuantity: tier.thresholdQuantity },
        revision: {
          effectiveFrom,
          monetaryBoundary: 'PRE_TAX' as const,
          resultingUnitPrice: { amount: tier.amount, currencyCode },
          revision: 1,
          revisionId: tier.revisionId,
        },
      },
      effectivePeriod: { effectiveFrom, effectiveTo: null },
      lineage: { correctedRevisionId: null, kind: 'INITIAL' as const, previousRevisionId: null },
    }));
    const tierAttempt = {
      evaluatedAt: effectiveAt,
      exactPrice: {
        path: { priceGroupSelector, requiredAbsenceEvidence: [] },
        price: scheduledPrice,
        scheduleRevision: 1,
      },
      normalizedQuantity: { quantity, quantityBasis },
      tierSetPriceRef: unitPriceFixturePriceRef,
    };
    const tierInput = yield* Schema.decodeUnknownEffect(QuantityTierSelectionInputSchema)({
      attempt: tierAttempt,
      tierSet: {
        authority: {
          generation: 778,
          observedAt: normalizedOptions.staleTierSet ? '2026-09-28T11:59:59.000Z' : tierObservedAt,
          ownerRevision: 'pricing-quantity-tier-set:778',
          ownerRootRef: `commerce.pricing.quantity-tier-set:${unitPriceFixturePriceRef.resourceId}`,
          predicateRef: `commerce.pricing.current-quantity-tiers:${unitPriceFixturePriceRef.resourceId}`,
          verificationRef: 'commerce.pricing.quantity-tier-set-proof:778',
        },
        completenessEvidence: {
          nextApplicabilityBoundary: normalizedOptions.staleTierSet ? '2026-09-28T11:59:59.500Z' : nextBoundary,
          observedAt: normalizedOptions.staleTierSet ? '2026-09-28T11:59:59.000Z' : tierObservedAt,
          ownerRevision: 'pricing-quantity-tier-set:778',
          scope: {
            kind: 'EXACT_PREDICATE',
            predicateRef: `commerce.pricing.current-quantity-tiers:${unitPriceFixturePriceRef.resourceId}`,
          },
        },
        currentTiers: scheduledTiers,
        factProofs: scheduledTiers.map(({ definition }, index) => ({
          factRef: `quantity-tier:${index + 1}`,
          factRevisionRef: definition.revision.revisionId,
          verificationRef: 'commerce.pricing.quantity-tier-set-proof:778',
        })),
        priceRef: unitPriceFixturePriceRef,
      },
    });
    const { tierState } = normalizedOptions;
    const tierSelection = yield* tierState === 'CURRENT'
      ? selectQuantityTier({ input: tierInput, outcome: 'TIER_SET_CURRENT' })
      : selectQuantityTier({
          attempt: tierInput.attempt,
          candidateTierRevisionIds: scheduledTiers.map(({ definition }) => definition.revision.revisionId),
          outcome: acquisitionOutcome(tierState),
        });
    const winningTier =
      tierSelection.outcome === 'QUANTITY_TIER_APPLIED' &&
      tierSelection.evidence.decision.kind === 'HIGHEST_REACHED_THRESHOLD'
        ? tierSelection.evidence.decision.winningTier.definition
        : undefined;
    const endpoint = (endpointQuantity: string) => ({
      quantity: endpointQuantity,
      quantityBasis: catalogQuantityBasis,
    });
    const purchaseEndpoint = endpoint(quantity);
    const pricingEndpoint = endpoint('1');
    const endpointsWithoutTier = {
      price: pricingEndpoint,
      purchase: purchaseEndpoint,
      requested: purchaseEndpoint,
    };
    const endpoints =
      winningTier === undefined ? endpointsWithoutTier : { ...endpointsWithoutTier, tier: pricingEndpoint };
    const quantityBasisPredicateWithoutTier = {
      effectiveAt,
      price: pricingEndpoint,
      requestedQuantity: quantity,
      requestedQuantityBasis: catalogQuantityBasis,
      requestedUnitRef: unitPriceFixtureUnitRef,
      selection: catalogSelection,
    };
    const quantityBasisPredicate =
      winningTier === undefined
        ? quantityBasisPredicateWithoutTier
        : { ...quantityBasisPredicateWithoutTier, tier: pricingEndpoint };
    const quantityBasisPredicateRef = [
      'commerce.catalog.quantity-basis-predicate',
      tenantId,
      unitPriceFixtureProductRef.resourceId,
      unitPriceFixtureVariantRef.resourceId,
      quantity,
      catalogQuantityBasis.targetDivisibilityRevision,
      catalogQuantityBasis.targetRef.resourceId,
      catalogQuantityBasis.unitRef.resourceId,
      catalogQuantityBasis.unitRuleRevision,
      effectiveAt,
      unitPriceFixturePriceRef.resourceId,
      priceRevision.revisionId,
      pricingEndpoint.quantity,
      winningTier?.revision.revisionId ?? 'NO_TIER',
      winningTier === undefined ? 'NO_TIER_ENDPOINT' : pricingEndpoint.quantity,
    ].join(':');
    const quantityBasisVerificationRef = `${quantityBasisPredicateRef}:verification:${catalogOwnerRevision}:${catalogObservedAt}`;
    const catalog = makeCatalogHandoff(quantity, quantityBasisPredicateRef);
    const quantityAttemptWithoutTier = { catalog, effectiveAt, occurrenceId, price: priceDefinition };
    const quantityAttempt =
      winningTier === undefined ? quantityAttemptWithoutTier : { ...quantityAttemptWithoutTier, tier: winningTier };
    const quantityAssessmentInput = yield* Schema.decodeUnknownEffect(PricingQuantityBasisAssessmentInputSchema)({
      attempt: quantityAttempt,
      ownerDecision: {
        completeness: catalog.completeness,
        currentness: {
          observedAt: catalogObservedAt,
          ownerRevision: catalog.ownerRevision,
          status: 'CURRENT',
          validUntil: nextBoundary,
        },
        currentnessEvidence: {
          effectiveAt,
          generation: catalogOwnerRevision,
          observedAt: catalogObservedAt,
          predicateRef: quantityBasisPredicateRef,
          revalidatedAt: catalogObservedAt,
          validUntil: nextBoundary,
          verificationMode: 'OWNER_CURRENT_QUANTITY_REVALIDATED',
        },
        effectiveAt,
        endpoints,
        equivalentSelectionKey: catalog.equivalentSelectionKey,
        generation: catalogOwnerRevision,
        hierarchyRevision: catalog.hierarchyRevision,
        observedAt: catalogObservedAt,
        outcome: 'NO_CONVERSION_REQUIRED',
        ownerModuleId: catalogModuleId,
        ownerRevision: catalog.ownerRevision,
        requestedOwnerRevision: catalog.ownerRevision,
        requestedQuantity: quantity,
        requestedQuantityBasis: catalogQuantityBasis,
        requestedUnitRef: unitPriceFixtureUnitRef,
        selection: catalogSelection,
        source: 'CATALOG_OWNER_CURRENT_READ',
        verificationReceipt: {
          generation: catalogOwnerRevision,
          issuedAt: catalogObservedAt,
          ownerModuleId: catalogModuleId,
          ownerRevision: catalog.ownerRevision,
          predicate: quantityBasisPredicate,
          predicateRef: quantityBasisPredicateRef,
          verificationRef: quantityBasisVerificationRef,
        },
      },
    });
    const quantityAssessment: PricingQuantityBasisAssessment =
      yield* assessPricingQuantityBasis(quantityAssessmentInput);
    const basis = {
      catalogSelection,
      commercialScope: identityKey.commercialScope,
      currencyCode,
      unitBasis: priceUnitBasis,
    };
    const priceGroupCompatibility = {
      catalogRevision: 7,
      definitionEffectivePeriod: { effectiveFrom, effectiveTo: null },
      definitionRevisionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      definitionRevisionNumber: 1,
      meaningFingerprint: 'a'.repeat(64),
      priceGroupRef: unitPriceFixturePriceGroupRef,
      requiredContract: { contractId: 'commerce.customer-price-group-assignment.v1', version: 1 },
      trustedOperationAt: effectiveAt,
      verifiedAt: effectiveAt,
    };
    const resolutionInput = groupPath
      ? {
          _tag: 'ASSIGNED' as const,
          effectiveAt,
          interpretation: {
            _tag: 'ASSIGNED' as const,
            assignmentResolution: {
              _tag: 'ASSIGNED' as const,
              assignmentRef: {
                moduleId: 'commerce.customer-context' as const,
                resourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                resourceType: 'commerce.customer-context.customer-price-group-assignment' as const,
                tenantId,
              },
              assignmentRevision: 1,
              compatibility: priceGroupCompatibility,
              effectiveFrom,
              effectiveTo: null,
              priceGroupRef: unitPriceFixturePriceGroupRef,
            },
            basis,
            compatibilityEvidence: priceGroupCompatibility,
            discountAudience: { kind: 'PRICE_GROUP' as const, priceGroupRef: unitPriceFixturePriceGroupRef },
            priceGroupRef: unitPriceFixturePriceGroupRef,
            priceSelector: { kind: 'PRICE_GROUP' as const, priceGroupRef: unitPriceFixturePriceGroupRef },
          },
        }
      : { _tag: 'GUEST' as const, basis, effectiveAt };
    const usedPrice = {
      _tag: 'FOUND' as const,
      evidence: {
        effectiveAt,
        nextApplicabilityBoundary: nextBoundary,
        observedAt,
        ownerRevision: 'pricing-price-set:778',
      },
      priceRef: unitPriceFixturePriceRef,
      priceRevision,
      request: { effectiveAt, exactKey: identityKey },
    };
    const exactPrice = {
      _tag: 'PRICE_FOUND' as const,
      currencySupport: makeCurrencySupport(currencyCode, normalizedOptions.historicalCurrencySupport),
      path: groupPath
        ? {
            _tag: 'GROUP_PRICE' as const,
            discountAudience: { kind: 'PRICE_GROUP' as const, priceGroupRef: unitPriceFixturePriceGroupRef },
            resolutionInput,
            usedPrice,
          }
        : {
            _tag: 'NO_GROUP_GUEST' as const,
            discountAudience: { kind: 'NONE' as const },
            resolutionInput,
            usedPrice,
          },
    };
    const line = {
      catalog,
      occurrenceId,
      pricingBasis: priceUnitBasis,
    };
    return {
      exactPrice,
      line,
      lineQuantity: { quantity, quantityBasis },
      quantityBasis: yield* Schema.encodeEffect(PricingQuantityBasisAssessmentSchema)(quantityAssessment),
      tierSelection: yield* Schema.encodeEffect(QuantityTierSelectionResultSchema)(tierSelection),
    };
  });

export const unitPriceCalculationAttempt = (
  options: UnitPriceCalculationFixtureOptions = {},
): Effect.Effect<PricingUnitPriceCalculationAttempt, Schema.SchemaError> =>
  makeAttempt(options).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PricingUnitPriceCalculationAttemptSchema, { onExcessProperty: 'error' })),
  );
