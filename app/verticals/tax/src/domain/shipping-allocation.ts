import { Array as Arr, Match, Option, Result, pipe } from 'effect';
import type { NonEmptyReadonlyArray } from 'effect/Array';

import type { ShippingSourceRef } from '../../shared/domain/tax-kernel/purchase-binding.ts';
import { SHIPPING_ALLOCATION_KEY } from '../../shared/domain/tax-kernel/shipping-allocation.ts';
import {
  ONE_TAX_EXACT_RATIONAL,
  NonNegativeTaxExactRationalSchema,
  ZERO_TAX_EXACT_RATIONAL,
  addTaxExactRationals,
  divideTaxExactRationals,
  multiplyTaxExactRationals,
  sumTaxExactRationals,
  taxExactFractionOfPercent,
  taxExactRationalsEqual,
} from '../../shared/domain/tax-kernel/tax-exact-rational.ts';
import type { NonNegativeTaxExactRational } from '../../shared/domain/tax-kernel/tax-exact-rational.ts';
import type { LineCommercialValueBasis, TaxAmountBasis } from '../../shared/domain/tax-kernel/taxable-basis.ts';
import type { TaxableSupplyUnitId } from '../../shared/domain/tax-kernel/taxable-supply-unit.ts';
import { taxNotEstablishedOutcome } from './tax-non-success-outcome.ts';
import type { TaxCaseUnsupported, TaxNotEstablishedOutcome, TaxStateIndeterminate } from './tax-non-success-outcome.ts';
import type {
  ShippingAllocation,
  ShippingAllocationBasis,
  ShippingAllocationInput,
  ShippingSourceObservation,
  UnitShippingAllocation,
} from '../../shared/domain/tax-kernel/shipping-allocation.ts';

export {
  SHIPPING_ALLOCATION_KEY,
  ShippingAllocationBasisSchema,
  ShippingAllocationInputSchema,
  ShippingAllocationSchema,
} from '../../shared/domain/tax-kernel/shipping-allocation.ts';
export type {
  ShippingAllocation,
  ShippingAllocationInput,
} from '../../shared/domain/tax-kernel/shipping-allocation.ts';

export type ShippingAllocationFailure = TaxCaseUnsupported | TaxNotEstablishedOutcome;

interface AllocatableShipping {
  readonly amount: NonNegativeTaxExactRational;
  readonly amountBasis: TaxAmountBasis;
  readonly shippingSourceRef: ShippingSourceRef;
}

/**
 * Missing, stale or unavailable Shipping is never zero Shipping, and non-CZK is never relabelled (#933 F8-F11).
 * A NET or a GROSS Shipping charge is allocatable, also for a VAT payer: the basis alone is never unsupported, and
 * it is returned with the amount so it is never relabelled (907-Q07).
 */
export const requireAllocatableShippingCharge = (
  source: ShippingSourceObservation,
): Result.Result<AllocatableShipping, ShippingAllocationFailure> =>
  Match.value(source).pipe(
    Match.tag('CURRENT', ({ amount, shippingSourceRef }) => {
      if (amount.currency !== 'CZK') {
        return Result.fail({
          _tag: 'TAX_CASE_UNSUPPORTED' as const,
          unsupportedRequirement: 'NON_CZK_CURRENCY' as const,
        });
      }
      return Result.succeed({ amount: amount.amount, amountBasis: amount.amountBasis, shippingSourceRef });
    }),
    Match.tag('NOT_ESTABLISHED', ({ state }) => Result.fail(taxNotEstablishedOutcome(state))),
    Match.exhaustive,
  );

/**
 * The exact gross weight of one line value: the whole GROSS amount, or a NET amount grossed up by `(1 + r)`. The
 * weight is the whole line value, so the quantity is already in it; it is never a per-piece price. It is only an
 * allocation weight: the published Pricing value and its basis stay unchanged (907-Q05).
 */
