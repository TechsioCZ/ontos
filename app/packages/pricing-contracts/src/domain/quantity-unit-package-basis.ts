import { CatalogQuantityBasisSchema } from '@app/catalog/domain/catalog-quantity-handoff';
import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { catalogUnitConversionProves } from '@app/catalog/domain/catalog-unit-conversion-evidence';
import {
  CatalogQuantityBasisCompatibleConversionSchema,
  CatalogQuantityBasisConversionStepSchema,
  CatalogQuantityBasisIncompatibleSchema,
  CatalogQuantityBasisInvalidSchema,
  CatalogQuantityBasisNoConversionRequiredSchema,
  CatalogQuantityBasisUnavailableSchema,
  CatalogQuantityBasisUnverifiableSchema,
} from '@app/catalog/api/quantity-basis-compatibility';
import type {
  CatalogQuantityBasisCompatibilityEndpoint,
  CatalogQuantityBasisCompatibilityEndpoints,
  CatalogQuantityBasisEndpointRoleSchema,
} from '@app/catalog/api/quantity-basis-compatibility';
import { Match, Schema } from 'effect';

import { PricingInstantSchema } from '../apis/current-supported-currencies.ts';
import { PriceDefinitionSchema, priceDecimalValuesEqual } from './price-definition.ts';
import {
  PricingCatalogQuantityHandoffSchema,
  PricingPurchaseDemandOccurrenceIdSchema,
  PricingQuantitySchema,
} from './pricing-decision.ts';
import { QuantityTierDefinitionSchema } from './quantity-tier.ts';

const reason = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());
const leanFailureOutcomeNoun = {
  INVALID: 'invalidity',
  UNAVAILABLE: 'unavailability',
  UNVERIFIABLE: 'unverifiability',
} as const;
const sameCatalogSelection = Schema.toEquivalence(CatalogSelectionSchema);
const sameCatalogQuantityBasis = Schema.toEquivalence(CatalogQuantityBasisSchema);

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

export type PricingCatalogQuantityBasisEndpoint = CatalogQuantityBasisCompatibilityEndpoint;
export type PricingCatalogQuantityBasisEndpoints = CatalogQuantityBasisCompatibilityEndpoints;
export type PricingCatalogQuantityBasisEndpointRole = typeof CatalogQuantityBasisEndpointRoleSchema.Type;

/** One owner-issued exact arithmetic step; no inferred label/SKU/JSON conversion is representable. */
export const PricingCatalogQuantityBasisConversionStepSchema = CatalogQuantityBasisConversionStepSchema.check(
  Schema.makeFilter(({ conversion, from, fromQuantity, to, toQuantity }) => {
    if (from === to) {
      return 'Quantity conversion must relate distinct basis roles';
    }
    return catalogUnitConversionProves(conversion, conversion.from, conversion.to, fromQuantity, toQuantity)
      ? undefined
      : 'Quantity conversion arithmetic must be exactly proven by the owner-issued Unit revisions and ratio';
  }),
);
export type PricingCatalogQuantityBasisConversionStep = typeof PricingCatalogQuantityBasisConversionStepSchema.Type;

const endpointFor = (
  endpoints: PricingCatalogQuantityBasisEndpoints,
  role: PricingCatalogQuantityBasisEndpointRole,
): PricingCatalogQuantityBasisEndpoint | undefined =>
  Match.value(role).pipe(
    Match.when('REQUESTED', () => endpoints.requested),
    Match.when('PURCHASE', () => endpoints.purchase),
    Match.when('PRICE', () => endpoints.price),
    Match.when('TIER', () => endpoints.tier),
    Match.exhaustive,
  );

export const PricingCatalogNoConversionRequiredSchema = CatalogQuantityBasisNoConversionRequiredSchema.check(
  Schema.makeFilter(({ endpoints }) => {
    const candidates = [endpoints.requested, endpoints.purchase, endpoints.price, endpoints.tier].filter(
      (endpoint): endpoint is PricingCatalogQuantityBasisEndpoint => endpoint !== undefined,
    );
    const [first, ...rest] = candidates;
    return first !== undefined &&
      rest.every((endpoint) => sameCatalogQuantityBasis(first.quantityBasis, endpoint.quantityBasis))
      ? undefined
      : 'No-conversion evidence requires one exact Product Unit, owner rule revision, and target basis';
  }),
);
export type PricingCatalogNoConversionRequired = typeof PricingCatalogNoConversionRequiredSchema.Type;

