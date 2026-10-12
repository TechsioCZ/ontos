import { Match, Option, Result, Schema, pipe } from 'effect';

import { taxNotEstablishedOutcome } from './tax-non-success-outcome.ts';
import type { TaxCaseUnsupported, TaxNotEstablishedOutcome } from './tax-non-success-outcome.ts';
import {
  NotMaterialTaxPlaceFactSchema,
  OwnerResolvedTaxPlaceFactSchema,
} from '../../shared/domain/tax-kernel/tax-jurisdiction.ts';
import type {
  MaterialityDeclaredTaxPlaceFact,
  OwnerResolvedTaxPlaceFact,
  TaxJurisdictionDetermination,
  TaxJurisdictionInput,
  TaxPlaceFact,
} from '../../shared/domain/tax-kernel/tax-jurisdiction.ts';

export {
  TaxJurisdictionDeterminationSchema,
  TaxJurisdictionInputSchema,
} from '../../shared/domain/tax-kernel/tax-jurisdiction.ts';
export type {
  TaxJurisdictionDetermination,
  TaxJurisdictionInput,
} from '../../shared/domain/tax-kernel/tax-jurisdiction.ts';

export type TaxJurisdictionFailure = TaxCaseUnsupported | TaxNotEstablishedOutcome;

const requireEstablishedPlace = (
  fact: TaxPlaceFact,
): Result.Result<OwnerResolvedTaxPlaceFact, TaxNotEstablishedOutcome> =>
  Match.value(fact).pipe(
    Match.tag('OWNER_RESOLVED', (resolved) => Result.succeed(resolved)),
    Match.tag('NOT_ESTABLISHED', ({ state }) => Result.fail(taxNotEstablishedOutcome(state))),
    Match.exhaustive,
  );

/** Owner evidence of a place fact when the case declares it material; none otherwise. */
const materialPlaceEvidence = (
  fact: MaterialityDeclaredTaxPlaceFact,
): Result.Result<Option.Option<string>, TaxNotEstablishedOutcome> =>
  Schema.is(NotMaterialTaxPlaceFactSchema)(fact)
    ? Result.succeed(Option.none())
    : pipe(
        requireEstablishedPlace(fact),
        Result.map(({ ownerEvidenceRef }) => Option.some(ownerEvidenceRef)),
      );

const placeRoles = ['sellingLegalEntity', 'deliveryDestination', 'invoiceRecipient'] as const;

/**
 * Derives Tax Jurisdiction only from owner-resolved material place facts. Any known material place outside Czechia
 * is outside Launch scope; a material place fact that cannot be established gives a typed non-success, never a CZ
 * fallback (#927 F1-F6, F19-F20, H; #937 F40, F52-F53; #938 F3, F20-F28; glossary Tax Jurisdiction). Place roles
 * are checked in a fixed order, so the reported failure never depends on input key order (#927 F16, #938 F41).
 */
export const determineTaxJurisdiction = (
  input: TaxJurisdictionInput,
): Result.Result<TaxJurisdictionDetermination, TaxJurisdictionFailure> => {
  const knownNonCzechPlace = placeRoles.some((role) => {
    const fact = input[role];
    return Schema.is(OwnerResolvedTaxPlaceFactSchema)(fact) && fact.countryCode !== 'CZ';
  });
  return knownNonCzechPlace
    ? Result.fail({ _tag: 'TAX_CASE_UNSUPPORTED', unsupportedRequirement: 'NON_CZECH_DOMESTIC_TAX_PLACE' })
    : pipe(
        Result.all({
          deliveryDestination: materialPlaceEvidence(input.deliveryDestination),
          invoiceRecipient: materialPlaceEvidence(input.invoiceRecipient),
          sellingLegalEntity: requireEstablishedPlace(input.sellingLegalEntity),
        }),
        Result.map(({ deliveryDestination, invoiceRecipient, sellingLegalEntity }): TaxJurisdictionDetermination => ({
          jurisdiction: 'CZ_DOMESTIC',
          placeEvidenceRefs: {
            ...Option.match(deliveryDestination, {
              onNone: () => ({}),
              onSome: (ref) => ({ deliveryDestination: ref }),
            }),
            ...Option.match(invoiceRecipient, { onNone: () => ({}), onSome: (ref) => ({ invoiceRecipient: ref }) }),
            sellingLegalEntity: sellingLegalEntity.ownerEvidenceRef,
          },
        })),
      );
};
