import { Schema } from 'effect';

import { CurrentSupportedCurrenciesResponseSchema } from '../apis/current-supported-currencies.ts';
import { ExactPriceLookupAbsentSchema } from './exact-price-lookup.ts';
import { ExactPriceResolutionInputSchema } from './exact-price-resolution.ts';
import { PriceIdentityKeySchema } from './price-definition.ts';
import { PriceGroupAssignmentResolutionResponseSchema } from './price-group-interpretation.ts';
import { PriceGroupFallbackResolutionInputSchema, PriceGroupFallbackResolutionSchema } from './price-group-fallback.ts';
import {
  PriceSourceAssertionAssessmentSchema,
  PriceSourceAssertionHeldSchema,
  PriceSourceAssertionHeldReasonSchema,
} from './price-source-provenance.ts';
import { PricingCurrencyCodeSchema, PricingInstantSchema, PricingTenantIdSchema } from './currency-support.ts';
import { PricingQuantityBasisAssessmentSchema } from './quantity-unit-package-basis.ts';

const safeEvidenceReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512), Schema.isTrimmed());

const distinctEvidenceReferences = Schema.Array(safeEvidenceReference).check(
  Schema.isMaxLength(32),
  Schema.makeFilter((references) =>
    new Set(references).size === references.length ? undefined : 'Evidence references must be distinct',
  ),
);

const priceIdentityKeyEquivalence = Schema.toEquivalence(PriceIdentityKeySchema);
const exactAbsenceEquivalence = Schema.toEquivalence(ExactPriceLookupAbsentSchema);
const OwnerNoneTagSchema = Schema.Struct({ resolution: Schema.TaggedStruct('NONE', {}) });
const NoApplicablePriceTagSchema = Schema.TaggedStruct('NO_APPLICABLE_PRICE', {});
const CurrencySupportConflictTagSchema = Schema.Struct({
  code: Schema.Literal('pricing_currency_support_revision_conflict'),
  outcome: Schema.Literal('SUPPORTED_CURRENCIES_INVALID'),
});
const PriceGroupInconsistentInputTagSchema = Schema.TaggedStruct('BLOCKED', {
  interpretation: Schema.TaggedStruct('INCONSISTENT', {}),
});

/** The bounded Pricing-owned subjects that can prevent an exact candidate from being evaluated. */
export const PricingExplicitInputSubjectSchema = Schema.Literals([
  'PRICE_GROUP_ASSIGNMENT',
  'PRICE_GROUP_DEFINITION',
  'CATALOG_SELECTION',
  'COMMERCIAL_SCOPE',
  'CURRENCY_SUPPORT',
  'EXACT_PRICE',
  'QUANTITY_BASIS',
  'QUANTITY_TIER',
  'DISCOUNT',
  'COMMERCIAL_FEE',
  'ZERO_FLOOR_AUTHORIZATION',
  'SOURCE_ASSERTION',
]);
export type PricingExplicitInputSubject = typeof PricingExplicitInputSubjectSchema.Type;

export const PricingExplicitConfigurationReasonSchema = Schema.Literals([
  'BROKEN_PRICE_GROUP_ASSIGNMENT',
  'MISSING_EXACT_VARIANT',
  'MISSING_COMMERCE_MARKET',
  'INVALID_VARIANT_PARENTAGE',
  'INVALID_SELLER_CHANNEL_MARKET_COMBINATION',
  'UNSUPPORTED_CURRENCY',
  'CURRENCY_SUPPORT_NOT_INITIALIZED',
  'INCOMPATIBLE_QUANTITY_UNIT',
  'INCOMPATIBLE_PRICING_BASIS',
  'INVALID_SIGN_OR_RANGE',
  'INVALID_CONTRIBUTION_EFFECT',
  'INVALID_CANONICAL_CONFIGURATION',
  'PRODUCT_ONLY_PRICE_TARGET',
  'STOREFRONT_PRICE_SELECTOR_FORBIDDEN',
  'CROSS_CURRENCY_SUBSTITUTION_FORBIDDEN',
  'GROSS_ONLY_CANONICAL_PRICE',
  'ZERO_FLOOR_SCOPE_MISMATCH',
  'ZERO_FLOOR_EFFECTIVE_PERIOD_MISMATCH',
  'ZERO_FLOOR_ECONOMIC_ENVELOPE_MISMATCH',
]);
export type PricingExplicitConfigurationReason = typeof PricingExplicitConfigurationReasonSchema.Type;

