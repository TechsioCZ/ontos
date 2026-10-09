import { Array as Arr, Match, Option, Result, pipe } from 'effect';
import type { NonEmptyReadonlyArray } from 'effect/Array';

import type { ShippingSourceRef } from '../../shared/domain/tax-kernel/purchase-binding.ts';
import {
  NonNegativeTaxExactRationalSchema,
  ZERO_TAX_EXACT_RATIONAL,
  divideTaxExactRationals,
  multiplyTaxExactRationals,
  sumTaxExactRationals,
  taxExactRationalsEqual,
} from '../../shared/domain/tax-kernel/tax-exact-rational.ts';
import type { NonNegativeTaxExactRational } from '../../shared/domain/tax-kernel/tax-exact-rational.ts';
import { taxNotEstablishedOutcome } from './tax-non-success-outcome.ts';
import type { TaxCaseUnsupported, TaxNotEstablishedOutcome, TaxStateIndeterminate } from './tax-non-success-outcome.ts';
import type { TaxableSupplyUnitId } from './taxable-supply-unit.ts';
import type {
  OwnerApprovedShippingAllocationWeights,
  ShippingAllocation,
  ShippingAllocationBasis,
  ShippingAllocationInput,
  ShippingSourceObservation,
  UnitShippingAllocation,
} from '../../shared/domain/tax-kernel/shipping-allocation.ts';

export {
  ShippingAllocationBasisSchema,
  ShippingAllocationInputSchema,
  ShippingAllocationSchema,
} from '../../shared/domain/tax-kernel/shipping-allocation.ts';
export type {
  ShippingAllocation,
  ShippingAllocationInput,
} from '../../shared/domain/tax-kernel/shipping-allocation.ts';

export type ShippingAllocationFailure = TaxCaseUnsupported | TaxNotEstablishedOutcome;

interface CurrentCzkShipping {
  readonly amount: NonNegativeTaxExactRational;
  readonly shippingSourceRef: ShippingSourceRef;
}

/** Missing, stale or unavailable Shipping is never zero Shipping; non-CZK is never relabelled (#933 F8-F11). */
const requireCurrentCzkShipping = (
  source: ShippingSourceObservation,
): Result.Result<CurrentCzkShipping, ShippingAllocationFailure> =>
  Match.value(source).pipe(
    Match.tag('CURRENT', ({ amount, shippingSourceRef }) =>
      amount.currency === 'CZK'
        ? Result.succeed({ amount: amount.amount, shippingSourceRef })
        : Result.fail({ _tag: 'TAX_CASE_UNSUPPORTED' as const, unsupportedRequirement: 'NON_CZK_CURRENCY' as const }),
    ),
    Match.tag('NOT_ESTABLISHED', ({ state }) => Result.fail(taxNotEstablishedOutcome(state))),
    Match.exhaustive,
  );

const weightsCoverExactly = (
  affected: NonEmptyReadonlyArray<TaxableSupplyUnitId>,
  weights: OwnerApprovedShippingAllocationWeights,
) => {
  const weighted = new Set<string>(weights.weights.map(({ taxableSupplyUnitId }) => taxableSupplyUnitId));
  return weighted.size === affected.length && affected.every((unitId) => weighted.has(unitId));
};

/** Exact proportional shares S * w / SUM(w) attributed to the approval evidence; a zero weight total has none. */
const proportionalAllocations = (
  shipping: CurrentCzkShipping,
  weights: OwnerApprovedShippingAllocationWeights,
): Option.Option<NonEmptyReadonlyArray<UnitShippingAllocation>> => {
  const totalWeight = sumTaxExactRationals(
    pipe(
      weights.weights,
      Arr.map(({ weight }) => weight),
    ),
  );
  return Option.all(
    pipe(
      weights.weights,
      Arr.map(({ taxableSupplyUnitId, weight }) =>
        pipe(
          divideTaxExactRationals(weight, totalWeight),
          Option.map((share): UnitShippingAllocation => ({
            basisComponent: {
              _tag: 'SHIPPING_ALLOCATION',
              allocationWeightsEvidenceRef: weights.approvalEvidenceRef,
              amount: NonNegativeTaxExactRationalSchema.make(multiplyTaxExactRationals(shipping.amount, share)),
              shippingSourceRef: shipping.shippingSourceRef,
            },
            taxableSupplyUnitId,
          })),
        ),
      ),
    ),
  );
};

const indeterminate: TaxStateIndeterminate = { _tag: 'TAX_STATE_INDETERMINATE' };

/**
 * Allocates ancillary owner-issued Shipping into the Taxable Basis of the affected Taxable Supply Units.
 * - Provided weights that do not exactly cover the affected units are an inconsistent material set, so the state
 *   is indeterminate even for one affected unit (#938 F27-F28).
 * - One affected unit receives the whole amount (#933 F14).
 * - Authoritative zero Shipping stays zero for every affected unit, as no other exact conserving split exists
 *   (#962 F32, #933 F21).
 * - Otherwise the explicit owner-approved weights are applied exactly; without usable weights there is no guessed
 *   allocation and no successful basis (#933 F17-F18, F24; #907 F91, F93; PO decision D3).
 */
export const allocateShippingTaxableBasis = (
  input: ShippingAllocationInput,
): Result.Result<ShippingAllocation, ShippingAllocationFailure> =>
  pipe(
    requireCurrentCzkShipping(input.shippingSource),
    Result.flatMap((shipping): Result.Result<ShippingAllocation, ShippingAllocationFailure> => {
      const affected = input.affectedTaxableSupplyUnitIds;
      const weights = input.allocationWeights;
      if (weights !== undefined && !weightsCoverExactly(affected, weights)) {
        return Result.fail(indeterminate);
      }
      if (affected.length === 1 || taxExactRationalsEqual(shipping.amount, ZERO_TAX_EXACT_RATIONAL)) {
        const component: ShippingAllocationBasis = {
          _tag: 'SHIPPING_ALLOCATION',
          amount: shipping.amount,
          shippingSourceRef: shipping.shippingSourceRef,
        };
        return Result.succeed({
          ownerIssuedShippingAmount: shipping.amount,
          unitAllocations: pipe(
            affected,
            Arr.map((taxableSupplyUnitId) => ({ basisComponent: component, taxableSupplyUnitId })),
          ),
        });
      }
      if (weights === undefined) {
        return Result.fail(indeterminate);
      }
      return pipe(
        proportionalAllocations(shipping, weights),
        Option.match({
          onNone: () => Result.fail(indeterminate),
          onSome: (unitAllocations) => Result.succeed({ ownerIssuedShippingAmount: shipping.amount, unitAllocations }),
        }),
      );
    }),
  );
