import { Array as Arr, Match, Result, pipe } from 'effect';
import type { NonEmptyReadonlyArray } from 'effect/Array';

import type { PurchaseDemandOccurrence } from '../../shared/domain/tax-kernel/purchase-binding.ts';
import type { TaxCaseUnsupported } from './tax-non-success-outcome.ts';
import { TaxableSupplyUnitIdSchema } from '../../shared/domain/tax-kernel/taxable-supply-unit.ts';
import type {
  OccurrenceSupplyMeaning,
  OccurrenceSupplyMeanings,
  TaxableSupplyUnit,
  TaxableSupplyUnitId,
} from '../../shared/domain/tax-kernel/taxable-supply-unit.ts';

export {
  OccurrenceSupplyMeaningsSchema,
  TaxableSupplyUnitSchema,
  taxableSupplyUnitSourceOccurrenceIds,
} from '../../shared/domain/tax-kernel/taxable-supply-unit.ts';
export type {
  OccurrenceSupplyMeaning,
  OccurrenceSupplyMeanings,
  TaxableSupplyUnit,
  TaxableSupplyUnitId,
} from '../../shared/domain/tax-kernel/taxable-supply-unit.ts';

/** Deterministic unit identity for the same exact occurrence (#936 F58); distinct occurrences never collide. */
const unitIdFor = (occurrence: PurchaseDemandOccurrence): TaxableSupplyUnitId =>
  TaxableSupplyUnitIdSchema.make(`taxable-supply-unit:${occurrence.occurrenceId}`);

const unitFor = (meaning: OccurrenceSupplyMeaning): Result.Result<TaxableSupplyUnit, TaxCaseUnsupported> =>
  Match.value(meaning).pipe(
    Match.tag('ORDINARY', ({ occurrence }) =>
      Result.succeed({
        mapping: {
          _tag: 'ORDINARY_OCCURRENCE' as const,
          catalogSelection: occurrence.catalogSelection,
          occurrenceId: occurrence.occurrenceId,
        },
        unitId: unitIdFor(occurrence),
      }),
    ),
    Match.tag('WHOLE_TREATMENT_SET', ({ occurrence }) =>
      Result.succeed({
        mapping: {
          _tag: 'WHOLE_TREATMENT_SET' as const,
          catalogSelection: occurrence.catalogSelection,
          occurrenceId: occurrence.occurrenceId,
        },
        unitId: unitIdFor(occurrence),
      }),
    ),
    Match.tag('MULTI_SUPPLY_SET', () =>
      Result.fail({
        _tag: 'TAX_CASE_UNSUPPORTED' as const,
        unsupportedRequirement: 'SET_MULTI_SUPPLY_DECOMPOSITION' as const,
      }),
    ),
    Match.exhaustive,
  );

/**
 * Maps exact occurrences to Taxable Supply Units: one unit per ordinary occurrence, one unit per whole-treatment
 * Set, never merging equal occurrences (#920 F12-F16, F25-F26). A Set requiring several separate taxable
 * supplies is TAX_CASE_UNSUPPORTED, with no split or fallback (#920 F29-F30, #918 F39).
 */
export const mapTaxableSupplyUnits = (
  meanings: OccurrenceSupplyMeanings,
): Result.Result<NonEmptyReadonlyArray<TaxableSupplyUnit>, TaxCaseUnsupported> =>
  Result.all(pipe(meanings, Arr.map(unitFor)));
