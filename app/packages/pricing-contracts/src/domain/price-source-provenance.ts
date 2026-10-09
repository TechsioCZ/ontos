import { ProductUnitRefSchema } from '@app/catalog/resources/product-unit';
import { Schema } from 'effect';

import { PricingCurrencyCodeSchema, PricingInstantSchema } from '../apis/current-supported-currencies.ts';
import { PriceRefSchema, PriceTenantIdSchema } from '../resources/price.ts';
import {
  PriceIdentityKeySchema,
  PriceNonNegativeDecimalSchema,
  PricePositiveDecimalSchema,
  PriceRevisionIdSchema,
  PriceRevisionNumberSchema,
  priceDecimalValuesEqual,
} from './price-definition.ts';
import { PriceSourceProvenanceRefSchema } from './price-source-ref.ts';

const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());
const checkedUuid = Schema.String.check(Schema.isUUID(), Schema.isTrimmed());
const sourceAssertionIdEquivalence = Schema.toEquivalence(checkedUuid);
const productUnitRefEquivalence = Schema.toEquivalence(ProductUnitRefSchema);

export const PriceSourceAssertionIdSchema = checkedUuid.pipe(
  Schema.brand('PricingPriceSourceAssertionId'),
  Schema.decodeTo(checkedUuid),
);
export type PriceSourceAssertionId = typeof PriceSourceAssertionIdSchema.Type;

export const PriceSourceFactFingerprintSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)).pipe(
  Schema.brand('PricingPriceSourceFactFingerprint'),
  Schema.decodeTo(Schema.String),
);
export type PriceSourceFactFingerprint = typeof PriceSourceFactFingerprintSchema.Type;

export const PriceSourceOwnerModuleIdSchema = stableReference.pipe(
  Schema.brand('PricingPriceSourceOwnerModuleId'),
  Schema.decodeTo(Schema.String),
);
export const PriceSourceActingPrincipalIdSchema = checkedUuid.pipe(
  Schema.brand('PricingPriceSourceActingPrincipalId'),
  Schema.decodeTo(checkedUuid),
);

export const PriceSourceSystemSchema = Schema.Struct({
  ownerModuleId: PriceSourceOwnerModuleIdSchema,
  sourceSystemRef: stableReference,
});
export type PriceSourceSystem = typeof PriceSourceSystemSchema.Type;

export const PriceSourceRecordSchema = Schema.Struct({
  sourceChangeCorrelation: stableReference,
  sourceRecordRef: stableReference,
  sourceRecordVersion: stableReference,
  sourceSystem: PriceSourceSystemSchema,
});
export type PriceSourceRecord = typeof PriceSourceRecordSchema.Type;

export const PriceSourceAuthoritySchema = Schema.Struct({
  sourceAuthorityRef: stableReference,
  sourceAuthorityVersion: stableReference,
});
export type PriceSourceAuthority = typeof PriceSourceAuthoritySchema.Type;

export const PriceSourceMappingSchema = Schema.Struct({
  mappingContractRef: stableReference,
  mappingContractVersion: stableReference,
});
export type PriceSourceMapping = typeof PriceSourceMappingSchema.Type;

export const PriceSourceOriginalAssertionSchema = Schema.Struct({
  monetaryAmount: Schema.Struct({
    amount: PriceNonNegativeDecimalSchema,
    currencyCode: PricingCurrencyCodeSchema,
  }),
  monetaryBoundary: Schema.Literals(['PRE_TAX', 'TAX_INCLUSIVE']),
  unitBasis: Schema.Struct({
    quantity: PricePositiveDecimalSchema,
    unitRef: ProductUnitRefSchema,
  }),
});
export type PriceSourceOriginalAssertion = typeof PriceSourceOriginalAssertionSchema.Type;

export const PriceSourcePreTaxNormalizationSchema = Schema.Struct({
  authority: PriceSourceAuthoritySchema,
  normalizedMonetaryAmount: Schema.Struct({
    amount: PriceNonNegativeDecimalSchema,
    currencyCode: PricingCurrencyCodeSchema,
  }),
});
export type PriceSourcePreTaxNormalization = typeof PriceSourcePreTaxNormalizationSchema.Type;

export const PriceSourceAssertionTimingSchema = Schema.Struct({
  importedAt: PricingInstantSchema,
  ownerBusinessEffectiveAt: PricingInstantSchema,
  sourceEffectiveAt: PricingInstantSchema,
});
export type PriceSourceAssertionTiming = typeof PriceSourceAssertionTimingSchema.Type;