export const PricingExplicitConflictReasonSchema = Schema.Literals([
  'INCONSISTENT_PRICE_GROUP_ASSIGNMENT',
  'COMPETING_CURRENT_EXACT_PRICES',
  'COMPETING_CURRENT_CURRENCY_SUPPORT',
  'CANONICAL_STATE_CONFLICT',
]);
export type PricingExplicitConflictReason = typeof PricingExplicitConflictReasonSchema.Type;

export const PricingExplicitStaleReasonSchema = Schema.Literals([
  'INPUT_REVISION_STALE',
  'PRICE_REVISION_STALE',
  'PROOF_STALE',
  'APPLICABILITY_BOUNDARY_CROSSED',
  'AUTHORIZATION_STALE',
  'MATERIAL_INPUT_CHANGED',
]);
export type PricingExplicitStaleReason = typeof PricingExplicitStaleReasonSchema.Type;

export const PricingExplicitIndeterminateReasonSchema = Schema.Literals([
  'PRICE_GROUP_OWNER_UNAVAILABLE',
  'PRICE_GROUP_OWNER_UNVERIFIABLE',
  'CATALOG_OWNER_UNAVAILABLE',
  'CATALOG_OWNER_UNVERIFIABLE',
  'COMMERCIAL_SCOPE_UNAVAILABLE',
  'COMMERCIAL_SCOPE_UNVERIFIABLE',
  'CURRENCY_SUPPORT_UNAVAILABLE',
  'CURRENCY_SUPPORT_UNVERIFIABLE',
  'EXACT_PRICE_STATE_UNAVAILABLE',
  'EXACT_PRICE_STATE_UNVERIFIABLE',
  'QUANTITY_BASIS_UNAVAILABLE',
  'QUANTITY_BASIS_UNVERIFIABLE',
  'REQUIRED_TIER_STATE_UNVERIFIABLE',
  'REQUIRED_DISCOUNT_STATE_UNVERIFIABLE',
  'REQUIRED_FEE_STATE_UNVERIFIABLE',
  'REQUIRED_ZERO_FLOOR_STATE_UNVERIFIABLE',
  'CURRENTNESS_UNVERIFIABLE',
  'SET_COMPLETENESS_UNVERIFIABLE',
]);
export type PricingExplicitIndeterminateReason = typeof PricingExplicitIndeterminateReasonSchema.Type;

export const PricingHeldAssertionReasonSchema = PriceSourceAssertionHeldReasonSchema;
export type PricingHeldAssertionReason = typeof PricingHeldAssertionReasonSchema.Type;

export const PricingExplicitInputContextSchema = Schema.Struct({
  effectiveAt: PricingInstantSchema,
  exactKey: Schema.optionalKey(PriceIdentityKeySchema),
  requestedCurrencyCode: PricingCurrencyCodeSchema,
  tenantId: PricingTenantIdSchema,
}).check(
  Schema.makeFilter(({ exactKey, requestedCurrencyCode }) =>
    exactKey === undefined || exactKey.currencyCode === requestedCurrencyCode
      ? undefined
      : 'Explicit Pricing input must preserve one native currency across the request and exact Price key',
  ),
);
export type PricingExplicitInputContext = typeof PricingExplicitInputContextSchema.Type;

export const PricingKnownInvalidExplicitInputSchema = Schema.TaggedStruct('KNOWN_INVALID', {
  context: PricingExplicitInputContextSchema,
  evidenceRefs: distinctEvidenceReferences,
  outcome: Schema.Literal('PRICING_CONFIGURATION_ERROR'),
  reason: PricingExplicitConfigurationReasonSchema,
  retryable: Schema.Literal(false),
  subject: PricingExplicitInputSubjectSchema,
});
export type PricingKnownInvalidExplicitInput = typeof PricingKnownInvalidExplicitInputSchema.Type;

export const PricingExplicitInputConflictSchema = Schema.TaggedStruct('CONFLICT', {
  context: PricingExplicitInputContextSchema,
  currentTruthRefs: distinctEvidenceReferences.check(Schema.isMinLength(2)),
  outcome: Schema.Literal('PRICING_CONFLICT'),
  reason: PricingExplicitConflictReasonSchema,
  retryable: Schema.Literal(false),
  subject: PricingExplicitInputSubjectSchema,
});
export type PricingExplicitInputConflict = typeof PricingExplicitInputConflictSchema.Type;

export const PricingExplicitInputStaleSchema = Schema.TaggedStruct('STALE', {
  context: PricingExplicitInputContextSchema,
  outcome: Schema.Literal('PRICING_STALE'),
  reason: PricingExplicitStaleReasonSchema,
  retryable: Schema.Literal(true),
  staleEvidence: Schema.Struct({
    assessedAt: PricingInstantSchema,
    invalidatedAt: PricingInstantSchema,
    invalidatedRevision: safeEvidenceReference,
  }),
  subject: PricingExplicitInputSubjectSchema,
}).check(
  Schema.makeFilter(({ staleEvidence }) =>
    staleEvidence.invalidatedAt > staleEvidence.assessedAt
      ? undefined
      : 'Stale input evidence requires a later material invalidation',
  ),
);
export type PricingExplicitInputStale = typeof PricingExplicitInputStaleSchema.Type;

