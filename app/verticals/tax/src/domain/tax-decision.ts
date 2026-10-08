import { Schema } from 'effect';

import { TaxPurchaseBindingSchema, isSameCatalogSelection, isSameShippingSourceRef } from './purchase-binding.ts';
import type { TaxPurchaseBinding } from './purchase-binding.ts';
import { ShippingAllocationBasisSchema, ShippingAllocationSchema } from './shipping-allocation.ts';
import type { ShippingAllocation, ShippingAllocationBasis } from './shipping-allocation.ts';
import { TaxClassificationSchema } from './tax-classification.ts';
import { BoundedIdentifierSchema, RevisionSchema } from './tax-domain-primitives.ts';
import { taxExactRationalsEqual } from './tax-exact-rational.ts';
import { TaxJurisdictionDeterminationSchema } from './tax-jurisdiction.ts';
import { TaxEvaluationTimeSchema, TaxRelevantTimeSchema } from './tax-time.ts';
import { TaxApplicabilitySchema, TaxableTreatmentSchema } from './tax-treatment.ts';
import { LineCommercialValueBasisSchema } from './taxable-basis.ts';
import { TaxableSupplyUnitSchema, taxableSupplyUnitSourceOccurrenceIds } from './taxable-supply-unit.ts';

export const TaxDecisionIdSchema = BoundedIdentifierSchema.pipe(Schema.brand('TaxDecisionId'));
export type TaxDecisionId = typeof TaxDecisionIdSchema.Type;

/** Exact governing Tax Rule Revision retained as Tax Evidence (#936 F19, #937 F31). */
export const TaxRuleIdSchema = BoundedIdentifierSchema.pipe(Schema.brand('TaxRuleId'));

export const TaxRuleRevisionRefSchema = Schema.Struct({
  revision: RevisionSchema,
  taxRuleId: TaxRuleIdSchema,
});

const isLineCommercialValue = Schema.is(LineCommercialValueBasisSchema);
const isShippingAllocation = Schema.is(ShippingAllocationBasisSchema);

/** Taxable Basis interpretation of one Taxable Supply Unit (#936 F17, #920 F44). */
export const TaxableBasisInterpretationSchema = Schema.Struct({
  components: Schema.NonEmptyArray(Schema.Union([LineCommercialValueBasisSchema, ShippingAllocationBasisSchema])),
});
export type TaxableBasisInterpretation = typeof TaxableBasisInterpretationSchema.Type;

/**
 * The unit's Shipping allocation enters its basis at most once, so nothing is counted again (#931 F8-F10,
 * #907 F80-F82).
 */
const countsShippingOnce = ({ components }: TaxableBasisInterpretation): boolean =>
  components.filter(isShippingAllocation).length <= 1;

/**
 * Unit-specific Tax meaning: applicability, jurisdiction with its place evidence, Tax Classification of the exact
 * Catalog Selection, treatment with rate, Taxable Basis interpretation and governing rule. A rate alone is not a
 * Decision (#936 F9, F14-F19; #920 F18; #927 H; #907 F109-F110).
 */
export const TaxDecisionUnitSchema = Schema.Struct({
  applicability: TaxApplicabilitySchema,
  governingTaxRuleRevisionRef: TaxRuleRevisionRefSchema,
  jurisdiction: TaxJurisdictionDeterminationSchema,
  taxableBasisInterpretation: TaxableBasisInterpretationSchema,
  taxableSupplyUnit: TaxableSupplyUnitSchema,
  taxClassification: TaxClassificationSchema,
  treatment: TaxableTreatmentSchema,
}).check(
  Schema.makeFilter(({ taxableBasisInterpretation, taxableSupplyUnit }) => {
    const sources = taxableSupplyUnitSourceOccurrenceIds(taxableSupplyUnit);
    const lines = taxableBasisInterpretation.components.filter(isLineCommercialValue);
    return (
      (lines.length === sources.length &&
        sources.every((occurrenceId) => lines.some((line) => line.occurrenceId === occurrenceId))) ||
      'Each unit source occurrence must enter the basis with exactly one Line Commercial Value'
    );
  }),
  Schema.makeFilter(
    ({ taxableBasisInterpretation }) =>
      countsShippingOnce(taxableBasisInterpretation) || 'A Shipping allocation must not enter one unit basis twice',
  ),
  Schema.makeFilter(
    ({ taxableSupplyUnit, taxClassification }) =>
      isSameCatalogSelection(taxClassification.catalogSelection, taxableSupplyUnit.mapping.catalogSelection) ||
      'The Tax Classification must be of the unit exact Catalog Selection',
  ),
);
export type TaxDecisionUnit = typeof TaxDecisionUnitSchema.Type;