const PriceSourceAssertionInitialLineageSchema = Schema.Struct({ kind: Schema.Literal('INITIAL') });
const PriceSourceAssertionCorrectionLineageSchema = Schema.Struct({
  correctedSourceAssertionId: PriceSourceAssertionIdSchema,
  kind: Schema.Literal('CORRECTION'),
  reason: stableReference,
});
const PriceSourceAssertionSupersessionLineageSchema = Schema.Struct({
  kind: Schema.Literal('SUPERSESSION'),
  reason: stableReference,
  supersededSourceAssertionId: PriceSourceAssertionIdSchema,
});

export const PriceSourceAssertionLineageSchema = Schema.Union([
  PriceSourceAssertionInitialLineageSchema,
  PriceSourceAssertionCorrectionLineageSchema,
  PriceSourceAssertionSupersessionLineageSchema,
]);
export type PriceSourceAssertionLineage = typeof PriceSourceAssertionLineageSchema.Type;

const PriceSourceInitialLineageSchema = Schema.Struct({ kind: Schema.Literal('INITIAL') });
const PriceSourceCorrectionLineageSchema = Schema.Struct({
  actingPrincipalId: PriceSourceActingPrincipalIdSchema,
  ...PriceSourceAssertionCorrectionLineageSchema.fields,
});
const PriceSourceSupersessionLineageSchema = Schema.Struct({
  actingPrincipalId: PriceSourceActingPrincipalIdSchema,
  ...PriceSourceAssertionSupersessionLineageSchema.fields,
});
export const PriceSourceLineageSchema = Schema.Union([
  PriceSourceInitialLineageSchema,
  PriceSourceCorrectionLineageSchema,
  PriceSourceSupersessionLineageSchema,
]);
export type PriceSourceLineage = typeof PriceSourceLineageSchema.Type;

export const PriceSourceAssertionInputSchema = Schema.Struct({
  lineage: PriceSourceAssertionLineageSchema,
  mapping: PriceSourceMappingSchema,
  originalAssertion: PriceSourceOriginalAssertionSchema,
  preTaxNormalization: Schema.optionalKey(PriceSourcePreTaxNormalizationSchema),
  sourceAssertionId: PriceSourceAssertionIdSchema,
  sourceAuthority: PriceSourceAuthoritySchema,
  sourceRecord: PriceSourceRecordSchema,
  timing: PriceSourceAssertionTimingSchema,
}).check(
  Schema.makeFilter(({ lineage, sourceAssertionId }) => {
    if (lineage.kind === 'INITIAL') {
      return [];
    }
    const predecessorId =
      lineage.kind === 'CORRECTION' ? lineage.correctedSourceAssertionId : lineage.supersededSourceAssertionId;
    return sourceAssertionIdEquivalence(sourceAssertionId, predecessorId)
      ? 'Source correction or supersession cannot refer to itself'
      : undefined;
  }),
);
export type PriceSourceAssertionInput = typeof PriceSourceAssertionInputSchema.Type;

/**
 * Canonical stable-fact hash basis. Delivery/import/recorded times, assertion IDs, Action IDs, and
 * request correlation are deliberately absent so replaying one owner fact preserves one identity.
 */
export const PriceSourceFactFingerprintBasisSchema = Schema.Struct({
  mapping: PriceSourceMappingSchema,
  originalAssertion: PriceSourceOriginalAssertionSchema,
  preTaxNormalization: Schema.optionalKey(PriceSourcePreTaxNormalizationSchema),
  sourceAuthority: PriceSourceAuthoritySchema,
  sourceRecord: PriceSourceRecordSchema,
  timing: Schema.Struct({
    ownerBusinessEffectiveAt: PricingInstantSchema,
    sourceEffectiveAt: PricingInstantSchema,
  }),
});
export type PriceSourceFactFingerprintBasis = typeof PriceSourceFactFingerprintBasisSchema.Type;

export const priceSourceFactFingerprintBasisFrom = (
  assertion: PriceSourceAssertionInput,
): PriceSourceFactFingerprintBasis => {
  const basis = {
    mapping: assertion.mapping,
    originalAssertion: assertion.originalAssertion,
    sourceAuthority: assertion.sourceAuthority,
    sourceRecord: assertion.sourceRecord,
    timing: {
      ownerBusinessEffectiveAt: assertion.timing.ownerBusinessEffectiveAt,
      sourceEffectiveAt: assertion.timing.sourceEffectiveAt,
    },
  };
  return assertion.preTaxNormalization === undefined
    ? basis
    : { ...basis, preTaxNormalization: assertion.preTaxNormalization };
};

