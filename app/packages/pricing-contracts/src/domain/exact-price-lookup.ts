import { Schema } from 'effect';

import { PriceRefSchema } from '../resources/price.ts';
import { PricingInstantSchema } from './currency-support.ts';
import {
  PriceIdentityKeySchema,
  PriceRevisionIdSchema,
  PriceRevisionSchema,
  priceDecimalValuesEqual,
} from './price-definition.ts';
import { PriceEffectivePeriodSchema, PriceScheduleRevisionSchema } from './price-schedule.ts';
import { PriceSourceProvenanceRefSchema } from './price-source-ref.ts';

const nonEmptyTrimmedString = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());

/** Owner-local request for one exact Price identity at one trusted evaluation instant. */
export const ExactPriceLookupRequestSchema = Schema.Struct({
  effectiveAt: PricingInstantSchema,
  exactKey: PriceIdentityKeySchema,
});
export type ExactPriceLookupRequest = typeof ExactPriceLookupRequestSchema.Type;

/**
 * Owner-issued proof that the complete exact-key Current set was evaluated. `ownerRevision`
 * identifies that material read set; it is deliberately not a Price Revision identifier.
 */
export const ExactPriceLookupCurrentEvidenceSchema = Schema.Struct({
  effectiveAt: PricingInstantSchema,
  nextApplicabilityBoundary: Schema.optionalKey(PricingInstantSchema),
  observedAt: PricingInstantSchema,
  ownerRevision: nonEmptyTrimmedString,
}).check(
  Schema.makeFilter(({ effectiveAt, nextApplicabilityBoundary, observedAt }) => {
    if (observedAt < effectiveAt) {
      return 'Current Price evidence cannot predate the evaluated instant';
    }
    return nextApplicabilityBoundary === undefined || nextApplicabilityBoundary > observedAt
      ? undefined
      : 'The next Price applicability boundary must follow the source observation';
  }),
);
export type ExactPriceLookupCurrentEvidence = typeof ExactPriceLookupCurrentEvidenceSchema.Type;

export const ExactPriceLookupFoundSchema = Schema.TaggedStruct('FOUND', {
  evidence: ExactPriceLookupCurrentEvidenceSchema,
  priceRef: PriceRefSchema,
  priceRevision: PriceRevisionSchema,
  request: ExactPriceLookupRequestSchema,
}).check(
  Schema.makeFilter(({ evidence, priceRef, priceRevision, request }) => {
    if (evidence.effectiveAt !== request.effectiveAt) {
      return 'Resolved Price evidence must apply to the lookup instant';
    }
    if (
      priceRef.tenantId !== request.exactKey.catalogSelection.productRef.tenantId ||
      priceRevision.monetaryAmount.currencyCode !== request.exactKey.currencyCode
    ) {
      return 'Resolved Price must preserve the lookup Tenant and native currency';
    }
    return priceRevision.effectiveFrom <= request.effectiveAt
      ? undefined
      : 'Resolved Price Revision cannot begin after the lookup instant';
  }),
);
export type ExactPriceLookupFound = typeof ExactPriceLookupFoundSchema.Type;

export const ExactPriceLookupAbsentSchema = Schema.TaggedStruct('ABSENT', {
  evidence: ExactPriceLookupCurrentEvidenceSchema,
  request: ExactPriceLookupRequestSchema,
}).check(
  Schema.makeFilter(({ evidence, request }) =>
    evidence.effectiveAt === request.effectiveAt
      ? undefined
      : 'Exact Price absence evidence must apply to the lookup instant',
  ),
);
export type ExactPriceLookupAbsent = typeof ExactPriceLookupAbsentSchema.Type;

const priceIdentityKeyEquivalence = Schema.toEquivalence(PriceIdentityKeySchema);
const exactPriceKeyEquivalence = (
  left: typeof PriceIdentityKeySchema.Type,
  right: typeof PriceIdentityKeySchema.Type,
): boolean =>
  priceDecimalValuesEqual(left.unitBasis.quantity, right.unitBasis.quantity) &&
  priceIdentityKeyEquivalence({ ...left, unitBasis: { ...left.unitBasis, quantity: right.unitBasis.quantity } }, right);

const PriceScheduleRevisionIdSchema = Schema.String.check(Schema.isUUID(), Schema.isTrimmed()).pipe(
  Schema.brand('PricingPriceScheduleRevisionId'),
  Schema.decodeTo(Schema.String),
);

/**
 * Owner-authorized evidence for one canonical Current claimant. Source evidence stays behind the
 * Pricing owner boundary; diagnostics carry only opaque provenance references.
 */
