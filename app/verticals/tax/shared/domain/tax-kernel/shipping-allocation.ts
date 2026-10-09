import { Array as Arr, Schema, pipe } from 'effect';
import type { NonEmptyReadonlyArray } from 'effect/Array';

import { ShippingSourceRefSchema, isSameShippingSourceRef } from './purchase-binding.ts';
import { BoundedIdentifierSchema, distinctBy } from './tax-domain-primitives.ts';
import {
  NonNegativeTaxExactRationalSchema,
  ZERO_TAX_EXACT_RATIONAL,
  sumTaxExactRationals,
  taxExactRationalsEqual,
} from './tax-exact-rational.ts';
import { OwnerIssuedAmountSchema } from './taxable-basis.ts';
import { TaxableSupplyUnitIdSchema } from './taxable-supply-unit.ts';
import type { TaxableSupplyUnitId } from './taxable-supply-unit.ts';

/**
 * Exact allocation of the separately owned Shipping amount into one unit, attributed to the exact source Shipping
 * amount revision and, when owner-approved weights were applied, to their approval evidence (#920 F31-F34,
 * #933 F17-F19, #936 F19, #937 F29-F30).
 */
export const ShippingAllocationBasisSchema = Schema.TaggedStruct('SHIPPING_ALLOCATION', {
  allocationWeightsEvidenceRef: Schema.optionalKey(BoundedIdentifierSchema),
  amount: NonNegativeTaxExactRationalSchema,
  shippingSourceRef: ShippingSourceRefSchema,
});

export type ShippingAllocationBasis = typeof ShippingAllocationBasisSchema.Type;

/**
 * Allocations of one Shipping amount attribute the same exact source and the same weights evidence. Weights
 * evidence may be absent only when one unit takes the whole amount or the authoritative amount is zero
 * (#933 F14, F17-F18; #962 F32; #920 F33).
 */
const isConsistentShippingAttribution = (allocations: NonEmptyReadonlyArray<ShippingAllocationBasis>): boolean => {
  const [first] = allocations;
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

const distinctUnitIds = <Entry>(unitIdOf: (entry: Entry) => TaxableSupplyUnitId) =>
  distinctBy(unitIdOf, 'Taxable Supply Units must not repeat');

/**
 * Owner-issued Shipping/Delivery source state for the exact purchase. A Current amount keeps its exact source
 * revision; Shipping is a separate owner-issued component, not a Pricing Commercial Fee; stale is not Current and
 * unavailable is not free Shipping (#933 F1-F10, #932 F18-F20, #937 F29-F30, #907 F84-F86).
 */
export const ShippingSourceObservationSchema = Schema.Union([
  Schema.TaggedStruct('CURRENT', { amount: OwnerIssuedAmountSchema, shippingSourceRef: ShippingSourceRefSchema }),
  Schema.TaggedStruct('NOT_ESTABLISHED', { state: Schema.Literals(['STALE', 'UNAVAILABLE']) }),
]);

export type ShippingSourceObservation = typeof ShippingSourceObservationSchema.Type;

/**
 * Explicit owner-approved legally relevant allocation weights with their approval evidence. TAX applies them
 * exactly and never derives them from line count, equal split or line value by itself (#933 F17-F18, F24,
 * PO decision 2026-09-28; #907 F91, F93; PO decision D3 pending on #907).
 */
export const OwnerApprovedShippingAllocationWeightsSchema = Schema.Struct({
  approvalEvidenceRef: BoundedIdentifierSchema,
  weights: Schema.NonEmptyArray(
    Schema.Struct({ taxableSupplyUnitId: TaxableSupplyUnitIdSchema, weight: NonNegativeTaxExactRationalSchema }),
  ).check(distinctUnitIds(({ taxableSupplyUnitId }) => taxableSupplyUnitId)),
});

export type OwnerApprovedShippingAllocationWeights = typeof OwnerApprovedShippingAllocationWeightsSchema.Type;

/** Ancillary Shipping of the exact purchase and the Taxable Supply Units it relates to (#933 F12-F17). */
export const ShippingAllocationInputSchema = Schema.Struct({
  affectedTaxableSupplyUnitIds: Schema.NonEmptyArray(TaxableSupplyUnitIdSchema).check(
    distinctUnitIds((unitId: TaxableSupplyUnitId) => unitId),
  ),
  allocationWeights: Schema.optionalKey(OwnerApprovedShippingAllocationWeightsSchema),
  shippingSource: ShippingSourceObservationSchema,
});

export type ShippingAllocationInput = typeof ShippingAllocationInputSchema.Type;

export const UnitShippingAllocationSchema = Schema.Struct({
  basisComponent: ShippingAllocationBasisSchema,
  taxableSupplyUnitId: TaxableSupplyUnitIdSchema,
});

export type UnitShippingAllocation = typeof UnitShippingAllocationSchema.Type;

const basisComponentsOf = (unitAllocations: NonEmptyReadonlyArray<UnitShippingAllocation>) =>
  pipe(
    unitAllocations,
    Arr.map(({ basisComponent }) => basisComponent),
  );

/**
 * Tax-owned exact decomposition of the owner-issued Shipping amount into affected Taxable Supply Units. Allocations
 * stay exact rationals before Tax rounding, keep their source and weights attribution and sum exactly to the
 * unchanged owner-issued amount (#933 F19-F23, #935 F13-F16, #931 F19-F21, #920 F33-F34, #907 F92).
 */
export const ShippingAllocationSchema = Schema.Struct({
  ownerIssuedShippingAmount: NonNegativeTaxExactRationalSchema,
  unitAllocations: Schema.NonEmptyArray(UnitShippingAllocationSchema).check(
    distinctUnitIds(({ taxableSupplyUnitId }) => taxableSupplyUnitId),
  ),
}).check(
  Schema.makeFilter(
    ({ ownerIssuedShippingAmount, unitAllocations }) =>
      taxExactRationalsEqual(
        sumTaxExactRationals(
          pipe(
            basisComponentsOf(unitAllocations),
            Arr.map(({ amount }) => amount),
          ),
        ),
        ownerIssuedShippingAmount,
      ) || 'Exact Shipping allocations must sum to the owner-issued Shipping amount',
  ),
  Schema.makeFilter(
    ({ unitAllocations }) =>
      isConsistentShippingAttribution(basisComponentsOf(unitAllocations)) ||
      'Shipping allocations must keep one exact source and allocation evidence attribution',
  ),
);

export type ShippingAllocation = typeof ShippingAllocationSchema.Type;