/** Owner-recorded evidence. The stable fact fingerprint excludes import, delivery, and recorded times. */
export const PriceSourceEvidenceSchema = Schema.Struct({
  lineage: PriceSourceLineageSchema,
  recordedAt: PricingInstantSchema,
  sourceAssertion: PriceSourceAssertionInputSchema,
  sourceFactFingerprint: PriceSourceFactFingerprintSchema,
  tenantId: PriceTenantIdSchema,
}).check(
  Schema.makeFilter(({ lineage, sourceAssertion }) => {
    const proposed = sourceAssertion.lineage;
    if (lineage.kind !== proposed.kind) {
      return 'Owner-recorded source lineage must preserve the asserted transition kind';
    }
    if (lineage.kind === 'INITIAL' && proposed.kind === 'INITIAL') {
      return [];
    }
    if (lineage.kind === 'CORRECTION' && proposed.kind === 'CORRECTION') {
      return lineage.correctedSourceAssertionId === proposed.correctedSourceAssertionId &&
        lineage.reason === proposed.reason
        ? undefined
        : 'Owner-recorded correction lineage must preserve its asserted predecessor and reason';
    }
    return lineage.kind === 'SUPERSESSION' &&
      proposed.kind === 'SUPERSESSION' &&
      lineage.supersededSourceAssertionId === proposed.supersededSourceAssertionId &&
      lineage.reason === proposed.reason
      ? undefined
      : 'Owner-recorded supersession lineage must preserve its asserted predecessor and reason';
  }),
);
export type PriceSourceEvidence = typeof PriceSourceEvidenceSchema.Type;

export const PriceSourceCanonicalLinkSchema = Schema.Struct({
  effectiveFrom: PricingInstantSchema,
  identityKey: PriceIdentityKeySchema,
  monetaryAmount: Schema.Struct({
    amount: PriceNonNegativeDecimalSchema,
    currencyCode: PricingCurrencyCodeSchema,
  }),
  monetaryBoundary: Schema.Literal('PRE_TAX'),
  priceRef: PriceRefSchema,
  revision: PriceRevisionNumberSchema,
  revisionId: PriceRevisionIdSchema,
}).check(
  Schema.makeFilter(({ identityKey, monetaryAmount, priceRef }) => {
    if (priceRef.tenantId !== identityKey.catalogSelection.productRef.tenantId) {
      return 'Canonical Price reference and identity must belong to the same Tenant';
    }
    return monetaryAmount.currencyCode === identityKey.currencyCode
      ? undefined
      : 'Canonical Price Revision currency must equal its exact Price identity currency';
  }),
);
export type PriceSourceCanonicalLink = typeof PriceSourceCanonicalLinkSchema.Type;

/** Owner-private immutable binding; public Price reads deliberately do not expose this contract. */
export const PriceRevisionProvenanceBindingSchema = Schema.Struct({
  canonicalLink: PriceSourceCanonicalLinkSchema,
  provenanceRef: PriceSourceProvenanceRefSchema,
});
export type PriceRevisionProvenanceBinding = typeof PriceRevisionProvenanceBindingSchema.Type;

export const PriceSourceProvenanceSchema = Schema.Struct({
  canonicalLink: PriceSourceCanonicalLinkSchema,
  evidence: PriceSourceEvidenceSchema,
  provenanceRef: PriceSourceProvenanceRefSchema,
}).check(
  Schema.makeFilter(({ canonicalLink, evidence }) => {
    const { originalAssertion, preTaxNormalization } = evidence.sourceAssertion;
    if (
      canonicalLink.priceRef.tenantId !== evidence.tenantId ||
      canonicalLink.identityKey.catalogSelection.productRef.tenantId !== evidence.tenantId
    ) {
      return 'Source evidence and canonical Price must belong to the same Tenant';
    }
    if (canonicalLink.effectiveFrom !== evidence.sourceAssertion.timing.ownerBusinessEffectiveAt) {
      return 'Canonical Price Revision effectivity must equal the owner business-effective source time';
    }
    if (
      originalAssertion.monetaryAmount.currencyCode !== canonicalLink.identityKey.currencyCode ||
      !productUnitRefEquivalence(originalAssertion.unitBasis.unitRef, canonicalLink.identityKey.unitBasis.unitRef) ||
      !priceDecimalValuesEqual(originalAssertion.unitBasis.quantity, canonicalLink.identityKey.unitBasis.quantity)
    ) {
      return 'Source assertion currency and Unit basis must map to the exact canonical Price key without implicit conversion';
    }
    if (originalAssertion.monetaryBoundary === 'PRE_TAX') {
      return preTaxNormalization === undefined &&
        priceDecimalValuesEqual(originalAssertion.monetaryAmount.amount, canonicalLink.monetaryAmount.amount) &&
        originalAssertion.monetaryAmount.currencyCode === canonicalLink.monetaryAmount.currencyCode
        ? undefined
        : 'Canonical Price must preserve the exact pre-Tax source amount without a second normalization';
    }
    return preTaxNormalization !== undefined &&
      priceDecimalValuesEqual(
        preTaxNormalization.normalizedMonetaryAmount.amount,
        canonicalLink.monetaryAmount.amount,
      ) &&
      preTaxNormalization.normalizedMonetaryAmount.currencyCode === canonicalLink.monetaryAmount.currencyCode
      ? undefined
      : 'A tax-inclusive assertion requires authoritative normalization to the exact canonical pre-Tax amount';
  }),
);
export type PriceSourceProvenance = typeof PriceSourceProvenanceSchema.Type;