export const PricingCatalogCompatibleConversionSchema = CatalogQuantityBasisCompatibleConversionSchema.check(
  Schema.makeFilter(({ endpoints, observedAt, steps }) =>
    steps.every(({ conversion, from, fromQuantity, to, toQuantity }) => {
      const fromEndpoint = endpointFor(endpoints, from);
      const toEndpoint = endpointFor(endpoints, to);
      return (
        fromEndpoint !== undefined &&
        toEndpoint !== undefined &&
        conversion.observedAt === observedAt &&
        fromEndpoint.quantityBasis.unitRef.tenantId === conversion.from.resourceRef.tenantId &&
        toEndpoint.quantityBasis.unitRef.tenantId === conversion.to.resourceRef.tenantId &&
        catalogUnitConversionProves(conversion, conversion.from, conversion.to, fromQuantity, toQuantity)
      );
    })
      ? undefined
      : 'Every conversion step must bind exact declared endpoints, quantities, revisions, and observation time',
  ),
  Schema.makeFilter(({ endpoints, steps }) => {
    const directlyConvertsPurchaseToPrice = steps.some(({ from, to }) => from === 'PURCHASE' && to === 'PRICE');
    const samePurchaseAndPriceUnit = sameCatalogQuantityBasis(
      endpoints.purchase.quantityBasis,
      endpoints.price.quantityBasis,
    );
    return directlyConvertsPurchaseToPrice || samePurchaseAndPriceUnit
      ? undefined
      : 'Compatible evidence must explicitly relate the resulting purchase Unit to the Price Unit';
  }),
  Schema.makeFilter(({ endpoints, steps }) =>
    steps.every(
      ({ from, fromQuantity, to }) =>
        from !== 'PURCHASE' || to !== 'PRICE' || priceDecimalValuesEqual(fromQuantity, endpoints.purchase.quantity),
    )
      ? undefined
      : 'Direct purchase-to-Price conversion must start from the exact resulting purchase quantity',
  ),
);
export type PricingCatalogCompatibleConversion = typeof PricingCatalogCompatibleConversionSchema.Type;

export const PricingCatalogQuantityBasisDecisionSchema = Schema.Union([
  PricingCatalogNoConversionRequiredSchema,
  PricingCatalogCompatibleConversionSchema,
  CatalogQuantityBasisIncompatibleSchema,
  CatalogQuantityBasisInvalidSchema,
  CatalogQuantityBasisUnavailableSchema,
  CatalogQuantityBasisUnverifiableSchema,
]);
export type PricingCatalogQuantityBasisDecision = typeof PricingCatalogQuantityBasisDecisionSchema.Type;

export const PricingQuantityBasisAttemptSchema = Schema.Struct({
  catalog: PricingCatalogQuantityHandoffSchema,
  effectiveAt: PricingInstantSchema,
  occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
  price: PriceDefinitionSchema,
  tier: Schema.optionalKey(QuantityTierDefinitionSchema),
});
export type PricingQuantityBasisAttempt = typeof PricingQuantityBasisAttemptSchema.Type;

const exactCatalogTargetFor = (attempt: PricingQuantityBasisAttempt) =>
  attempt.price.identityKey.catalogSelection.packageOption?.optionRef ??
  attempt.price.identityKey.catalogSelection.variantRef;

export const PricingQuantityBasisAssessmentInputSchema = Schema.Struct({
  attempt: PricingQuantityBasisAttemptSchema,
  ownerDecision: PricingCatalogQuantityBasisDecisionSchema,
}).check(
  Schema.makeFilter(({ attempt, ownerDecision }) => {
    const { catalog, price, tier } = attempt;
    if (attempt.effectiveAt !== catalog.evidence.assessedAt) {
      return 'Quantity-basis effective time must bind the exact prepared Catalog handoff';
    }
    if (!('selection' in ownerDecision)) {
      return ownerDecision.effectiveAt === attempt.effectiveAt
        ? undefined
        : `Quantity-basis ${leanFailureOutcomeNoun[ownerDecision.outcome]} must bind the exact requested effective time`;
    }
    if (
      !sameCatalogSelection(catalog.selection, price.identityKey.catalogSelection) ||
      !sameCatalogSelection(catalog.selection, ownerDecision.selection)
    ) {
      return 'Quantity-basis assessment must preserve one exact Product, Variant, Package, Configuration, and Set selection';
    }
    if (
      ownerDecision.effectiveAt !== attempt.effectiveAt ||
      ownerDecision.requestedOwnerRevision !== catalog.ownerRevision ||
      ownerDecision.hierarchyRevision !== catalog.hierarchyRevision ||
      ownerDecision.equivalentSelectionKey !== catalog.equivalentSelectionKey ||
      ownerDecision.currentness.observedAt !== ownerDecision.observedAt ||
      ownerDecision.currentness.ownerRevision !== ownerDecision.ownerRevision
    ) {
      return 'Quantity-basis decision must bind effective time, prepared revisions, and the fresh owner observation';
    }
    return tier === undefined ||
      (sameResourceRef(tier.identityKey.priceRef, price.priceRef) &&
        sameResourceRef(
          tier.identityKey.quantityBasis.catalogQuantityBasis.targetRef,
          exactCatalogTargetFor(attempt),
        ) &&
        sameResourceRef(tier.identityKey.quantityBasis.priceUnitBasis.unitRef, price.identityKey.unitBasis.unitRef) &&
        priceDecimalValuesEqual(
          tier.identityKey.quantityBasis.priceUnitBasis.quantity,
          price.identityKey.unitBasis.quantity,
        ))
      ? undefined
      : 'Quantity Tier must belong to the exact Price and preserve its exact Catalog target and Unit basis';
  }),
);
export type PricingQuantityBasisAssessmentInput = typeof PricingQuantityBasisAssessmentInputSchema.Type;

