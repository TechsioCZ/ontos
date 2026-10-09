import { Schema } from 'effect';

import { CatalogSelectionSchema } from './purchase-binding.ts';
import { BoundedIdentifierSchema, distinctBy } from './tax-domain-primitives.ts';

/** Current owner-qualified Catalog evidence for one material Catalog fact revision (#926 F2, F6, H). */
const CurrentCatalogTaxEvidenceSchema = Schema.TaggedStruct('CURRENT', {
  catalogFactRef: BoundedIdentifierSchema,
  catalogFactRevisionRef: BoundedIdentifierSchema,
  ownerEvidenceRef: BoundedIdentifierSchema,
});

export type CurrentCatalogTaxEvidence = typeof CurrentCatalogTaxEvidenceSchema.Type;

/** Decisive Catalog evidence that is stale, unavailable, conflicting or unverifiable (#926 F13). */
const UnusableCatalogTaxEvidenceSchema = Schema.TaggedStruct('NOT_USABLE', {
  catalogFactRef: BoundedIdentifierSchema,
  state: Schema.Literals(['STALE', 'UNAVAILABLE', 'CONFLICTING', 'UNVERIFIABLE']),
});

export const CatalogTaxEvidenceSchema = Schema.Union([
  CurrentCatalogTaxEvidenceSchema,
  UnusableCatalogTaxEvidenceSchema,
]);

export type CatalogTaxEvidence = typeof CatalogTaxEvidenceSchema.Type;

/** Owner-verifiable completeness of the material evidence set for the decisive predicate (#926 F12, H). */
export const CatalogTaxEvidenceCompletenessSchema = Schema.Union([
  Schema.TaggedStruct('OWNER_VERIFIED_COMPLETE', { ownerEvidenceRef: BoundedIdentifierSchema }),
  Schema.TaggedStruct('NOT_ESTABLISHED', {}),
]);

/**
 * Classification input: the exact Catalog Selection with the minimum material owner-qualified Catalog evidence
 * issued for the declared TAX purpose; another Catalog purpose is not an implicit synonym (#926 F6, J handoff;
 * #907 F47).
 */
export const TaxClassificationInputSchema = Schema.Struct({
  catalogSelection: CatalogSelectionSchema,
  evidencePurpose: Schema.Literal('TAX'),
  materialCatalogEvidence: Schema.NonEmptyArray(CatalogTaxEvidenceSchema).check(
    distinctBy(({ catalogFactRef }: CatalogTaxEvidence) => catalogFactRef, 'Each material Catalog fact appears once'),
  ),
  materialEvidenceCompleteness: CatalogTaxEvidenceCompletenessSchema,
});

export type TaxClassificationInput = typeof TaxClassificationInputSchema.Type;

/** Tax-owned classification vocabulary; extended only for activated tax cases (#926 F1, J). */
export const TaxClassificationCodeSchema = BoundedIdentifierSchema.pipe(Schema.brand('TaxClassificationCode'));

export type TaxClassificationCode = typeof TaxClassificationCodeSchema.Type;

/** Successful Tax Classification identifying its exact Catalog Selection and material evidence (#926 H). */
export const TaxClassificationSchema = Schema.Struct({
  catalogSelection: CatalogSelectionSchema,
  classificationCode: TaxClassificationCodeSchema,
  completenessEvidenceRef: BoundedIdentifierSchema,
  materialCatalogEvidence: Schema.NonEmptyArray(CurrentCatalogTaxEvidenceSchema),
});

export type TaxClassification = typeof TaxClassificationSchema.Type;
