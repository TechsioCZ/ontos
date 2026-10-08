import { Array as Arr, Match, Order, Result, Schema, pipe } from 'effect';
import type { NonEmptyReadonlyArray } from 'effect/Array';

import { SellingLegalEntityVatRegistrationStateSchema } from './selling-legal-entity-vat-registration.ts';
import type { SellingLegalEntityVatRegistrationState } from './selling-legal-entity-vat-registration.ts';
import { CurrencyCodeSchema } from './tax-domain-primitives.ts';
import { UnsupportedTaxRegimeSchema, taxNotEstablishedOutcome } from './tax-non-success-outcome.ts';
import type { TaxCaseUnsupported, TaxNotEstablishedOutcome, TaxPrerequisiteNotMet } from './tax-non-success-outcome.ts';
import { TaxTreatmentCategorySchema, requireLaunchActivatedTaxTreatment } from './tax-treatment.ts';
import { OccurrenceSupplyMeaningsSchema, mapTaxableSupplyUnits } from './taxable-supply-unit.ts';
import type { TaxableSupplyUnit } from './taxable-supply-unit.ts';

/** Tax regime an exact purchase requires; only ordinary domestic is activated (#918 F2-F3, F28). */
export const RequiredTaxRegimeSchema = Schema.Union([Schema.Literal('ORDINARY_DOMESTIC'), UnsupportedTaxRegimeSchema]);
export type RequiredTaxRegime = typeof RequiredTaxRegimeSchema.Type;

/**
 * Explicit closed-world Launch coverage inputs. Purchasing Subject kind, buyer VAT status, B2B Channel,
 * Counterparty labels and DIČ are not inputs: they never switch ordinary domestic treatment (#918 F9-F12,
 * #923 F1-F2, F13-F16, #924 F7, F11-F14).
 */
export const LaunchTaxCoverageInputSchema = Schema.Struct({
  currency: CurrencyCodeSchema,
  requiredTaxRegimes: Schema.NonEmptyArray(RequiredTaxRegimeSchema),
  requiredTaxTreatments: Schema.NonEmptyArray(TaxTreatmentCategorySchema),
  sellingLegalEntityVatRegistration: SellingLegalEntityVatRegistrationStateSchema,
  supplyMeanings: OccurrenceSupplyMeaningsSchema,
});
export type LaunchTaxCoverageInput = typeof LaunchTaxCoverageInputSchema.Type;

export type LaunchTaxCoverageFailure = TaxCaseUnsupported | TaxPrerequisiteNotMet | TaxNotEstablishedOutcome;

/**
 * Seller prerequisite meaning. Only known ended/non-registered is TAX_PREREQUISITE_NOT_MET; stale, unavailable,
 * unknown and unresolved keep their own non-negative meanings (#938 F7-F15, F20-F28; #918 F13-F16).
 */
const requireCurrentSellerVatRegistration = (
  state: SellingLegalEntityVatRegistrationState,
): Result.Result<void, LaunchTaxCoverageFailure> =>
  Match.value(state).pipe(
    Match.when('CURRENT_POSITIVE', () => Result.void),
    Match.when('KNOWN_ENDED_OR_NON_REGISTERED', () =>
      Result.fail({
        _tag: 'TAX_PREREQUISITE_NOT_MET' as const,
        unmetPrerequisite: 'SELLING_LEGAL_ENTITY_CURRENT_CZ_VAT_REGISTRATION' as const,
      }),
    ),
    Match.orElse((notEstablished) => Result.fail(taxNotEstablishedOutcome(notEstablished))),
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
): Result.Result<NonEmptyReadonlyArray<TaxableSupplyUnit>, LaunchTaxCoverageFailure> =>
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
        requireCurrentSellerVatRegistration(input.sellingLegalEntityVatRegistration),
        Result.map(() => units),
      ),
    ),
  );