export const ExactPriceConflictClaimantSchema = Schema.Struct({
  effectivePeriod: PriceEffectivePeriodSchema,
  exactKey: PriceIdentityKeySchema,
  priceRef: PriceRefSchema,
  priceRevision: PriceRevisionSchema,
  priceScheduleRevisionId: PriceScheduleRevisionIdSchema,
  provenanceRefs: Schema.Array(PriceSourceProvenanceRefSchema).check(
    Schema.isMinLength(1),
    Schema.makeFilter((refs) =>
      new Set(refs).size === refs.length ? undefined : 'Conflict claimant provenance references must be distinct',
    ),
  ),
  scheduleRevision: PriceScheduleRevisionSchema,
}).check(
  Schema.makeFilter(({ effectivePeriod, exactKey, priceRef, priceRevision }) => {
    const {
      catalogSelection: {
        productRef: { tenantId },
      },
    } = exactKey;
    if (priceRef.tenantId !== tenantId || priceRevision.monetaryAmount.currencyCode !== exactKey.currencyCode) {
      return 'A conflict claimant must preserve the exact key Tenant and native currency';
    }
    return priceRevision.effectiveFrom === effectivePeriod.effectiveFrom
      ? undefined
      : 'A conflict claimant Revision must preserve its exact effective period';
  }),
);
export type ExactPriceConflictClaimant = typeof ExactPriceConflictClaimantSchema.Type;

/** Safe public claimant identity. Amount, effectivity, schedules, and provenance remain redacted. */
export const ExactPriceConflictPublicClaimantSchema = Schema.Struct({
  priceRef: PriceRefSchema,
  revisionId: PriceRevisionIdSchema,
});
export type ExactPriceConflictPublicClaimant = typeof ExactPriceConflictPublicClaimantSchema.Type;

const claimantIdentity = (claimant: ExactPriceConflictClaimant): string =>
  `${claimant.priceRef.moduleId}:${claimant.priceRef.resourceType}:${claimant.priceRef.resourceId}:${claimant.priceRevision.revisionId}`;

const publicClaimantIdentity = (claimant: ExactPriceConflictPublicClaimant): string =>
  `${claimant.priceRef.moduleId}:${claimant.priceRef.resourceType}:${claimant.priceRef.resourceId}:${claimant.revisionId}`;

/** Owner-private conflict evidence. It is never the public exact-lookup result. */
export const ExactPriceConflictDiagnosticSchema = Schema.TaggedStruct('EXACT_PRICE_CONFLICT_DIAGNOSTIC', {
  claimants: Schema.Array(ExactPriceConflictClaimantSchema).check(
    Schema.isMinLength(2),
    Schema.makeFilter((claimants) =>
      new Set(claimants.map(claimantIdentity)).size === claimants.length
        ? undefined
        : 'A replay of the same canonical Price Revision is one claimant, not a conflict',
    ),
  ),
  evidence: ExactPriceLookupCurrentEvidenceSchema,
  reason: Schema.Literal('COMPETING_CURRENT_EXACT_PRICES'),
  request: ExactPriceLookupRequestSchema,
  verification: Schema.Literal('OWNER_VERIFIED_COMPLETE_CURRENT_SET'),
}).check(
  Schema.makeFilter(({ claimants, evidence, request }) => {
    if (evidence.effectiveAt !== request.effectiveAt) {
      return 'Exact Price conflict evidence must apply to the trusted lookup instant';
    }
    const everyClaimantIsCurrentForExactKey = claimants.every(
      ({ effectivePeriod, exactKey }) =>
        exactPriceKeyEquivalence(exactKey, request.exactKey) &&
        effectivePeriod.effectiveFrom <= request.effectiveAt &&
        (effectivePeriod.effectiveTo === null || request.effectiveAt < effectivePeriod.effectiveTo),
    );
    return everyClaimantIsCurrentForExactKey
      ? undefined
      : 'Every conflict claimant must be owner-verified Current for the one complete exact key';
  }),
);
export type ExactPriceConflictDiagnostic = typeof ExactPriceConflictDiagnosticSchema.Type;

