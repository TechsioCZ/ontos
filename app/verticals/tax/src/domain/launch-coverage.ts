import { Array as Arr, Match, Order, Result, Schema, pipe } from 'effect';
import type { NonEmptyReadonlyArray } from 'effect/Array';

import type { SellerVatRegime, SellerVatRegimeDeclarationRevisionRef } from './seller-vat-regime-timeline.ts';
import { UnsupportedTaxRegimeSchema } from './tax-non-success-outcome.ts';
import type { TaxCaseUnsupported } from './tax-non-success-outcome.ts';
import { requireLaunchActivatedTaxTreatment } from './tax-treatment.ts';
import { mapTaxableSupplyUnits } from './taxable-supply-unit.ts';
import type { TaxableSupplyUnit } from './taxable-supply-unit.ts';
import type { LaunchTaxCoverageInput, RequiredTaxRegime } from '../../shared/domain/tax-kernel/launch-coverage.ts';
import type { SellerVatRegimeSelection } from '../../shared/domain/tax-kernel/seller-vat-regime.ts';

export { LaunchTaxCoverageInputSchema } from '../../shared/domain/tax-kernel/launch-coverage.ts';
export type { LaunchTaxCoverageInput } from '../../shared/domain/tax-kernel/launch-coverage.ts';

/** The seller's state at the relevant instant has no declared VAT Regime (Unit 10 A3). */
export const SellerVatRegimeNotDeclaredSchema = Schema.TaggedStruct('TAX_STATE_INDETERMINATE', {
  reason: Schema.Literal('SELLER_VAT_REGIME_NOT_DECLARED'),
});
export type SellerVatRegimeNotDeclared = typeof SellerVatRegimeNotDeclaredSchema.Type;

export type LaunchTaxCoverageFailure = TaxCaseUnsupported | SellerVatRegimeNotDeclared;

export interface LaunchTaxCoverageResult {
  readonly declarationRevisionRef: SellerVatRegimeDeclarationRevisionRef;
  readonly regime: SellerVatRegime;
  readonly units: NonEmptyReadonlyArray<TaxableSupplyUnit>;
}

/**
 * The seller must have an explicitly declared VAT Regime at the relevant instant; absence is a typed internal
 * failure, stripped of its reason before publication (Unit 10 A3, F10).
 */
const requireDeclaredSellerVatRegime = (
  selection: SellerVatRegimeSelection,
): Result.Result<
  { readonly declarationRevisionRef: SellerVatRegimeDeclarationRevisionRef; readonly regime: SellerVatRegime },
  SellerVatRegimeNotDeclared
> =>
  Match.value(selection).pipe(
    Match.tag('DECLARED', ({ declarationRevisionRef, regime }) => Result.succeed({ declarationRevisionRef, regime })),
    Match.tag('NOT_DECLARED', () =>
      Result.fail(SellerVatRegimeNotDeclaredSchema.make({ reason: 'SELLER_VAT_REGIME_NOT_DECLARED' })),
    ),
    Match.exhaustive,
  );

/** CZK is the Launch currency cutline; foreign Price/FX data never activates another currency (#918 F31-F33). */
const requireLaunchCurrency = (currency: string): Result.Result<void, TaxCaseUnsupported> =>
  currency === 'CZK'
    ? Result.void
    : Result.fail({ _tag: 'TAX_CASE_UNSUPPORTED', unsupportedRequirement: 'NON_CZK_CURRENCY' });

/** The reported unsupported regime is the canonically first one, never the first in input order (#938 F41). */
const requireOrdinaryDomesticRegime = (
  regimes: NonEmptyReadonlyArray<RequiredTaxRegime>,
): Result.Result<void, TaxCaseUnsupported> => {
  const [unsupported] = Arr.sort(regimes.filter(Schema.is(UnsupportedTaxRegimeSchema)), Order.String);
  return unsupported === undefined
    ? Result.void
    : Result.fail({ _tag: 'TAX_CASE_UNSUPPORTED', unsupportedRequirement: unsupported });
};

/**
 * Closed-world Launch Tax Coverage over explicit inputs (#918 F1-F42). Scope is decided before the seller
 * prerequisite, so a known-negative seller is reported only for an otherwise supported case (#938 F7). Required
 * treatments are checked in canonical order, so input order never changes the outcome (#938 F41). There is no
 * domestic or standard-rate fallback (#918 F29-F30).
 */
export const evaluateLaunchTaxCoverage = (
  input: LaunchTaxCoverageInput,
): Result.Result<LaunchTaxCoverageResult, LaunchTaxCoverageFailure> =>
  pipe(
    requireLaunchCurrency(input.currency),
    Result.flatMap(() => requireOrdinaryDomesticRegime(input.requiredTaxRegimes)),
    Result.flatMap(() =>
      Result.all(
        pipe(Arr.sort(input.requiredTaxTreatments, Order.String), Arr.map(requireLaunchActivatedTaxTreatment)),
      ),
    ),
    Result.flatMap(() => mapTaxableSupplyUnits(input.supplyMeanings)),
    Result.flatMap((units) =>
      pipe(
        requireDeclaredSellerVatRegime(input.sellerVatRegime),
        Result.map(({ declarationRevisionRef, regime }) => ({ declarationRevisionRef, regime, units })),
      ),
    ),
  );
