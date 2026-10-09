import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import { Schema } from 'effect';

import { PricingCurrencyCodeSchema, PricingInstantSchema, PricingTenantIdSchema } from './currency-support.ts';

const opaqueOwnerReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());

/** Every material source family whose proof may affect one canonical Pricing result. */
export const PricingSourceEvidenceFamilySchema = Schema.Literals([
  'PRICE',
  'QUANTITY_TIER',
  'DISCOUNT',
  'COMMERCIAL_FEE',
  'ZERO_FLOOR',
  'COMMERCIAL_CONTEXT',
  'CURRENCY_SUPPORT',
  'PROMOTION',
]);
export type PricingSourceEvidenceFamily = typeof PricingSourceEvidenceFamilySchema.Type;

/**
 * Owner-issued references are deliberately opaque to Pricing. They locate an owner-verifiable
 * proof; their spelling, a hash, or a Revision string is never proof by itself.
 */
export const PricingSourceEvidenceReferenceSchema = opaqueOwnerReference.pipe(
  Schema.brand('PricingSourceEvidenceReference'),
  Schema.decodeTo(Schema.String),
);
export type PricingSourceEvidenceReference = typeof PricingSourceEvidenceReferenceSchema.Type;

export const PricingSourceEvidenceOwnerModuleIdSchema = opaqueOwnerReference.pipe(
  Schema.brand('PricingSourceEvidenceOwnerModuleId'),
  Schema.decodeTo(Schema.String),
);
export type PricingSourceEvidenceOwnerModuleId = typeof PricingSourceEvidenceOwnerModuleIdSchema.Type;

/** Exact owner, Tenant, root, and predicate qualification shared by both proof classes. */
export const PricingSourceEvidenceOwnerScopeSchema = Schema.Struct({
  ownerModuleId: PricingSourceEvidenceOwnerModuleIdSchema,
  ownerRootRef: PricingSourceEvidenceReferenceSchema,
  predicateRef: PricingSourceEvidenceReferenceSchema,
  tenantId: PricingTenantIdSchema,
});
export type PricingSourceEvidenceOwnerScope = typeof PricingSourceEvidenceOwnerScopeSchema.Type;

/**
 * Coherent owner timing. Normal request latency is valid: `observedAt` may follow both the
 * requested effective instant and the owner's evaluation instant.
 */
export const PricingSourceEvidenceTemporalContextSchema = Schema.Struct({
  effectiveAt: PricingInstantSchema,
  evaluatedAt: PricingInstantSchema,
  evaluationMode: Schema.Literals(['HISTORICAL_AS_OF', 'CURRENT_AT_OWNER_EVALUATION']),
  nextMaterialBoundary: Schema.optionalKey(PricingInstantSchema),
  observedAt: PricingInstantSchema,
  requestedAt: PricingInstantSchema,
}).check(
  Schema.makeFilter(({ effectiveAt, evaluatedAt, evaluationMode, nextMaterialBoundary, observedAt, requestedAt }) => {
    if (requestedAt > observedAt) {
      return 'Source evidence cannot be observed before its request';
    }
    if (evaluatedAt > observedAt) {
      return 'Source evidence cannot be observed before its owner evaluation';
    }
    if (evaluationMode === 'HISTORICAL_AS_OF' && evaluatedAt !== effectiveAt) {
      return 'Historical source evidence must evaluate the exact requested effective instant';
    }
    if (evaluationMode === 'CURRENT_AT_OWNER_EVALUATION' && evaluatedAt < effectiveAt) {
      return 'Current source evidence cannot evaluate before the requested effective instant';
    }
    return nextMaterialBoundary === undefined || nextMaterialBoundary > observedAt
      ? undefined
      : 'The next material boundary must follow the actual owner observation';
  }),
);
export type PricingSourceEvidenceTemporalContext = typeof PricingSourceEvidenceTemporalContextSchema.Type;

export const PricingSourceFactEffectivePeriodSchema = Schema.Struct({
  effectiveFrom: PricingInstantSchema,
  effectiveTo: Schema.NullOr(PricingInstantSchema),
}).check(
  Schema.makeFilter(({ effectiveFrom, effectiveTo }) =>
    effectiveTo === null || effectiveFrom < effectiveTo
      ? undefined
      : 'Source fact effective period must be a non-empty half-open interval',
  ),
);
export type PricingSourceFactEffectivePeriod = typeof PricingSourceFactEffectivePeriodSchema.Type;

const ownerVerificationSchema = Schema.Struct({
  kind: Schema.Literal('OWNER_VERIFIABLE_OPAQUE_REFERENCE'),
  verificationRef: PricingSourceEvidenceReferenceSchema,
});

