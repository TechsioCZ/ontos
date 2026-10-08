import { Schema } from 'effect';

import {
  PurchaseDemandOccurrenceIdSchema,
  ShippingSourceRefSchema,
  TaxPurchaseBindingSchema,
  isSameShippingSourceRef,
} from './purchase-binding.ts';
import type { TaxPurchaseBinding } from './purchase-binding.ts';
import { BoundedIdentifierSchema, RevisionSchema } from './tax-domain-primitives.ts';
import {
  NonNegativeTaxExactRationalSchema,
  ZERO_TAX_EXACT_RATIONAL,
  taxExactRationalsEqual,
} from './tax-exact-rational.ts';
import { TaxJurisdictionSchema } from './tax-jurisdiction.ts';
import { TaxEvaluationTimeSchema, TaxRelevantTimeSchema } from './tax-time.ts';
import { TaxApplicabilitySchema, TaxableTreatmentSchema } from './tax-treatment.ts';
import { TaxableSupplyUnitSchema, taxableSupplyUnitSourceOccurrenceIds } from './taxable-supply-unit.ts';

export const TaxDecisionIdSchema = BoundedIdentifierSchema.pipe(Schema.brand('TaxDecisionId'));
export type TaxDecisionId = typeof TaxDecisionIdSchema.Type;

/** Exact governing Tax Rule Revision retained as Tax Evidence (#936 F19, #937 F31). */
export const TaxRuleIdSchema = BoundedIdentifierSchema.pipe(Schema.brand('TaxRuleId'));

export const TaxRuleRevisionRefSchema = Schema.Struct({
  revision: RevisionSchema,
  taxRuleId: TaxRuleIdSchema,
});

/** Published Line Commercial Value of the Pricing Line for one source occurrence (#937 F27, #920 F19). */
export const LineCommercialValueBasisSchema = Schema.TaggedStruct('LINE_COMMERCIAL_VALUE', {
  amount: NonNegativeTaxExactRationalSchema,
  occurrenceId: PurchaseDemandOccurrenceIdSchema,
  pricingLineRef: BoundedIdentifierSchema,
});

/**
 * Exact allocation of the separately owned Shipping amount into this unit, attributed to the exact source Shipping
 * amount revision and, when owner-approved weights were applied, to their approval evidence (#920 F31-F34,
 * #933 F17-F19, #936 F19, #937 F29-F30).
 */
export const ShippingAllocationBasisSchema = Schema.TaggedStruct('SHIPPING_ALLOCATION', {
  allocationWeightsEvidenceRef: Schema.optionalKey(BoundedIdentifierSchema),
  amount: NonNegativeTaxExactRationalSchema,
  shippingSourceRef: ShippingSourceRefSchema,
});
export type ShippingAllocationBasis = typeof ShippingAllocationBasisSchema.Type;

const isLineCommercialValue = Schema.is(LineCommercialValueBasisSchema);
const isShippingAllocation = Schema.is(ShippingAllocationBasisSchema);

/**
 * Allocations of one Shipping amount attribute the same exact source and the same weights evidence. Weights
 * evidence may be absent only when one unit takes the whole amount or the authoritative amount is zero
 * (#933 F14, F17-F18; #962 F32; #920 F33).
 */
export const isConsistentShippingAttribution = (allocations: readonly ShippingAllocationBasis[]): boolean => {
  const [first] = allocations;
  if (first === undefined) {
    return true;
  }
  const weighted =
    allocations.length > 1 &&
    allocations.some(({ amount }) => !taxExactRationalsEqual(amount, ZERO_TAX_EXACT_RATIONAL));
  return allocations.every(
    ({ allocationWeightsEvidenceRef, shippingSourceRef }) =>
      isSameShippingSourceRef(shippingSourceRef, first.shippingSourceRef) &&
      allocationWeightsEvidenceRef === first.allocationWeightsEvidenceRef &&
      (!weighted || allocationWeightsEvidenceRef !== undefined),
  );
};

/** Taxable Basis interpretation of one Taxable Supply Unit (#936 F17, #920 F44). */
export const TaxableBasisInterpretationSchema = Schema.Struct({
  components: Schema.NonEmptyArray(Schema.Union([LineCommercialValueBasisSchema, ShippingAllocationBasisSchema])),
});
export type TaxableBasisInterpretation = typeof TaxableBasisInterpretationSchema.Type;

/**
 * Each source Line Commercial Value and the unit's Shipping allocation enter its basis at most once, so nothing
 * already inside the published value is counted again (#931 F8-F10, #907 F80-F82).
 */
