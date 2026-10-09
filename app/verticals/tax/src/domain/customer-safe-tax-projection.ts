import { Array as Arr, Match, Option, pipe } from 'effect';
import type { NonEmptyReadonlyArray } from 'effect/Array';

import type { TaxOutcome, TaxOutcomeSuccess } from './tax-outcome.ts';
import { taxableSupplyUnitSourceOccurrenceIds } from './taxable-supply-unit.ts';
import { CUSTOMER_SAFE_TAX_PROJECTION_VERSION } from '../../shared/domain/tax-kernel/customer-safe-tax-projection.ts';
import type {
  CustomerSafeTaxComponent,
  CustomerSafeTaxDecompositionNeed,
  CustomerSafeTaxProjection,
} from '../../shared/domain/tax-kernel/customer-safe-tax-projection.ts';

export {
  CUSTOMER_SAFE_TAX_PROJECTION_VERSION,
  CustomerSafeTaxNotDeterminedSchema,
  CustomerSafeTaxProjectionSchema,
} from '../../shared/domain/tax-kernel/customer-safe-tax-projection.ts';
export type {
  CustomerSafeTaxDecompositionNeed,
  CustomerSafeTaxProjection,
} from '../../shared/domain/tax-kernel/customer-safe-tax-projection.ts';

/**
 * Joins each Decision unit with its published Result amount by Taxable Supply Unit identity, never by array position
 * (#937 F7, #936 F28-F29). The outcome schema guarantees the Result covers exactly the Decision units, so no unit is
 * dropped (#940 F32); a missing published amount, impossible under the outcome schema, projects as
 * TAX_NOT_DETERMINED.
 */
const componentsOf = (success: TaxOutcomeSuccess): Option.Option<NonEmptyReadonlyArray<CustomerSafeTaxComponent>> => {
  const publishedByUnitId = new Map<string, CustomerSafeTaxComponent['taxAmount']>(
    success.result.units.map(({ publishedTaxAmount, taxableSupplyUnitId }) => [
      taxableSupplyUnitId,
      publishedTaxAmount,
    ]),
  );
  return Option.all(
    pipe(
      success.decision.units,
      Arr.map(({ taxableSupplyUnit, treatment }) =>
        pipe(
          Option.fromUndefinedOr(publishedByUnitId.get(taxableSupplyUnit.unitId)),
          Option.map((taxAmount): CustomerSafeTaxComponent => ({
            purchaseDemandOccurrenceIds: taxableSupplyUnitSourceOccurrenceIds(taxableSupplyUnit),
            taxAmount,
            treatment: { category: treatment._tag, ratePercent: treatment.ratePercent },
          })),
        ),
      ),
    ),
  );
};

const notDetermined: CustomerSafeTaxProjection = {
  _tag: 'TAX_NOT_DETERMINED',
  contractVersion: CUSTOMER_SAFE_TAX_PROJECTION_VERSION,
};

/**
 * Projects one authoritative Tax Outcome into its customer-safe view by copying published values only; it never
 * recomputes Tax, rounds or balances (#940 F19, F32-F36, F44).
 */
export const projectCustomerSafeTax = (
  outcome: TaxOutcome,
  decompositionNeed: CustomerSafeTaxDecompositionNeed,
): CustomerSafeTaxProjection =>
  Match.value(outcome).pipe(
    Match.tag('TAX_DETERMINED', (success): CustomerSafeTaxProjection => {
      const projection = {
        _tag: 'TAX_AMOUNT',
        contractVersion: CUSTOMER_SAFE_TAX_PROJECTION_VERSION,
        purchaseTaxTotal: success.result.purchaseTaxTotal,
      } as const;
      return decompositionNeed === 'PER_TAXABLE_SUPPLY_UNIT'
        ? pipe(
            componentsOf(success),
            Option.match({
              onNone: () => notDetermined,
              onSome: (components): CustomerSafeTaxProjection => ({ ...projection, components }),
            }),
          )
        : projection;
    }),
    Match.orElse(() => notDetermined),
  );