/**
 * Proof class 1: one exact material fact and immutable Revision were Current at the owner's
 * evaluation instant. This never claims that every matching fact was observed.
 */
export const PricingFactCurrentnessEvidenceSchema = Schema.Struct({
  currencyCode: Schema.optionalKey(PricingCurrencyCodeSchema),
  effectivePeriod: PricingSourceFactEffectivePeriodSchema,
  factRef: PricingSourceEvidenceReferenceSchema,
  factRevisionRef: PricingSourceEvidenceReferenceSchema,
  family: PricingSourceEvidenceFamilySchema,
  ownerScope: PricingSourceEvidenceOwnerScopeSchema,
  temporal: PricingSourceEvidenceTemporalContextSchema,
  verification: ownerVerificationSchema,
}).check(
  Schema.makeFilter(({ effectivePeriod, temporal }) =>
    effectivePeriod.effectiveFrom <= temporal.evaluatedAt &&
    (effectivePeriod.effectiveTo === null || temporal.evaluatedAt < effectivePeriod.effectiveTo)
      ? undefined
      : 'Fact Currentness evidence must cover the exact owner evaluation instant',
  ),
);
export type PricingFactCurrentnessEvidence = typeof PricingFactCurrentnessEvidenceSchema.Type;

/**
 * Proof class 2: the owner guarantees the complete matching Current set. The cross-owner shared
 * envelope retains exact/safely-broader invalidation scope; this wrapper binds it to the issuing
 * owner, Tenant, root, requested evaluation, and an owner-verifiable opaque proof reference.
 */
export const PricingOwnerQualifiedSetCompletenessEvidenceSchema = Schema.Struct({
  completenessEvidence: Schema.toEncoded(OwnerVerifiableSetCompletenessEvidenceSchema),
  currencyCode: Schema.optionalKey(PricingCurrencyCodeSchema),
  family: PricingSourceEvidenceFamilySchema,
  ownerScope: PricingSourceEvidenceOwnerScopeSchema,
  ownerSetRevisionRef: PricingSourceEvidenceReferenceSchema,
  temporal: PricingSourceEvidenceTemporalContextSchema,
  verification: ownerVerificationSchema,
}).check(
  Schema.makeFilter(({ completenessEvidence, ownerScope, ownerSetRevisionRef, temporal }) => {
    if (completenessEvidence.ownerRevision !== ownerSetRevisionRef) {
      return 'Set completeness must bind the owner-issued set Revision';
    }
    if (completenessEvidence.scope.predicateRef !== ownerScope.predicateRef) {
      return 'Set completeness must bind the exact requested owner predicate';
    }
    if (completenessEvidence.observedAt !== temporal.observedAt) {
      return 'Set completeness must preserve the actual owner observation instant';
    }
    return completenessEvidence.nextApplicabilityBoundary === temporal.nextMaterialBoundary
      ? undefined
      : 'Set completeness must preserve the next material boundary';
  }),
);
export type PricingOwnerQualifiedSetCompletenessEvidence =
  typeof PricingOwnerQualifiedSetCompletenessEvidenceSchema.Type;

export const PricingSourceEvidenceRequestSchema = Schema.Struct({
  currencyCode: Schema.optionalKey(PricingCurrencyCodeSchema),
  effectiveAt: PricingInstantSchema,
  family: PricingSourceEvidenceFamilySchema,
  ownerScope: PricingSourceEvidenceOwnerScopeSchema,
  requestedAt: PricingInstantSchema,
});
export type PricingSourceEvidenceRequest = typeof PricingSourceEvidenceRequestSchema.Type;

const ownerScopeEqual = Schema.toEquivalence(PricingSourceEvidenceOwnerScopeSchema);

const requestMatchesTemporal = (
  request: PricingSourceEvidenceRequest,
  temporal: PricingSourceEvidenceTemporalContext,
): boolean => request.effectiveAt === temporal.effectiveAt && request.requestedAt === temporal.requestedAt;

const requestMatchesEvidence = (
  request: PricingSourceEvidenceRequest,
  evidence: {
    readonly currencyCode?: string | undefined;
    readonly family: PricingSourceEvidenceFamily;
    readonly ownerScope: PricingSourceEvidenceOwnerScope;
    readonly temporal: PricingSourceEvidenceTemporalContext;
  },
): boolean =>
  request.family === evidence.family &&
  request.currencyCode === evidence.currencyCode &&
  ownerScopeEqual(request.ownerScope, evidence.ownerScope) &&
  requestMatchesTemporal(request, evidence.temporal);

const factIdentity = (fact: PricingFactCurrentnessEvidence): string =>
  `${fact.ownerScope.ownerModuleId}:${fact.ownerScope.ownerRootRef}:${fact.factRef}:${fact.factRevisionRef}`;