export const PricingExplicitInputDependencyOwnerSchema = Schema.Literals([
  'CATALOG',
  'COMMERCE_MARKET_CATALOG',
  'COMMERCE_CUSTOMER_CONTEXT',
  'PRICE_GROUP_CATALOG',
  'PRICING_CURRENCY_SUPPORT',
  'PRICING_EXACT_PRICE',
  'PRICING_QUANTITY_TIER',
  'PRICING_DISCOUNT',
  'PRICING_COMMERCIAL_FEE',
  'PRICING_ZERO_FLOOR',
  'PRICING_SOURCE_PROVENANCE',
]);
export type PricingExplicitInputDependencyOwner = typeof PricingExplicitInputDependencyOwnerSchema.Type;

const distinctDependencyOwners = Schema.Array(PricingExplicitInputDependencyOwnerSchema).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(12),
  Schema.makeFilter((owners) =>
    new Set(owners).size === owners.length ? undefined : 'Required dependency owners must be distinct',
  ),
);

export const PricingExplicitInputIndeterminateSchema = Schema.TaggedStruct('INDETERMINATE', {
  context: PricingExplicitInputContextSchema,
  inabilityEvidence: Schema.Struct({
    attempts: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
    evidenceRefs: distinctEvidenceReferences,
    requiredOwners: distinctDependencyOwners,
  }),
  outcome: Schema.Literal('PRICING_INDETERMINATE'),
  reason: PricingExplicitIndeterminateReasonSchema,
  retryable: Schema.Literal(true),
  subject: PricingExplicitInputSubjectSchema,
});
export type PricingExplicitInputIndeterminate = typeof PricingExplicitInputIndeterminateSchema.Type;

/**
 * An unresolved source assertion remains evidence for reconciliation only. It is never promoted to
 * a canonical Price and never permits reverse-Tax, cross-currency, or broader-key fallback.
 */
export const PricingNonCanonicalAssertionHeldSchema = Schema.TaggedStruct('NON_CANONICAL_ASSERTION_HELD', {
  assessment: PriceSourceAssertionHeldSchema,
  context: PricingExplicitInputContextSchema,
  outcome: Schema.Literal('PRICING_INDETERMINATE'),
  reason: PricingHeldAssertionReasonSchema,
  retryable: Schema.Literal(true),
  subject: Schema.Literal('SOURCE_ASSERTION'),
}).check(
  Schema.makeFilter(({ assessment, reason }) =>
    assessment.reason === reason ? undefined : 'Held source reason must preserve the owner assessment reason',
  ),
);
export type PricingNonCanonicalAssertionHeld = typeof PricingNonCanonicalAssertionHeldSchema.Type;

const OwnerNoneResolutionSchema = PriceGroupAssignmentResolutionResponseSchema.check(
  Schema.makeFilter(({ resolution }) =>
    Schema.is(OwnerNoneTagSchema)({ resolution })
      ? undefined
      : 'Legitimate Price Group absence requires owner-issued NONE evidence',
  ),
);

export const PricingLegitimateGroupAbsenceSchema = Schema.TaggedStruct('LEGITIMATE_GROUP_ABSENCE', {
  context: PricingExplicitInputContextSchema,
  continuation: Schema.Literal('TRY_EXACT_NO_GROUP_PRICE'),
  ownerResolution: OwnerNoneResolutionSchema,
}).check(
  Schema.makeFilter(({ context, ownerResolution }) =>
    ownerResolution.effectiveAt === context.effectiveAt && ownerResolution.profile.tenantId === context.tenantId
      ? undefined
      : 'Legitimate Price Group absence evidence must bind the evaluated Tenant and instant',
  ),
);
export type PricingLegitimateGroupAbsence = typeof PricingLegitimateGroupAbsenceSchema.Type;

const CompleteNoApplicablePricePathSchema = PriceGroupFallbackResolutionSchema.check(
  Schema.makeFilter((resolution) =>
    Schema.is(NoApplicablePriceTagSchema)(resolution)
      ? undefined
      : 'No-applicable-Price requires complete allowed exact-path absence evidence',
  ),
);

