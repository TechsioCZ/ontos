import { Array as Arr, Match, Order, Result, pipe } from 'effect';
import type { NonEmptyReadonlyArray } from 'effect/Array';

import { isSameCatalogSelection } from '../../shared/domain/tax-kernel/purchase-binding.ts';
import type { CatalogSelection } from '../../shared/domain/tax-kernel/purchase-binding.ts';
import { taxNotEstablishedOutcome } from './tax-non-success-outcome.ts';
import type { TaxNotEstablishedOutcome, TaxStateIndeterminate } from './tax-non-success-outcome.ts';
import type {
  CatalogTaxEvidence,
  CurrentCatalogTaxEvidence,
  TaxClassification,
  TaxClassificationCode,
  TaxClassificationInput,
} from '../../shared/domain/tax-kernel/tax-classification.ts';

export {
  TaxClassificationCodeSchema,
  TaxClassificationInputSchema,
} from '../../shared/domain/tax-kernel/tax-classification.ts';
export type {
  CatalogTaxEvidence,
  CurrentCatalogTaxEvidence,
  TaxClassification,
  TaxClassificationInput,
} from '../../shared/domain/tax-kernel/tax-classification.ts';

/** What a Tax-owned interpretation may see: the exact selection and its verified material evidence only (#926 F7). */
export interface TaxClassificationBasis {
  readonly catalogSelection: CatalogSelection;
  readonly materialCatalogEvidence: NonEmptyReadonlyArray<CurrentCatalogTaxEvidence>;
}

export type TaxClassificationInterpretation = (basis: TaxClassificationBasis) => TaxClassificationCode;

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