export const ExactPriceLookupConflictSchema = Schema.TaggedStruct('CONFLICT', {
  currentTruthRefs: Schema.Array(ExactPriceConflictPublicClaimantSchema).check(
    Schema.isMinLength(2),
    Schema.makeFilter((claimants) =>
      new Set(claimants.map(publicClaimantIdentity)).size === claimants.length
        ? undefined
        : 'Conflicting Current truths must be distinct canonical Price Revisions',
    ),
  ),
  evidence: ExactPriceLookupCurrentEvidenceSchema,
  reason: Schema.Literal('COMPETING_CURRENT_EXACT_PRICES'),
  request: ExactPriceLookupRequestSchema,
}).check(
  Schema.makeFilter(({ currentTruthRefs, evidence, request }) =>
    evidence.effectiveAt === request.effectiveAt &&
    currentTruthRefs.every(
      ({ priceRef }) => priceRef.tenantId === request.exactKey.catalogSelection.productRef.tenantId,
    )
      ? undefined
      : 'Conflicting Current Price evidence must preserve the exact Tenant and lookup instant',
  ),
);
export type ExactPriceLookupConflict = typeof ExactPriceLookupConflictSchema.Type;

/** Removes owner-private amount, effectivity, schedule, and source-provenance evidence. */
export const redactExactPriceConflictDiagnostic = (
  diagnostic: ExactPriceConflictDiagnostic,
): ExactPriceLookupConflict => ({
  _tag: 'CONFLICT',
  currentTruthRefs: diagnostic.claimants
    .map(({ priceRef, priceRevision }) => ({ priceRef, revisionId: priceRevision.revisionId }))
    .toSorted((left, right) => publicClaimantIdentity(left).localeCompare(publicClaimantIdentity(right))),
  evidence: diagnostic.evidence,
  reason: diagnostic.reason,
  request: diagnostic.request,
});

export const ExactPriceLookupInvalidReasonSchema = Schema.Literals([
  'INVALID_CANONICAL_PRICE',
  'PRICE_KEY_MISMATCH',
  'UNSUPPORTED_CURRENCY',
  'UNSUPPORTED_UNIT_BASIS',
]);
export type ExactPriceLookupInvalidReason = typeof ExactPriceLookupInvalidReasonSchema.Type;

export const ExactPriceLookupInvalidSchema = Schema.TaggedStruct('INVALID', {
  reason: ExactPriceLookupInvalidReasonSchema,
  request: ExactPriceLookupRequestSchema,
});
export type ExactPriceLookupInvalid = typeof ExactPriceLookupInvalidSchema.Type;

export const ExactPriceLookupUnavailableReasonSchema = Schema.Literals([
  'EXACT_LOOKUP_UNAVAILABLE',
  'OWNER_STATE_UNAVAILABLE',
]);
export type ExactPriceLookupUnavailableReason = typeof ExactPriceLookupUnavailableReasonSchema.Type;

export const ExactPriceLookupUnavailableSchema = Schema.TaggedStruct('UNAVAILABLE', {
  reason: ExactPriceLookupUnavailableReasonSchema,
  request: ExactPriceLookupRequestSchema,
});
export type ExactPriceLookupUnavailable = typeof ExactPriceLookupUnavailableSchema.Type;

export const ExactPriceLookupUnverifiableReasonSchema = Schema.Literals([
  'CURRENTNESS_UNVERIFIABLE',
  'EXACT_KEY_BINDING_UNVERIFIABLE',
  'SET_COMPLETENESS_UNVERIFIABLE',
]);
export type ExactPriceLookupUnverifiableReason = typeof ExactPriceLookupUnverifiableReasonSchema.Type;

export const ExactPriceLookupUnverifiableSchema = Schema.TaggedStruct('UNVERIFIABLE', {
  reason: ExactPriceLookupUnverifiableReasonSchema,
  request: ExactPriceLookupRequestSchema,
});
export type ExactPriceLookupUnverifiable = typeof ExactPriceLookupUnverifiableSchema.Type;

/**
 * Complete owner result for one exact key. A repeated delivery of the same Price owner fact is one
 * `FOUND`; only distinct canonical Price references can form a `CONFLICT`.
 */
export const ExactPriceLookupResultSchema = Schema.Union([
  ExactPriceLookupFoundSchema,
  ExactPriceLookupAbsentSchema,
  ExactPriceLookupConflictSchema,
  ExactPriceLookupInvalidSchema,
  ExactPriceLookupUnavailableSchema,
  ExactPriceLookupUnverifiableSchema,
]);
export type ExactPriceLookupResult = typeof ExactPriceLookupResultSchema.Type;

/** Owner-local decode boundary; callers must redact diagnostics before crossing the owner boundary. */
export const ExactPriceOwnerLookupResultSchema = Schema.Union([
  ExactPriceLookupFoundSchema,
  ExactPriceLookupAbsentSchema,
  ExactPriceConflictDiagnosticSchema,
  ExactPriceLookupInvalidSchema,
  ExactPriceLookupUnavailableSchema,
  ExactPriceLookupUnverifiableSchema,
]);
export type ExactPriceOwnerLookupResult = typeof ExactPriceOwnerLookupResultSchema.Type;
