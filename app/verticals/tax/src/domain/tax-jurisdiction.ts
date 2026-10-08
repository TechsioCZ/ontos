import { Match, Option, Result, Schema, pipe } from 'effect';

import { BoundedIdentifierSchema } from './tax-domain-primitives.ts';
import { taxNotEstablishedOutcome } from './tax-non-success-outcome.ts';
import type { TaxCaseUnsupported, TaxNotEstablishedOutcome } from './tax-non-success-outcome.ts';

/** Launch Tax Jurisdiction is Czech domestic; any other jurisdiction is outside Launch Tax Coverage (#907 F2-F3, F12). */
export const TaxJurisdictionSchema = Schema.Literal('CZ_DOMESTIC');
export type TaxJurisdiction = typeof TaxJurisdictionSchema.Type;

/** Place fact usable by TAX only as an owner-resolved fact with owner-qualified evidence (#927 F4-F6, H). */
const OwnerResolvedTaxPlaceFactSchema = Schema.TaggedStruct('OWNER_RESOLVED', {
  countryCode: Schema.String.check(Schema.isPattern(/^[A-Z]{2}$/u)),
  ownerEvidenceRef: BoundedIdentifierSchema,
});
type OwnerResolvedTaxPlaceFact = typeof OwnerResolvedTaxPlaceFactSchema.Type;

/** Required place fact whose Current owner result cannot be established (#927 F19, #938 F20-F28). */
const NotEstablishedTaxPlaceFactSchema = Schema.TaggedStruct('NOT_ESTABLISHED', {
  state: Schema.Literals(['STALE', 'UNAVAILABLE', 'UNKNOWN', 'UNRESOLVED']),
});

/** One authoritative tax-place fact; raw client address input is not representable (#927 F4). */
export const TaxPlaceFactSchema = Schema.Union([OwnerResolvedTaxPlaceFactSchema, NotEstablishedTaxPlaceFactSchema]);
export type TaxPlaceFact = typeof TaxPlaceFactSchema.Type;

/**
 * Explicit declaration that the activated Tax semantics of this case do not use the place fact; it is then neither
 * required nor material (#937 F52-F54).
 */
const NotMaterialTaxPlaceFactSchema = Schema.TaggedStruct('NOT_MATERIAL', {});

/**
 * Owner-resolved purchase facts from which TAX derives jurisdiction. The Selling Legal Entity place is always
 * required; Delivery Destination and Invoice Recipient are required only when the case declares them material
 * (#937 F52-F54, #923 F1-F2). Commerce Market, Channel, Storefront, hostname, locale, IP and currency are not
 * inputs (#927 F1-F6, F20; glossary Tax Jurisdiction).
 */
export const TaxJurisdictionInputSchema = Schema.Struct({
  deliveryDestination: Schema.Union([TaxPlaceFactSchema, NotMaterialTaxPlaceFactSchema]),
  invoiceRecipient: Schema.Union([TaxPlaceFactSchema, NotMaterialTaxPlaceFactSchema]),
  sellingLegalEntity: TaxPlaceFactSchema,
});
export type TaxJurisdictionInput = typeof TaxJurisdictionInputSchema.Type;

/** Tax-owned jurisdiction determination with the owner evidence of every material place fact (#927 B, F1, H). */
export const TaxJurisdictionDeterminationSchema = Schema.Struct({
  jurisdiction: TaxJurisdictionSchema,
  placeEvidenceRefs: Schema.Struct({
    deliveryDestination: Schema.optionalKey(BoundedIdentifierSchema),
    invoiceRecipient: Schema.optionalKey(BoundedIdentifierSchema),
    sellingLegalEntity: BoundedIdentifierSchema,
  }),
});
export type TaxJurisdictionDetermination = typeof TaxJurisdictionDeterminationSchema.Type;

export type TaxJurisdictionFailure = TaxCaseUnsupported | TaxNotEstablishedOutcome;

type MaterialityDeclaredPlaceFact = TaxJurisdictionInput['deliveryDestination'];

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
  fact: MaterialityDeclaredPlaceFact,
): Result.Result<Option.Option<string>, TaxNotEstablishedOutcome> =>
  Schema.is(NotMaterialTaxPlaceFactSchema)(fact)
    ? Result.succeed(Option.none())
    : pipe(
        requireEstablishedPlace(fact),
        Result.map(({ ownerEvidenceRef }) => Option.some(ownerEvidenceRef)),
      );

interface PlaceEvidenceRefs {
  deliveryDestination?: string;
  invoiceRecipient?: string;
  sellingLegalEntity: string;
}

/**
 * Derives Tax Jurisdiction only from owner-resolved material place facts. Any known material place outside Czechia
 * is outside Launch scope; a material place fact that cannot be established gives a typed non-success, never a CZ
 * fallback (#927 F1-F6, F19-F20; #937 F52-F53; #938 F3, F20-F28; glossary Tax Jurisdiction). Place roles are
 * checked in a fixed order, so the reported failure never depends on input key order (#927 F16, #938 F41).
 */
export const determineTaxJurisdiction = (
  input: TaxJurisdictionInput,
): Result.Result<TaxJurisdictionDetermination, TaxJurisdictionFailure> => {
  const knownNonCzechPlace = [input.sellingLegalEntity, input.deliveryDestination, input.invoiceRecipient].some(
    (fact) => Schema.is(OwnerResolvedTaxPlaceFactSchema)(fact) && fact.countryCode !== 'CZ',
  );
  return knownNonCzechPlace
    ? Result.fail({ _tag: 'TAX_CASE_UNSUPPORTED', unsupportedRequirement: 'NON_CZECH_DOMESTIC_TAX_PLACE' })
    : pipe(
        Result.all({
          deliveryDestination: materialPlaceEvidence(input.deliveryDestination),
          invoiceRecipient: materialPlaceEvidence(input.invoiceRecipient),
          sellingLegalEntity: requireEstablishedPlace(input.sellingLegalEntity),
        }),
        Result.map(({ deliveryDestination, invoiceRecipient, sellingLegalEntity }) => {
          const placeEvidenceRefs: PlaceEvidenceRefs = { sellingLegalEntity: sellingLegalEntity.ownerEvidenceRef };
          if (Option.isSome(deliveryDestination)) {
            placeEvidenceRefs.deliveryDestination = deliveryDestination.value;
          }
          if (Option.isSome(invoiceRecipient)) {
            placeEvidenceRefs.invoiceRecipient = invoiceRecipient.value;
          }
          return { jurisdiction: 'CZ_DOMESTIC' as const, placeEvidenceRefs };
        }),
      );
};