const successFields = {
  attempt: PricingQuantityBasisAttemptSchema,
  occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
  priceQuantity: PricingQuantitySchema,
  requestedQuantity: PricingQuantitySchema,
  resultingPurchaseQuantity: PricingQuantitySchema,
  selection: CatalogSelectionSchema,
  tierQuantity: Schema.optionalKey(PricingQuantitySchema),
};

const successIsCoherent = (value: {
  readonly attempt: PricingQuantityBasisAttempt;
  readonly evidence: PricingCatalogNoConversionRequired | PricingCatalogCompatibleConversion;
  readonly occurrenceId: string;
  readonly priceQuantity: typeof PricingQuantitySchema.Type;
  readonly requestedQuantity: typeof PricingQuantitySchema.Type;
  readonly resultingPurchaseQuantity: typeof PricingQuantitySchema.Type;
  readonly selection: typeof CatalogSelectionSchema.Type;
  readonly tierQuantity?: typeof PricingQuantitySchema.Type;
}): string | undefined => {
  const { attempt, evidence } = value;
  const bindings = [
    [value.requestedQuantity, evidence.endpoints.requested],
    [value.resultingPurchaseQuantity, evidence.endpoints.purchase],
    [value.priceQuantity, evidence.endpoints.price],
    [value.tierQuantity, evidence.endpoints.tier],
  ] as const;
  if (
    value.occurrenceId !== attempt.occurrenceId ||
    !sameCatalogSelection(value.selection, attempt.catalog.selection) ||
    !sameCatalogSelection(evidence.selection, attempt.catalog.selection)
  ) {
    return 'Quantity-basis success must preserve the original occurrence and exact Catalog selection';
  }
  if (
    !priceDecimalValuesEqual(value.requestedQuantity.amount, attempt.catalog.quantity.requested) ||
    !priceDecimalValuesEqual(value.resultingPurchaseQuantity.amount, attempt.catalog.quantity.resulting)
  ) {
    return 'Quantity-basis success must preserve the original requested and resulting purchase quantities';
  }
  if (
    bindings.some(([quantity, endpoint]) =>
      quantity === undefined || endpoint === undefined
        ? quantity !== undefined || endpoint !== undefined
        : !priceDecimalValuesEqual(quantity.amount, endpoint.quantity) ||
          !sameResourceRef(quantity.unitRef, endpoint.quantityBasis.unitRef),
    )
  ) {
    return 'Quantity-basis success quantities must be exact projections of owner-issued endpoints';
  }
  return (attempt.tier === undefined) === (value.tierQuantity === undefined)
    ? undefined
    : 'Tier Quantity is present exactly when an exact Quantity Tier is assessed';
};

export const PricingQuantityBasisNoConversionAssessmentSchema = Schema.Struct({
  ...successFields,
  evidence: PricingCatalogNoConversionRequiredSchema,
  outcome: Schema.Literal('NO_CONVERSION_REQUIRED'),
}).check(Schema.makeFilter(successIsCoherent));
export const PricingQuantityBasisCompatibleConversionAssessmentSchema = Schema.Struct({
  ...successFields,
  evidence: PricingCatalogCompatibleConversionSchema,
  outcome: Schema.Literal('COMPATIBLE_CONVERSION'),
}).check(Schema.makeFilter(successIsCoherent));

const failureAssessment = <Outcome extends 'INCOMPATIBLE' | 'INVALID' | 'UNAVAILABLE' | 'UNVERIFIABLE'>(
  outcome: Outcome,
) =>
  Schema.Struct({
    attempt: PricingQuantityBasisAttemptSchema,
    outcome: Schema.Literal(outcome),
    reason,
    retryable: Schema.optionalKey(Schema.Boolean),
  });

export const PricingQuantityBasisAssessmentSchema = Schema.Union([
  PricingQuantityBasisNoConversionAssessmentSchema,
  PricingQuantityBasisCompatibleConversionAssessmentSchema,
  failureAssessment('INCOMPATIBLE'),
  failureAssessment('INVALID'),
  failureAssessment('UNAVAILABLE'),
  failureAssessment('UNVERIFIABLE'),
]);
export type PricingQuantityBasisAssessment = typeof PricingQuantityBasisAssessmentSchema.Type;