export const PricingLegitimateExactPathAbsenceSchema = Schema.TaggedStruct('LEGITIMATE_EXACT_PATH_ABSENCE', {
  context: PricingExplicitInputContextSchema,
  exactAbsence: ExactPriceLookupAbsentSchema,
  outcome: Schema.Literal('NO_APPLICABLE_PRICE'),
  path: CompleteNoApplicablePricePathSchema,
  retryable: Schema.Literal(false),
}).check(
  Schema.makeFilter(({ context, exactAbsence, path }) => {
    if (!Schema.is(NoApplicablePriceTagSchema)(path)) {
      return 'Exact-path absence must retain the complete no-applicable-Price path';
    }
    const absenceKey = exactAbsence.request.exactKey;
    if (
      exactAbsence.request.effectiveAt !== context.effectiveAt ||
      absenceKey.catalogSelection.productRef.tenantId !== context.tenantId ||
      absenceKey.currencyCode !== context.requestedCurrencyCode ||
      (context.exactKey !== undefined && !priceIdentityKeyEquivalence(context.exactKey, absenceKey))
    ) {
      return 'Exact-path absence evidence must bind the evaluated Tenant, instant, currency, and exact key';
    }
    return exactAbsenceEquivalence(exactAbsence, path.noGroupAbsence) ||
      (path.groupAbsence !== undefined && exactAbsenceEquivalence(exactAbsence, path.groupAbsence))
      ? undefined
      : 'Exact-path absence evidence must be one of the retained complete-path lookups';
  }),
);
export type PricingLegitimateExactPathAbsence = typeof PricingLegitimateExactPathAbsenceSchema.Type;

export const PricingExplicitInputClassificationSchema = Schema.Union([
  PricingKnownInvalidExplicitInputSchema,
  PricingExplicitInputConflictSchema,
  PricingExplicitInputStaleSchema,
  PricingExplicitInputIndeterminateSchema,
  PricingNonCanonicalAssertionHeldSchema,
  PricingLegitimateGroupAbsenceSchema,
  PricingLegitimateExactPathAbsenceSchema,
]);
export type PricingExplicitInputClassification = typeof PricingExplicitInputClassificationSchema.Type;

/**
 * Owner-local trusted observations consumed by the classification runtime. This schema is never a
 * public HTTP request: callers may provide only `PricingExplicitInputContextSchema`, and the owner
 * resolves these observations itself. Optional observations are intentionally not absence; the
 * runtime must emit an indeterminate result when a required owner observation is missing.
 */
export const PricingExplicitInputEvaluationRequestSchema = Schema.Struct({
  context: PricingExplicitInputContextSchema,
  currencySupport: Schema.optionalKey(CurrentSupportedCurrenciesResponseSchema),
  currencySupportConflictRefs: Schema.optionalKey(distinctEvidenceReferences.check(Schema.isMinLength(2))),
  priceGroupConflictRefs: Schema.optionalKey(distinctEvidenceReferences.check(Schema.isMinLength(2))),
  priceGroupResolutionInput: Schema.optionalKey(PriceGroupFallbackResolutionInputSchema),
  quantityBasis: Schema.optionalKey(PricingQuantityBasisAssessmentSchema),
  sourceAssessment: Schema.optionalKey(PriceSourceAssertionAssessmentSchema),
}).check(
  Schema.makeFilter(({ currencySupport, currencySupportConflictRefs }) =>
    currencySupportConflictRefs === undefined ||
    (currencySupport !== undefined && Schema.is(CurrencySupportConflictTagSchema)(currencySupport))
      ? undefined
      : 'Currency-support conflict claimants require the owner conflict response they explain',
  ),
  Schema.makeFilter(({ priceGroupConflictRefs, priceGroupResolutionInput }) =>
    priceGroupConflictRefs === undefined ||
    (priceGroupResolutionInput !== undefined &&
      Schema.is(PriceGroupInconsistentInputTagSchema)(priceGroupResolutionInput))
      ? undefined
      : 'Price Group conflict claimants require the blocked inconsistent owner resolution they explain',
  ),
);
export type PricingExplicitInputEvaluationRequest = typeof PricingExplicitInputEvaluationRequestSchema.Type;

export const PricingExplicitInputReadySchema = Schema.TaggedStruct('READY', {
  exactResolutionInput: ExactPriceResolutionInputSchema,
});
export type PricingExplicitInputReady = typeof PricingExplicitInputReadySchema.Type;

/** Owner-local result; public transports must map it to a bounded sanitized response. */
export const PricingExplicitInputEvaluationResultSchema = Schema.Union([
  PricingExplicitInputReadySchema,
  PricingExplicitInputClassificationSchema,
]);
export type PricingExplicitInputEvaluationResult = typeof PricingExplicitInputEvaluationResultSchema.Type;
