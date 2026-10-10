import { Array as Arr, Match, Order, Result, Schema, pipe } from 'effect';
import type { NonEmptyReadonlyArray } from 'effect/Array';

import { CatalogSelectionSchema, isSameCatalogSelection } from './purchase-binding.ts';
import type { CatalogSelection } from './purchase-binding.ts';
import { BoundedIdentifierSchema, distinctBy } from './tax-domain-primitives.ts';
import { taxNotEstablishedOutcome } from './tax-non-success-outcome.ts';
import type { TaxNotEstablishedOutcome, TaxStateIndeterminate } from './tax-non-success-outcome.ts';

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

/** What a Tax-owned interpretation may see: the exact selection and its verified material evidence only (#926 F7). */
export interface TaxClassificationBasis {
  readonly catalogSelection: CatalogSelection;
  readonly materialCatalogEvidence: NonEmptyReadonlyArray<CurrentCatalogTaxEvidence>;
}

export type TaxClassificationInterpretation = (basis: TaxClassificationBasis) => TaxClassificationCode;

/** Successful Tax Classification identifying its exact Catalog Selection and material evidence (#926 H). */
export const TaxClassificationSchema = Schema.Struct({
  catalogSelection: CatalogSelectionSchema,
  classificationCode: TaxClassificationCodeSchema,
  completenessEvidenceRef: BoundedIdentifierSchema,
  materialCatalogEvidence: Schema.NonEmptyArray(CurrentCatalogTaxEvidenceSchema),
});
export type TaxClassification = typeof TaxClassificationSchema.Type;

export type TaxClassificationFailure = TaxNotEstablishedOutcome;

const byCatalogFactRef = Order.mapInput(Order.String, ({ catalogFactRef }: CatalogTaxEvidence) => catalogFactRef);

const requireUsableEvidence = (
  evidence: CatalogTaxEvidence,
): Result.Result<CurrentCatalogTaxEvidence, TaxClassificationFailure> =>
  Match.value(evidence).pipe(
    Match.tag('CURRENT', (current) => Result.succeed(current)),
    Match.tag('NOT_USABLE', ({ state }) => Result.fail(taxNotEstablishedOutcome(state))),
    Match.exhaustive,
  );

const requireOwnerVerifiedCompleteness = (
  completeness: TaxClassificationInput['materialEvidenceCompleteness'],
): Result.Result<string, TaxStateIndeterminate> =>
  Match.value(completeness).pipe(
    Match.tag('OWNER_VERIFIED_COMPLETE', ({ ownerEvidenceRef }) => Result.succeed(ownerEvidenceRef)),
    Match.tag('NOT_ESTABLISHED', () => Result.fail({ _tag: 'TAX_STATE_INDETERMINATE' as const })),
    Match.exhaustive,
  );

/**
 * Classifies one exact Catalog Selection. Evidence is taken in canonical fact order so technical order never
 * changes the result; any stale, unavailable, conflicting or unverifiable decisive evidence, or a material set
 * without owner-verified completeness, yields a typed non-success instead of a guessed classification
 * (#926 F1-F14, H; #938 F20-F28; #907 F43-F48).
 */
export const classifyCatalogSelection = (
  input: TaxClassificationInput,
  interpret: TaxClassificationInterpretation,
): Result.Result<TaxClassification, TaxClassificationFailure> =>
  pipe(
    Result.all(pipe(Arr.sort(input.materialCatalogEvidence, byCatalogFactRef), Arr.map(requireUsableEvidence))),
    Result.flatMap((materialCatalogEvidence) =>
      pipe(
        requireOwnerVerifiedCompleteness(input.materialEvidenceCompleteness),
        Result.map((completenessEvidenceRef) => {
          const basis = { catalogSelection: input.catalogSelection, materialCatalogEvidence };
          return { ...basis, classificationCode: interpret(basis), completenessEvidenceRef };
        }),
      ),
    ),
  );

const sameMaterialFactRevisions = (
  left: readonly CurrentCatalogTaxEvidence[],
  right: readonly CurrentCatalogTaxEvidence[],
) => {
  const rightRevisions = new Map(right.map((evidence) => [evidence.catalogFactRef, evidence.catalogFactRevisionRef]));
  return (
    left.length === right.length &&
    left.every((evidence) => rightRevisions.get(evidence.catalogFactRef) === evidence.catalogFactRevisionRef)
  );
};

/**
 * True only when both classifications rest on the same exact Catalog Selection and the same material Catalog
 * fact revisions; SKU, display name and evidence order are never compared. `false` means the earlier
 * classification is not automatically Current and TAX must classify again; equivalence across changed revisions
 * requires owner evidence and is not inferred here (#926 F9-F11, H; #907 F50-F51).
 */
export const isSameExactTaxClassificationBasis = (left: TaxClassification, right: TaxClassification): boolean =>
  isSameCatalogSelection(left.catalogSelection, right.catalogSelection) &&
  sameMaterialFactRevisions(left.materialCatalogEvidence, right.materialCatalogEvidence);
