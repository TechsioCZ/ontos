import { Schema } from 'effect';
import type { NonEmptyReadonlyArray } from 'effect/Array';

import {
  CatalogSelectionSchema,
  PurchaseDemandOccurrenceIdSchema,
  PurchaseDemandOccurrenceSchema,
} from './purchase-binding.ts';
import type { CatalogSelection, PurchaseDemandOccurrenceId } from './purchase-binding.ts';
import { distinctBy } from './tax-domain-primitives.ts';

/** Tax-owned identity of one Taxable Supply Unit; it is not a Pricing Line or UI row (#920 F1-F11). */
export const TaxableSupplyUnitIdSchema = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(400),
).pipe(Schema.brand('TaxableSupplyUnitId'));

export type TaxableSupplyUnitId = typeof TaxableSupplyUnitIdSchema.Type;

const OrdinaryOccurrenceMappingSchema = Schema.TaggedStruct('ORDINARY_OCCURRENCE', {
  catalogSelection: CatalogSelectionSchema,
  occurrenceId: PurchaseDemandOccurrenceIdSchema,
});

/**
 * A Set's Tax meaning uses the exact pinned Set Composition Revision, which has one canonical place: the exact
 * Catalog Selection (#934 F3, F23; #937 F13, F17).
 */
const pinsSetCompositionRevision = (catalogSelection: CatalogSelection) =>
  catalogSelection.setCompositionRevisionRef !== undefined ||
  'A Set must carry its pinned Set Composition Revision in its exact Catalog Selection';

const WholeTreatmentSetMappingSchema = Schema.TaggedStruct('WHOLE_TREATMENT_SET', {
  catalogSelection: CatalogSelectionSchema,
  occurrenceId: PurchaseDemandOccurrenceIdSchema,
}).check(Schema.makeFilter(({ catalogSelection }) => pinsSetCompositionRevision(catalogSelection)));

/**
 * One Taxable Supply Unit with its explicit mapping to source Purchase Demand Occurrence and Catalog evidence
 * (#920 F17-F18, F25; #937 F15-F17).
 */
export const TaxableSupplyUnitSchema = Schema.Struct({
  mapping: Schema.Union([OrdinaryOccurrenceMappingSchema, WholeTreatmentSetMappingSchema]),
  unitId: TaxableSupplyUnitIdSchema,
});

export type TaxableSupplyUnit = typeof TaxableSupplyUnitSchema.Type;

export const taxableSupplyUnitSourceOccurrenceIds = (
  unit: TaxableSupplyUnit,
): NonEmptyReadonlyArray<PurchaseDemandOccurrenceId> => [unit.mapping.occurrenceId];

const SetOccurrenceSchema = PurchaseDemandOccurrenceSchema.check(
  Schema.makeFilter(({ catalogSelection }) => pinsSetCompositionRevision(catalogSelection)),
);

/**
 * Tax legal supply meaning established for one occurrence before unit mapping. Determining a Set's legal
 * meaning belongs to #934; this mapping only consumes it.
 */
export const OccurrenceSupplyMeaningSchema = Schema.Union([
  Schema.TaggedStruct('ORDINARY', { occurrence: PurchaseDemandOccurrenceSchema }),
  Schema.TaggedStruct('WHOLE_TREATMENT_SET', { occurrence: SetOccurrenceSchema }),
  Schema.TaggedStruct('MULTI_SUPPLY_SET', { occurrence: SetOccurrenceSchema }),
]);

export type OccurrenceSupplyMeaning = typeof OccurrenceSupplyMeaningSchema.Type;

export const OccurrenceSupplyMeaningsSchema = Schema.NonEmptyArray(OccurrenceSupplyMeaningSchema).check(
  distinctBy(
    ({ occurrence }: OccurrenceSupplyMeaning) => occurrence.occurrenceId,
    'Each Purchase Demand Occurrence must have exactly one supply meaning',
  ),
);

export type OccurrenceSupplyMeanings = typeof OccurrenceSupplyMeaningsSchema.Type;
