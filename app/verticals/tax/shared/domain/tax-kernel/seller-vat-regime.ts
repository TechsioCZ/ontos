import { Schema } from 'effect';

import { RevisionSchema } from './tax-domain-primitives.ts';

/**
 * Seller VAT Regime at an instant: Czech VAT payer or non-payer. The seller is the Decision's
 * `purchaseBinding.sellingLegalEntityRef` (Unit 10, #950 G).
 */
export const SellerVatRegimeSchema = Schema.Literals(['VAT_PAYER', 'NON_PAYER']);
export type SellerVatRegime = typeof SellerVatRegimeSchema.Type;

/** Exact declaration revision a Decision or Terms depend on. */
export const SellerVatRegimeDeclarationRevisionRefSchema = Schema.Struct({
  revision: RevisionSchema,
});
export type SellerVatRegimeDeclarationRevisionRef = typeof SellerVatRegimeDeclarationRevisionRefSchema.Type;

/** The seller has an exact declared regime at an exact revision. */
export const SellerVatRegimeDeclaredSchema = Schema.TaggedStruct('DECLARED', {
  declarationRevisionRef: SellerVatRegimeDeclarationRevisionRefSchema,
  regime: SellerVatRegimeSchema,
});

/** Nothing was ever declared for the seller. */
export const SellerVatRegimeNotDeclaredStateSchema = Schema.TaggedStruct('NOT_DECLARED', {});

/**
 * The seller's declared state at one instant: either a declared regime at an exact revision, or nothing ever
 * declared. Never a nullable boolean (Unit 10 A1).
 */
export const SellerVatRegimeSelectionSchema = Schema.Union([
  SellerVatRegimeDeclaredSchema,
  SellerVatRegimeNotDeclaredStateSchema,
]);
export type SellerVatRegimeSelection = typeof SellerVatRegimeSelectionSchema.Type;

/**
 * How a declaration revision came to exist: merchant-declared through the Action, or imported during migration.
 * `MIGRATED` is declared here as part of the domain vocabulary (#907 Unit 10 step 9), but nothing in this vertical
 * writes it yet: step 9 only establishes the domain shape, and the step-9 migration cutover that would actually
 * import `MIGRATED` rows is a later P6 concern tracked outside this unit.
 */
export const SellerVatRegimeDeclarationProvenanceSchema = Schema.Literals(['MERCHANT_DECLARED', 'MIGRATED']);
export type SellerVatRegimeDeclarationProvenance = typeof SellerVatRegimeDeclarationProvenanceSchema.Type;

/** The declaration row's own primary key; branded so it is never interchangeable with another identifier (audit
 * A2). */
export const TaxSellerVatRegimeDeclarationIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('TaxSellerVatRegimeDeclarationId'),
  Schema.decodeTo(Schema.String),
);

/** One replaced revision's own row identity, persisted verbatim at insert time (#943/#955 F-replay). Decoded from
 * the DB jsonb column at read time; never trusted as the drizzle `$type<>` cast alone. */
export const ReplacedScheduledSellerVatRegimeDeclarationSchema = Schema.Struct({
  revision: RevisionSchema,
  taxSellerVatRegimeDeclarationId: TaxSellerVatRegimeDeclarationIdSchema,
});

/** Code-versioned legal basis for the non-payer treatment; never inferred from a date alone (LEGAL §1). */
export const SELLER_NOT_VAT_PAYER_LEGAL_BASIS = {
  reference: 'ZDPH § 50 odst. 1 (461/2024 Sb., účinnost 1. 1. 2025)',
  revision: 1,
} as const;

export const SellerNotVatPayerLegalBasisSchema = Schema.Struct({
  reference: Schema.Literal(SELLER_NOT_VAT_PAYER_LEGAL_BASIS.reference),
  revision: Schema.Literal(SELLER_NOT_VAT_PAYER_LEGAL_BASIS.revision),
});
