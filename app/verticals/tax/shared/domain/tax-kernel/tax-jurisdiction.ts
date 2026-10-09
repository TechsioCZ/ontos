import { Schema } from 'effect';

import { BoundedIdentifierSchema } from './tax-domain-primitives.ts';

/** Launch Tax Jurisdiction is Czech domestic; any other jurisdiction is outside Launch Tax Coverage (#907 F2-F3, F12). */
export const TaxJurisdictionSchema = Schema.Literal('CZ_DOMESTIC');

/** Place fact usable by TAX only as an owner-resolved fact with owner-qualified evidence (#927 F4-F6, H). */
export const OwnerResolvedTaxPlaceFactSchema = Schema.TaggedStruct('OWNER_RESOLVED', {
  countryCode: Schema.String.check(Schema.isPattern(/^[A-Z]{2}$/u)),
  ownerEvidenceRef: BoundedIdentifierSchema,
});

export type OwnerResolvedTaxPlaceFact = typeof OwnerResolvedTaxPlaceFactSchema.Type;

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
export const NotMaterialTaxPlaceFactSchema = Schema.TaggedStruct('NOT_MATERIAL', {});

const MaterialityDeclaredTaxPlaceFactSchema = Schema.Union([TaxPlaceFactSchema, NotMaterialTaxPlaceFactSchema]);

export type MaterialityDeclaredTaxPlaceFact = typeof MaterialityDeclaredTaxPlaceFactSchema.Type;

/**
 * Owner-resolved purchase facts from which TAX derives jurisdiction. The Selling Legal Entity place is always
 * material (#937 F40, #927 F19); Delivery Destination and Invoice Recipient are required only when the case declares
 * them material (#937 F52-F54, #923 F1-F2). The seller prerequisite is Current CZ VAT registration, owned by Launch
 * coverage (#918 F13, #907 F5). Commerce Market, Channel, Storefront, hostname, locale, IP and currency are not
 * inputs (#927 F1-F6, F20; glossary Tax Jurisdiction).
 */
export const TaxJurisdictionInputSchema = Schema.Struct({
  deliveryDestination: MaterialityDeclaredTaxPlaceFactSchema,
  invoiceRecipient: MaterialityDeclaredTaxPlaceFactSchema,
  sellingLegalEntity: TaxPlaceFactSchema,
});

export type TaxJurisdictionInput = typeof TaxJurisdictionInputSchema.Type;

/**
 * Tax-owned jurisdiction determination with the owner evidence of every material place fact; the Selling Legal
 * Entity place evidence is always present (#927 B, F1, F19, H; #937 F40).
 */
export const TaxJurisdictionDeterminationSchema = Schema.Struct({
  jurisdiction: TaxJurisdictionSchema,
  placeEvidenceRefs: Schema.Struct({
    deliveryDestination: Schema.optionalKey(BoundedIdentifierSchema),
    invoiceRecipient: Schema.optionalKey(BoundedIdentifierSchema),
    sellingLegalEntity: BoundedIdentifierSchema,
  }),
});

export type TaxJurisdictionDetermination = typeof TaxJurisdictionDeterminationSchema.Type;