/** Every bound occurrence maps to exactly one distinct unit carrying the same exact Catalog Selection (#937 F13-F15). */
const unitsPartitionOccurrences = (purchaseBinding: TaxPurchaseBinding, units: readonly TaxDecisionUnit[]): boolean => {
  const unitIds = new Set(units.map(({ taxableSupplyUnit }) => taxableSupplyUnit.unitId));
  const mapped = units.map(({ taxableSupplyUnit }) => taxableSupplyUnit.mapping);
  const bound = new Map(
    purchaseBinding.purchaseDemandOccurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]),
  );
  return (
    unitIds.size === units.length &&
    new Set(mapped.map(({ occurrenceId }) => occurrenceId)).size === mapped.length &&
    mapped.length === bound.size &&
    mapped.every(({ catalogSelection, occurrenceId }) => {
      const occurrence = bound.get(occurrenceId);
      return occurrence !== undefined && isSameCatalogSelection(catalogSelection, occurrence.catalogSelection);
    })
  );
};

const isSameShippingAllocationBasis = (left: ShippingAllocationBasis, right: ShippingAllocationBasis): boolean =>
  taxExactRationalsEqual(left.amount, right.amount) &&
  isSameShippingSourceRef(left.shippingSourceRef, right.shippingSourceRef) &&
  left.allocationWeightsEvidenceRef === right.allocationWeightsEvidenceRef;

/**
 * Bound Shipping is complete and conserved: the purchase-level allocation is present exactly when the purchase binds
 * a Shipping source, is attributed to that exact source, covers only Decision units, and each unit carries exactly
 * its allocated component while every other unit carries none (#907 F85, #933 F8, F12, F19-F21, #935 F14,
 * #920 F32-F34, #937 F29-F30). Conservation of the owner-issued amount is the allocation's own invariant.
 */
const shippingAllocatedCompletely = (
  purchaseBinding: TaxPurchaseBinding,
  shippingAllocation: ShippingAllocation | undefined,
  units: readonly TaxDecisionUnit[],
): boolean => {
  if (shippingAllocation === undefined || purchaseBinding.shippingSourceRef === undefined) {
    return (
      shippingAllocation === undefined &&
      purchaseBinding.shippingSourceRef === undefined &&
      units.every(({ taxableBasisInterpretation }) => !taxableBasisInterpretation.components.some(isShippingAllocation))
    );
  }
  const [first] = shippingAllocation.unitAllocations;
  const allocated = new Map(
    shippingAllocation.unitAllocations.map(({ basisComponent, taxableSupplyUnitId }) => [
      taxableSupplyUnitId,
      basisComponent,
    ]),
  );
  const unitIds = new Set<string>(units.map(({ taxableSupplyUnit }) => taxableSupplyUnit.unitId));
  return (
    isSameShippingSourceRef(first.basisComponent.shippingSourceRef, purchaseBinding.shippingSourceRef) &&
    [...allocated.keys()].every((unitId) => unitIds.has(unitId)) &&
    units.every(({ taxableBasisInterpretation, taxableSupplyUnit }) => {
      const [component, ...rest] = taxableBasisInterpretation.components.filter(isShippingAllocation);
      const expected = allocated.get(taxableSupplyUnit.unitId);
      return expected === undefined
        ? component === undefined
        : component !== undefined && rest.length === 0 && isSameShippingAllocationBasis(component, expected);
    })
  );
};

/**
 * Purchase-scoped Tax Decision for one exact purchase, preserving the exact Taxable Supply Unit set and, when the
 * purchase binds Shipping, its exact purchase-level Shipping allocation (#936 F1-F19, #920 F32-F43, #933 F12-F21).
 * Tax-Relevant Time is part of its meaning; Tax Evaluation Time is separate provenance of a distinct type
 * (#937 F33-F35, #941 F1, #927 H).
 */
export const TaxDecisionSchema = Schema.Struct({
  decisionId: TaxDecisionIdSchema,
  purchaseBinding: TaxPurchaseBindingSchema,
  shippingAllocation: Schema.optionalKey(ShippingAllocationSchema),
  taxEvaluationTime: TaxEvaluationTimeSchema,
  taxRelevantTime: TaxRelevantTimeSchema,
  units: Schema.NonEmptyArray(TaxDecisionUnitSchema),
}).check(
  Schema.makeFilter(
    ({ purchaseBinding, units }) =>
      unitsPartitionOccurrences(purchaseBinding, units) ||
      'Every bound Purchase Demand Occurrence must map to exactly one distinct Taxable Supply Unit with its exact Catalog Selection',
  ),
  Schema.makeFilter(
    ({ purchaseBinding, shippingAllocation, units }) =>
      shippingAllocatedCompletely(purchaseBinding, shippingAllocation, units) ||
      'Bound Shipping must be allocated completely, exactly and only into Decision units',
  ),
);
export type TaxDecision = typeof TaxDecisionSchema.Type;