const countsEachComponentOnce = ({ components }: TaxableBasisInterpretation): boolean => {
  const seen = new Set<string>();
  for (const component of components) {
    const identity = isLineCommercialValue(component) ? `line:${component.occurrenceId}` : 'shipping';
    if (seen.has(identity)) {
      return false;
    }
    seen.add(identity);
  }
  return true;
};

/**
 * Unit-specific Tax meaning: applicability, jurisdiction, treatment with rate, Taxable Basis interpretation and
 * governing rule. A rate alone is not a Decision (#936 F9, F14-F18; #907 F109-F110).
 */
export const TaxDecisionUnitSchema = Schema.Struct({
  applicability: TaxApplicabilitySchema,
  governingTaxRuleRevisionRef: TaxRuleRevisionRefSchema,
  jurisdiction: TaxJurisdictionSchema,
  taxableBasisInterpretation: TaxableBasisInterpretationSchema,
  taxableSupplyUnit: TaxableSupplyUnitSchema,
  treatment: TaxableTreatmentSchema,
}).check(
  Schema.makeFilter(({ taxableBasisInterpretation, taxableSupplyUnit }) => {
    const sources = new Set<string>(taxableSupplyUnitSourceOccurrenceIds(taxableSupplyUnit));
    return (
      taxableBasisInterpretation.components
        .filter(isLineCommercialValue)
        .every(({ occurrenceId }) => sources.has(occurrenceId)) ||
      'Line Commercial Values must stay bound to the unit source occurrences'
    );
  }),
  Schema.makeFilter(
    ({ taxableBasisInterpretation }) =>
      countsEachComponentOnce(taxableBasisInterpretation) ||
      'A Line Commercial Value or Shipping allocation must not enter one unit basis twice',
  ),
);
export type TaxDecisionUnit = typeof TaxDecisionUnitSchema.Type;

const unitsPartitionOccurrences = (purchaseBinding: TaxPurchaseBinding, units: readonly TaxDecisionUnit[]): boolean => {
  const unitIds = new Set(units.map(({ taxableSupplyUnit }) => taxableSupplyUnit.unitId));
  const mapped = units.flatMap(({ taxableSupplyUnit }) => taxableSupplyUnitSourceOccurrenceIds(taxableSupplyUnit));
  const bound = new Set<string>(purchaseBinding.purchaseDemandOccurrences.map(({ occurrenceId }) => occurrenceId));
  return (
    unitIds.size === units.length &&
    new Set(mapped).size === mapped.length &&
    mapped.length === bound.size &&
    mapped.every((occurrenceId) => bound.has(occurrenceId))
  );
};

/** Every Shipping allocation is attributed to the purchase's exact bound Shipping source (#937 F29-F30, #920 F33). */
const shippingAttributedToBoundSource = (
  purchaseBinding: TaxPurchaseBinding,
  units: readonly TaxDecisionUnit[],
): boolean => {
  const allocations = units.flatMap(({ taxableBasisInterpretation }) =>
    taxableBasisInterpretation.components.filter(isShippingAllocation),
  );
  return (
    isConsistentShippingAttribution(allocations) &&
    allocations.every(
      ({ shippingSourceRef }) =>
        purchaseBinding.shippingSourceRef !== undefined &&
        isSameShippingSourceRef(shippingSourceRef, purchaseBinding.shippingSourceRef),
    )
  );
};

/**
 * Purchase-scoped Tax Decision for one exact purchase, preserving the exact Taxable Supply Unit set (#936 F1-F19,
 * #920 F36-F43). Tax-Relevant Time is part of its meaning; Tax Evaluation Time is separate provenance of a
 * distinct type (#937 F33-F35, #941 F1, #927 H).
 */
export const TaxDecisionSchema = Schema.Struct({
  decisionId: TaxDecisionIdSchema,
  purchaseBinding: TaxPurchaseBindingSchema,
  taxEvaluationTime: TaxEvaluationTimeSchema,
  taxRelevantTime: TaxRelevantTimeSchema,
  units: Schema.NonEmptyArray(TaxDecisionUnitSchema),
}).check(
  Schema.makeFilter(
    ({ purchaseBinding, units }) =>
      unitsPartitionOccurrences(purchaseBinding, units) ||
      'Every bound Purchase Demand Occurrence must map to exactly one distinct Taxable Supply Unit',
  ),
  Schema.makeFilter(
    ({ purchaseBinding, units }) =>
      shippingAttributedToBoundSource(purchaseBinding, units) ||
      'Shipping allocations must be attributed to the exact bound Shipping source and its allocation evidence',
  ),
);
export type TaxDecision = typeof TaxDecisionSchema.Type;