export const PriceSourceAssertionInvalidReasonSchema = Schema.Literals([
  'PRODUCT_ONLY_TARGET',
  'MARKET_MISSING',
  'STOREFRONT_AS_PRICE_SELECTOR',
  'VARIANT_AMBIGUOUS',
  'UNIT_AMBIGUOUS',
  'SOURCE_AUTHORITY_REJECTED',
  'MAPPING_REJECTED',
  'CURRENCY_MISMATCH',
]);
export type PriceSourceAssertionInvalidReason = typeof PriceSourceAssertionInvalidReasonSchema.Type;
export const PriceSourceAssertionHeldReasonSchema = Schema.Literals([
  'TARGET_UNRESOLVED',
  'VARIANT_UNRESOLVED',
  'MARKET_UNRESOLVED',
  'UNIT_UNRESOLVED',
  'SOURCE_AUTHORITY_UNRESOLVED',
  'MAPPING_UNRESOLVED',
  'CURRENCY_NOT_SUPPORTED_FOR_TENANT',
  'DUPLICATE_CORRELATION_HELD',
  'AUTHORITATIVE_PRE_TAX_NORMALIZATION_MISSING',
  'CANONICAL_CONFLICT_HELD',
]);
export type PriceSourceAssertionHeldReason = typeof PriceSourceAssertionHeldReasonSchema.Type;
export const PriceSourceAssertionDependencySchema = Schema.Literals([
  'CATALOG',
  'COMMERCE_MARKET_CATALOG',
  'CURRENCY_SUPPORT',
  'SOURCE_AUTHORITY',
  'MAPPING_REGISTRY',
  'PERSISTENCE',
]);
export type PriceSourceAssertionDependency = typeof PriceSourceAssertionDependencySchema.Type;

export const PriceSourceAssertionAcceptedSchema = Schema.Struct({
  outcome: Schema.Literal('PRICE_SOURCE_ASSERTION_CANONICAL_ACCEPTED'),
  provenance: PriceSourceProvenanceSchema,
});
export type PriceSourceAssertionAccepted = typeof PriceSourceAssertionAcceptedSchema.Type;
export const PriceSourceAssertionInvalidSchema = Schema.Struct({
  outcome: Schema.Literal('PRICE_SOURCE_ASSERTION_KNOWN_INVALID'),
  reason: PriceSourceAssertionInvalidReasonSchema,
  sourceAssertionId: PriceSourceAssertionIdSchema,
});
export type PriceSourceAssertionInvalid = typeof PriceSourceAssertionInvalidSchema.Type;
export const PriceSourceAssertionHeldSchema = Schema.Struct({
  outcome: Schema.Literal('PRICE_SOURCE_ASSERTION_UNRESOLVED_HELD'),
  reason: PriceSourceAssertionHeldReasonSchema,
  sourceAssertionId: PriceSourceAssertionIdSchema,
});
export type PriceSourceAssertionHeld = typeof PriceSourceAssertionHeldSchema.Type;
export const PriceSourceAssertionDependencyFailureSchema = Schema.Struct({
  dependency: PriceSourceAssertionDependencySchema,
  outcome: Schema.Literal('PRICE_SOURCE_ASSERTION_DEPENDENCY_UNAVAILABLE'),
  retryable: Schema.Literal(true),
  sourceAssertionId: PriceSourceAssertionIdSchema,
});
export type PriceSourceAssertionDependencyFailure = typeof PriceSourceAssertionDependencyFailureSchema.Type;
export const PriceSourceAssertionAssessmentSchema = Schema.Union([
  PriceSourceAssertionAcceptedSchema,
  PriceSourceAssertionInvalidSchema,
  PriceSourceAssertionHeldSchema,
  PriceSourceAssertionDependencyFailureSchema,
]);
export type PriceSourceAssertionAssessment = typeof PriceSourceAssertionAssessmentSchema.Type;