export const grossLineValueWeight = (
  line: LineCommercialValueBasis,
  ratePercent: string,
): NonNegativeTaxExactRational => {
  if (line.amountBasis === 'GROSS') {
    return line.amount;
  }
  const grossUpFactor = addTaxExactRationals(ONE_TAX_EXACT_RATIONAL, taxExactFractionOfPercent(ratePercent));
  return NonNegativeTaxExactRationalSchema.make(multiplyTaxExactRationals(line.amount, grossUpFactor));
};

/**
 * Exact proportional shares S * w / SUM(w) in the Shipping charge's own basis, tagged with that basis and the
 * TAX-derived allocation key; a zero total has none (907-Q05, 907-Q07).
 */
const proportionalAllocations = (
  shipping: AllocatableShipping,
  affected: NonEmptyReadonlyArray<{
    readonly grossLineValueWeight: NonNegativeTaxExactRational;
    readonly taxableSupplyUnitId: TaxableSupplyUnitId;
  }>,
): Option.Option<NonEmptyReadonlyArray<UnitShippingAllocation>> => {
  const totalWeight = sumTaxExactRationals(
    pipe(
      affected,
      Arr.map(({ grossLineValueWeight: weight }) => weight),
    ),
  );
  return Option.all(
    pipe(
      affected,
      Arr.map(({ grossLineValueWeight: weight, taxableSupplyUnitId }) =>
        pipe(
          divideTaxExactRationals(weight, totalWeight),
          Option.map((share): UnitShippingAllocation => ({
            basisComponent: {
              _tag: 'SHIPPING_ALLOCATION',
              allocationKey: SHIPPING_ALLOCATION_KEY,
              amount: NonNegativeTaxExactRationalSchema.make(multiplyTaxExactRationals(shipping.amount, share)),
              amountBasis: shipping.amountBasis,
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
 * Allocates ancillary owner-issued Shipping, NET or GROSS, into the Taxable Basis of the affected Taxable Supply
 * Units, using TAX-derived gross line-value weights (907-Q05, 907-Q07; the caller-supplied weights path is deleted).
 * Every share keeps the charge's basis, so the shares sum exactly to the charge in that basis.
 * - One affected unit, or an authoritative zero charge, receives the whole (or zero) amount with no key
 *   (#933 F14, #962 F32).
 * - A total weight of zero with a non-zero charge is indeterminate: zero weights are unusable (#938 F27-F28).
 * - Otherwise the exact derived weights are applied exactly, tagged with the allocation key. The derived weights
 *   cover the affected units by construction.
 */
export const allocateShippingTaxableBasis = (
  input: ShippingAllocationInput,
): Result.Result<ShippingAllocation, ShippingAllocationFailure> =>
  pipe(
    requireAllocatableShippingCharge(input.shippingSource),
    Result.flatMap((shipping): Result.Result<ShippingAllocation, ShippingAllocationFailure> => {
      const affected = input.affectedTaxableSupplyUnits;
      if (affected.length === 1 || taxExactRationalsEqual(shipping.amount, ZERO_TAX_EXACT_RATIONAL)) {
        const component: ShippingAllocationBasis = {
          _tag: 'SHIPPING_ALLOCATION',
          amount: shipping.amount,
          amountBasis: shipping.amountBasis,
          shippingSourceRef: shipping.shippingSourceRef,
        };
        return Result.succeed({
          ownerIssuedShippingAmount: shipping.amount,
          unitAllocations: pipe(
            affected,
            Arr.map(({ taxableSupplyUnitId }) => ({ basisComponent: component, taxableSupplyUnitId })),
          ),
        });
      }
      return pipe(
        proportionalAllocations(shipping, affected),
        Option.match({
          onNone: () => Result.fail(indeterminate),
          onSome: (unitAllocations) => Result.succeed({ ownerIssuedShippingAmount: shipping.amount, unitAllocations }),
        }),
      );
    }),
  );
