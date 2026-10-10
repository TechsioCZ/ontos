import { Option, Schema } from 'effect';

import {
  NonNegativeTaxExactRationalSchema,
  ZERO_TAX_EXACT_RATIONAL,
  taxExactFractionOfPercent,
  taxExactRationalFromDecimal,
} from '../../shared/domain/tax-kernel/tax-exact-rational.ts';
import type {
  NonNegativeTaxExactRational,
  TaxExactRational,
} from '../../shared/domain/tax-kernel/tax-exact-rational.ts';
import type { TaxMonetaryAmount } from '../../shared/domain/tax-kernel/tax-monetary-amount.ts';
import type { TaxRoundingPolicy } from './tax-rounding.ts';
import type { TaxableSupplyUnitId } from './taxable-supply-unit.ts';
import { ShippingAllocationBasisSchema } from '../../shared/domain/tax-kernel/shipping-allocation.ts';
import { TaxableDecisionUnitSchema } from '../../shared/domain/tax-kernel/tax-decision.ts';
import { LineCommercialValueBasisSchema } from '../../shared/domain/tax-kernel/taxable-basis.ts';
import type { TaxAmountBasis } from '../../shared/domain/tax-kernel/taxable-basis.ts';
import type { AcceptedTaxTerms } from '../../shared/domain/tax-kernel/accepted-tax-terms.ts';

export {
  AcceptedTaxTermsSchema,
  AuthoritativeOriginalAcceptedRecordSchema,
} from '../../shared/domain/tax-kernel/accepted-tax-terms.ts';
export type { AcceptedTaxTerms } from '../../shared/domain/tax-kernel/accepted-tax-terms.ts';

const isLineCommercialValue = Schema.is(LineCommercialValueBasisSchema);
const isShippingAllocation = Schema.is(ShippingAllocationBasisSchema);
const isTaxableDecisionUnit = Schema.is(TaxableDecisionUnitSchema);

/** Exact original meaning of one Taxable Supply Unit as recorded on the Authoritative Original Accepted Record. */
export interface OriginalUnitBaseline {
  readonly lineAmountBasis: TaxAmountBasis;
  readonly originalLineBasis: NonNegativeTaxExactRational;
  readonly originalPublishedTax: TaxMonetaryAmount;
  readonly originalQuantity: TaxExactRational;
  readonly originalShippingBasis: NonNegativeTaxExactRational;
  readonly rate: TaxExactRational;
  readonly taxRoundingPolicy: TaxRoundingPolicy;
}

/**
 * Baseline of one original unit read only from the accepted record: its exact basis components (Line Commercial
 * Value and any allocated Shipping, zero when none), original rate and published Tax, the accepted quantity of its source occurrence and the used
 * rounding policy. No Catalog, Pricing, Tax Rule or registration source is consulted. A unit outside the record's
 * exact partition has no baseline. A seller-is-non-payer unit has no baseline either; its treatment-aware baseline
 * is Unit 12 (#945 F12-F14, #946 F10-F11, #948 F2-F5, F8; Unit 10 A5, F17).
 */
export const originalUnitBaseline = (
  terms: AcceptedTaxTerms,
  taxableSupplyUnitId: TaxableSupplyUnitId,
): Option.Option<OriginalUnitBaseline> => {
  const { decision, result } = terms.finalTax;
  const unit = decision.units.find(({ taxableSupplyUnit }) => taxableSupplyUnit.unitId === taxableSupplyUnitId);
  const published = result.units.find((evidence) => evidence.taxableSupplyUnitId === taxableSupplyUnitId);
  const occurrence = decision.purchaseBinding.purchaseDemandOccurrences.find(
    ({ occurrenceId }) => occurrenceId === unit?.taxableSupplyUnit.mapping.occurrenceId,
  );
  const line = unit?.taxableBasisInterpretation.components.find(isLineCommercialValue);
  const shipping = unit?.taxableBasisInterpretation.components.find(isShippingAllocation);
  if (
    unit === undefined ||
    !isTaxableDecisionUnit(unit) ||
    published === undefined ||
    occurrence === undefined ||
    line === undefined
  ) {
    return Option.none();
  }
  return Option.map(taxExactRationalFromDecimal(occurrence.quantity.amount), (originalQuantity) => ({
    lineAmountBasis: line.amountBasis,
    originalLineBasis: line.amount,
    originalPublishedTax: published.publishedTaxAmount,
    originalQuantity,
    originalShippingBasis: shipping?.amount ?? NonNegativeTaxExactRationalSchema.make(ZERO_TAX_EXACT_RATIONAL),
    rate: taxExactFractionOfPercent(unit.treatment.ratePercent),
    taxRoundingPolicy: result.taxRoundingPolicy,
  }));
};