const verifiedEvidenceFields = {
  completeness: PricingOwnerQualifiedSetCompletenessEvidenceSchema,
  request: PricingSourceEvidenceRequestSchema,
} as const;

export const PricingSourceEvidenceVerifiedPresentSchema = Schema.TaggedStruct('VERIFIED_PRESENT', {
  ...verifiedEvidenceFields,
  currentFacts: Schema.Array(PricingFactCurrentnessEvidenceSchema).check(Schema.isMinLength(1)),
}).check(
  Schema.makeFilter(({ completeness, currentFacts, request }) =>
    requestMatchesEvidence(request, completeness) && currentFacts.every((fact) => requestMatchesEvidence(request, fact))
      ? undefined
      : 'Verified source evidence must bind every proof to the exact request',
  ),
);
export type PricingSourceEvidenceVerifiedPresent = typeof PricingSourceEvidenceVerifiedPresentSchema.Type;

/** Authoritative absence uses complete-set proof and deliberately has no fabricated fact proof. */
export const PricingSourceEvidenceVerifiedAbsentSchema = Schema.TaggedStruct('VERIFIED_ABSENT', {
  ...verifiedEvidenceFields,
}).check(
  Schema.makeFilter(({ completeness, request }) =>
    requestMatchesEvidence(request, completeness)
      ? undefined
      : 'Verified source absence must bind completeness to the exact request',
  ),
);
export type PricingSourceEvidenceVerifiedAbsent = typeof PricingSourceEvidenceVerifiedAbsentSchema.Type;

/** A known conflict is a complete set containing at least two distinct Current fact Revisions. */
export const PricingSourceEvidenceConflictSchema = Schema.TaggedStruct('CONFLICT', {
  ...verifiedEvidenceFields,
  currentFacts: Schema.Array(PricingFactCurrentnessEvidenceSchema).check(
    Schema.isMinLength(2),
    Schema.makeFilter((facts) =>
      new Set(facts.map(factIdentity)).size === facts.length
        ? undefined
        : 'Conflicting source facts must be distinct owner fact Revisions',
    ),
  ),
}).check(
  Schema.makeFilter(({ completeness, currentFacts, request }) =>
    requestMatchesEvidence(request, completeness) && currentFacts.every((fact) => requestMatchesEvidence(request, fact))
      ? undefined
      : 'Conflicting source evidence must bind every proof to the exact request',
  ),
);
export type PricingSourceEvidenceConflict = typeof PricingSourceEvidenceConflictSchema.Type;

export const PricingSourceEvidenceMissingReasonSchema = Schema.Literals([
  'OWNER_ROOT_NOT_INITIALIZED',
  'REQUIRED_CONFIGURATION_MISSING',
]);
export const PricingSourceEvidenceMissingSchema = Schema.TaggedStruct('MISSING', {
  observedAt: PricingInstantSchema,
  reason: PricingSourceEvidenceMissingReasonSchema,
  request: PricingSourceEvidenceRequestSchema,
  verification: ownerVerificationSchema,
});
export type PricingSourceEvidenceMissing = typeof PricingSourceEvidenceMissingSchema.Type;

export const PricingSourceEvidenceUnverifiableReasonSchema = Schema.Literals([
  'OWNER_UNAVAILABLE',
  'FACT_CURRENTNESS_UNVERIFIABLE',
  'SET_COMPLETENESS_UNVERIFIABLE',
  'SCOPE_BINDING_UNVERIFIABLE',
  'TEMPORAL_VALIDITY_UNVERIFIABLE',
  'OWNER_REFERENCE_UNVERIFIABLE',
]);
export const PricingSourceEvidenceUnverifiableSchema = Schema.TaggedStruct('UNVERIFIABLE', {
  observedAt: PricingInstantSchema,
  reason: PricingSourceEvidenceUnverifiableReasonSchema,
  request: PricingSourceEvidenceRequestSchema,
  retryable: Schema.Boolean,
});
export type PricingSourceEvidenceUnverifiable = typeof PricingSourceEvidenceUnverifiableSchema.Type;

/** Complete typed outcome; inability is never rewritten as absence, conflict, or success. */
export const PricingSourceEvidenceResultSchema = Schema.Union([
  PricingSourceEvidenceVerifiedPresentSchema,
  PricingSourceEvidenceVerifiedAbsentSchema,
  PricingSourceEvidenceConflictSchema,
  PricingSourceEvidenceMissingSchema,
  PricingSourceEvidenceUnverifiableSchema,
]);
export type PricingSourceEvidenceResult = typeof PricingSourceEvidenceResultSchema.Type;
