import { DateTime, Schema } from 'effect';

import {
  PricingCurrencyCodeSchema,
  PricingInstantSchema,
  PricingTenantIdSchema,
} from '../apis/current-supported-currencies.ts';
import { PricingCommercialTotalReadySchema, PricingCommercialTotalSafeProjectionSchema } from './commercial-total.ts';
import type { PricingCommercialTotalReady, PricingCommercialTotalSafeProjection } from './commercial-total.ts';
import { PricingCommercialScopeSchema } from './pricing-commercial-scope.ts';
import { PricingMaterialEvidenceReadySchema } from './material-evidence.ts';
import type { PricingMaterialEvidenceReady } from './material-evidence.ts';
import {
  PricingCatalogSelectionSchema,
  PricingPurchaseDemandOccurrenceIdSchema,
  PricingQuantitySchema,
} from './pricing-decision.ts';

const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());
const PricingQuotationSubjectModuleIdSchema = stableReference.pipe(
  Schema.brand('PricingQuotationSubjectModuleId'),
  Schema.decodeTo(Schema.String),
);
const PricingQuotationSubjectResourceIdSchema = stableReference.pipe(
  Schema.brand('PricingQuotationSubjectResourceId'),
  Schema.decodeTo(Schema.String),
);
export const PricingQuotationOwnerModuleIdSchema = stableReference.pipe(
  Schema.brand('PricingQuotationOwnerModuleId'),
  Schema.decodeTo(Schema.String),
);

const PricingQuotationPurchaseContextSchema = Schema.Struct({
  contextRef: stableReference,
  contextRevision: stableReference,
});

const PricingQuotationSubjectRefSchema = Schema.Struct({
  moduleId: PricingQuotationSubjectModuleIdSchema,
  resourceId: PricingQuotationSubjectResourceIdSchema,
  resourceType: stableReference,
  tenantId: PricingTenantIdSchema,
});

/**
 * One original Purchase Demand Occurrence. Exact Catalog Selection retains the mandatory Variant
 * plus any Package, configuration, and Set meaning; purchase Quantity remains separate from those
 * selected-product facts.
 */
export const PricingQuotationLineBindingSchema = Schema.Struct({
  occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
  quantity: PricingQuantitySchema,
  selection: PricingCatalogSelectionSchema,
});
export type PricingQuotationLineBinding = typeof PricingQuotationLineBindingSchema.Type;

/** Owner-issued Guest Purchase Context; it is not a Purchasing Subject, Profile, or bearer grant. */
export const PricingQuotationGuestBindingSchema = Schema.Struct({
  guestEvidenceRef: stableReference,
  guestSessionRef: stableReference,
  kind: Schema.Literal('GUEST'),
  purchaseContext: PricingQuotationPurchaseContextSchema,
  subjectEvidenceRef: Schema.optionalKey(Schema.Never),
  subjectRef: Schema.optionalKey(Schema.Never),
});
export type PricingQuotationGuestBinding = typeof PricingQuotationGuestBindingSchema.Type;

/** Exact authenticated purchase subject plus the owner evidence used at issuance. */
export const PricingQuotationAuthenticatedBindingSchema = Schema.Struct({
  guestEvidenceRef: Schema.optionalKey(Schema.Never),
  guestSessionRef: Schema.optionalKey(Schema.Never),
  kind: Schema.Literal('AUTHENTICATED'),
  purchaseContext: PricingQuotationPurchaseContextSchema,
  subjectEvidenceRef: stableReference,
  subjectRef: PricingQuotationSubjectRefSchema,
});
export type PricingQuotationAuthenticatedBinding = typeof PricingQuotationAuthenticatedBindingSchema.Type;

/** The union makes authenticated and Guest authority mutually exclusive. */
export const PricingQuotationAuthorityBindingSchema = Schema.Union([
  PricingQuotationAuthenticatedBindingSchema,
  PricingQuotationGuestBindingSchema,
]);
export type PricingQuotationAuthorityBinding = typeof PricingQuotationAuthorityBindingSchema.Type;

const PricingQuotationLinesSchema = Schema.Array(PricingQuotationLineBindingSchema).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(500),
  Schema.makeFilter((lines) =>
    new Set(lines.map(({ occurrenceId }) => occurrenceId)).size === lines.length
      ? undefined
      : 'A Pricing Quotation must preserve distinct original occurrence identities',
  ),
);

/**
 * Exact immutable purchase identity for a Quotation. Storefront is deliberately absent: changing
 * a display application does not change Pricing monetary identity or transfer authority.
 */
export const PricingQuotationBindingSchema = Schema.Struct({
  candidateRef: stableReference,
  commercialScope: PricingCommercialScopeSchema,
  currencyCode: PricingCurrencyCodeSchema,
  lines: PricingQuotationLinesSchema,
  monetaryBoundary: Schema.Literal('PRE_TAX'),
  subject: PricingQuotationAuthorityBindingSchema,
  tenantId: PricingTenantIdSchema,
}).check(
  Schema.makeFilter(({ lines, subject, tenantId }) => {
    if (
      lines.some(
        ({ quantity, selection }) =>
          selection.productRef.tenantId !== tenantId || quantity.unitRef.tenantId !== tenantId,
      )
    ) {
      return 'Quotation selection and resulting Quantity Unit must belong to the bound Tenant';
    }
    return subject.kind === 'AUTHENTICATED' && subject.subjectRef.tenantId !== tenantId
      ? 'Authenticated Quotation subject must belong to the bound Tenant'
      : undefined;
  }),
);
export type PricingQuotationBinding = typeof PricingQuotationBindingSchema.Type;

const sameCatalogSelection = Schema.toEquivalence(PricingCatalogSelectionSchema);
const sameCommercialTotal = Schema.toEquivalence(PricingCommercialTotalReadySchema);
const sameCommercialScope = Schema.toEquivalence(PricingCommercialScopeSchema);
const sameResourceRef = (
  left: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
  right: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const quotationBindingMatchesResult = (
  binding: PricingQuotationBinding,
  result: PricingCommercialTotalReady,
): boolean => {
  const { decision } = result;
  return (
    binding.candidateRef === result.candidateRef &&
    binding.tenantId === decision.tenantId &&
    binding.currencyCode === decision.currencyCode &&
    binding.monetaryBoundary === decision.monetaryBoundary &&
    sameCommercialScope(binding.commercialScope, decision.commercialScope) &&
    binding.subject.purchaseContext.contextRef === decision.purchasingContext.contextRef &&
    binding.subject.purchaseContext.contextRevision === decision.purchasingContext.contextRevision &&
    binding.lines.length === decision.lines.length &&
    binding.lines.every((boundLine, index) => {
      const resultLine = decision.lines[index];
      return (
        resultLine !== undefined &&
        boundLine.occurrenceId === resultLine.occurrenceId &&
        sameCatalogSelection(boundLine.selection, resultLine.catalog.selection) &&
        boundLine.quantity.amount === resultLine.catalog.quantity.resulting &&
        sameResourceRef(boundLine.quantity.unitRef, resultLine.catalog.unitRef)
      );
    })
  );
};

const quotationMaterialEvidenceMatchesResult = (
  materialEvidence: PricingMaterialEvidenceReady,
  result: PricingCommercialTotalReady,
): boolean =>
  materialEvidence.candidateRef === result.candidateRef &&
  sameCommercialTotal(materialEvidence.sourceEvidence.commercialTotal, result);

/**
 * A freshly evaluated Pricing result. The wrapper is deliberately distinct from retained display
 * state and from a Quotation: only this kind may enter the explicit quotation-issuance boundary.
 */
export interface PricingCurrentCommercialResult {
  readonly commercialTotal: PricingCommercialTotalReady;
  readonly kind: 'CURRENT_PRICING_RESULT';
}

export const PricingCurrentCommercialResultSchema: Schema.Codec<PricingCurrentCommercialResult, unknown> =
  Schema.Struct({
    commercialTotal: Schema.toType(PricingCommercialTotalReadySchema),
    kind: Schema.Literal('CURRENT_PRICING_RESULT'),
  });

/** A retained projection is display-only evidence and never a commercial guarantee. */
export interface PricingRetainedDisplayOnlyResult {
  readonly display: PricingCommercialTotalSafeProjection;
  readonly guarantee: 'NONE';
  readonly kind: 'RETAINED_DISPLAY_ONLY';
  readonly retainedAt: typeof PricingInstantSchema.Type;
}

export const PricingRetainedDisplayOnlyResultSchema: Schema.Codec<PricingRetainedDisplayOnlyResult, unknown> =
  Schema.Struct({
    display: Schema.toType(PricingCommercialTotalSafeProjectionSchema),
    guarantee: Schema.Literal('NONE'),
    kind: Schema.Literal('RETAINED_DISPLAY_ONLY'),
    retainedAt: PricingInstantSchema,
  });

const positiveSafeInteger = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
);

/** Immutable evidence for the owner policy that bounded this quotation at issuance. */
export const PricingQuotationValidityPolicyEvidenceSchema = Schema.Struct({
  maximumValidityDurationMilliseconds: positiveSafeInteger,
  policyRef: stableReference,
  policyVersion: stableReference,
});
export type PricingQuotationValidityPolicyEvidence = typeof PricingQuotationValidityPolicyEvidenceSchema.Type;

/**
 * Immutable half-open validity interval. The owner derives it from trusted backend time and a
 * versioned policy; clients cannot extend it and a later quotation receives a new identity.
 */
export const PricingQuotationValiditySchema = Schema.Struct({
  policyEvidence: PricingQuotationValidityPolicyEvidenceSchema,
  validFrom: PricingInstantSchema,
  validUntil: PricingInstantSchema,
}).check(
  Schema.makeFilter(({ policyEvidence, validFrom, validUntil }) => {
    const validFromMilliseconds = DateTime.toEpochMillis(DateTime.makeUnsafe(validFrom));
    const validUntilMilliseconds = DateTime.toEpochMillis(DateTime.makeUnsafe(validUntil));
    if (validFromMilliseconds >= validUntilMilliseconds) {
      return 'Pricing Quotation validity must be a non-empty half-open interval';
    }
    return validUntilMilliseconds - validFromMilliseconds <= policyEvidence.maximumValidityDurationMilliseconds
      ? undefined
      : 'Pricing Quotation validity exceeds its immutable owner policy bound';
  }),
);
export type PricingQuotationValidity = typeof PricingQuotationValiditySchema.Type;

const PricingQuotationTrustedValidityEvaluationFields = {
  evaluatedAt: PricingInstantSchema,
  quotationRef: stableReference,
  validity: PricingQuotationValiditySchema,
};

export const PricingQuotationValidSchema = Schema.TaggedStruct('VALID', {
  ...PricingQuotationTrustedValidityEvaluationFields,
}).check(
  Schema.makeFilter(({ evaluatedAt, validity }) =>
    evaluatedAt >= validity.validFrom && evaluatedAt < validity.validUntil
      ? undefined
      : 'VALID requires trusted time inside [validFrom, validUntil)',
  ),
);
export type PricingQuotationValid = typeof PricingQuotationValidSchema.Type;

export const PricingQuotationExpiredSchema = Schema.TaggedStruct('EXPIRED', {
  ...PricingQuotationTrustedValidityEvaluationFields,
}).check(
  Schema.makeFilter(({ evaluatedAt, validity }) =>
    evaluatedAt >= validity.validUntil ? undefined : 'EXPIRED requires trusted time at or after validUntil',
  ),
);
export type PricingQuotationExpired = typeof PricingQuotationExpiredSchema.Type;

/** A well-formed quotation evaluated before its immutable inclusive start. */
export const PricingQuotationInvalidSchema = Schema.TaggedStruct('INVALID', {
  ...PricingQuotationTrustedValidityEvaluationFields,
  reason: Schema.Literal('NOT_YET_VALID'),
}).check(
  Schema.makeFilter(({ evaluatedAt, validity }) =>
    evaluatedAt < validity.validFrom ? undefined : 'NOT_YET_VALID requires trusted time before validFrom',
  ),
);
export type PricingQuotationInvalid = typeof PricingQuotationInvalidSchema.Type;

/** Trusted time could not be established, so expiry cannot be asserted either way. */
export const PricingQuotationValidityUnverifiableSchema = Schema.TaggedStruct('UNVERIFIABLE', {
  quotationRef: stableReference,
  reason: Schema.Literal('TRUSTED_TIME_UNAVAILABLE'),
  retryable: Schema.Literal(true),
  validity: PricingQuotationValiditySchema,
});
export type PricingQuotationValidityUnverifiable = typeof PricingQuotationValidityUnverifiableSchema.Type;

/** Temporal validity only; #785 owns authenticity and exact-binding revalidation. */
export const PricingQuotationValidityEvaluationSchema = Schema.Union([
  PricingQuotationValidSchema,
  PricingQuotationExpiredSchema,
  PricingQuotationInvalidSchema,
  PricingQuotationValidityUnverifiableSchema,
]);
export type PricingQuotationValidityEvaluation = typeof PricingQuotationValidityEvaluationSchema.Type;

const isLaunchQuotationResult = (result: PricingCommercialTotalReady): boolean =>
  result.decision.currencyCode === 'CZK' &&
  result.decision.monetaryBoundary === 'PRE_TAX' &&
  result.pricingNetCommercialTotal.currencyCode === 'CZK' &&
  result.publishedLines.every(({ publishedLineValue }) => publishedLineValue.currencyCode === 'CZK');

/**
 * Explicit backend issuance input. Retained display state cannot inhabit `currentResult`, so a
 * read/cache/proposal amount can never silently become a guarantee.
 */
export interface PricingQuotationIssuanceRequest {
  readonly binding: PricingQuotationBinding;
  readonly currentResult: PricingCurrentCommercialResult;
  readonly kind: 'ISSUE_PRICING_QUOTATION';
  readonly materialEvidence: PricingMaterialEvidenceReady;
}

export const PricingQuotationIssuanceRequestSchema: Schema.Codec<PricingQuotationIssuanceRequest, unknown> =
  Schema.Struct({
    binding: PricingQuotationBindingSchema,
    currentResult: Schema.toType(PricingCurrentCommercialResultSchema),
    kind: Schema.Literal('ISSUE_PRICING_QUOTATION'),
    materialEvidence: Schema.toType(PricingMaterialEvidenceReadySchema),
  }).check(
    Schema.makeFilter(({ binding, currentResult, materialEvidence }) => {
      if (!isLaunchQuotationResult(currentResult.commercialTotal)) {
        return 'Launch Pricing Quotation issuance requires exact CZK pre-Tax Current terms without FX';
      }
      if (!quotationBindingMatchesResult(binding, currentResult.commercialTotal)) {
        return 'Quotation issuance must bind the exact Current candidate, occurrences, selection, quantity, context, and scope';
      }
      return quotationMaterialEvidenceMatchesResult(materialEvidence, currentResult.commercialTotal)
        ? undefined
        : 'Quotation issuance must bind the exact Current commercial total and material evidence';
    }),
  );

/**
 * Immutable Pricing-owned guarantee. `quotedResult` is the complete original Pricing result,
 * including source evidence; it is not relabelled as a later Current lookup and is not replaced
 * when ordinary Current prices move.
 */
export interface PricingQuotationIssued {
  readonly binding: PricingQuotationBinding;
  readonly issuedAt: typeof PricingInstantSchema.Type;
  readonly kind: 'PRICING_QUOTATION';
  readonly materialEvidence: PricingMaterialEvidenceReady;
  readonly quotationRef: string;
  readonly quotedResult: PricingCommercialTotalReady;
  readonly validity: PricingQuotationValidity;
}

export const PricingQuotationIssuedSchema: Schema.Codec<PricingQuotationIssued, unknown> = Schema.Struct({
  binding: PricingQuotationBindingSchema,
  issuedAt: PricingInstantSchema,
  kind: Schema.Literal('PRICING_QUOTATION'),
  materialEvidence: Schema.toType(PricingMaterialEvidenceReadySchema),
  quotationRef: stableReference,
  quotedResult: Schema.toType(PricingCommercialTotalReadySchema),
  validity: PricingQuotationValiditySchema,
}).check(
  Schema.makeFilter(({ binding, issuedAt, materialEvidence, quotedResult }) => {
    if (!isLaunchQuotationResult(quotedResult)) {
      return 'Launch Pricing Quotation must preserve exact CZK pre-Tax terms without FX';
    }
    if (!quotationBindingMatchesResult(binding, quotedResult)) {
      return 'Issued Quotation must preserve its exact candidate, occurrences, selection, quantity, context, and scope';
    }
    if (!quotationMaterialEvidenceMatchesResult(materialEvidence, quotedResult)) {
      return 'Issued Quotation must preserve the exact material evidence for its original commercial total';
    }
    return materialEvidence.validatedAt <= issuedAt
      ? undefined
      : 'Issued Quotation material evidence cannot be validated after issuance';
  }),
);

/** References for an owner to assess; this is not an attestation or authority grant. */
export const PricingQuotationProposedEvidenceTransitionSchema = Schema.Struct({
  originalEvidenceRef: stableReference,
  ownerModuleId: PricingQuotationOwnerModuleIdSchema,
  proposedEvidenceRef: stableReference,
});
export type PricingQuotationProposedEvidenceTransition = typeof PricingQuotationProposedEvidenceTransitionSchema.Type;

/**
 * Public revalidation input. Authenticity proofs, trusted time, Current pricing, and access
 * credentials are deliberately absent: Pricing acquires those from owner-private dependencies.
 */
export interface PricingQuotationRevalidationRequest {
  readonly kind: 'REVALIDATE_PRICING_QUOTATION';
  readonly proposedEvidence?: PricingQuotationProposedEvidenceTransition;
  readonly quotation: PricingQuotationIssued;
  readonly requestedBinding: PricingQuotationBinding;
}

export const PricingQuotationRevalidationRequestSchema: Schema.Codec<PricingQuotationRevalidationRequest, unknown> =
  Schema.Struct({
    kind: Schema.Literal('REVALIDATE_PRICING_QUOTATION'),
    proposedEvidence: Schema.optionalKey(PricingQuotationProposedEvidenceTransitionSchema),
    quotation: Schema.toType(PricingQuotationIssuedSchema),
    requestedBinding: PricingQuotationBindingSchema,
  });

/** Trusted verification metadata, never a bearer credential or independent access grant. */
export const PricingQuotationAuthenticityVerificationEvidenceSchema = Schema.Struct({
  authenticityRef: stableReference,
  authority: Schema.Literal('EVIDENCE_ONLY'),
  issuerRef: stableReference,
  keyRef: stableReference,
  keyStatus: Schema.Literals(['ACTIVE', 'HISTORICAL']),
  keyVersion: stableReference,
  lineageRef: stableReference,
  payloadDigest: stableReference,
  proofVersion: stableReference,
  quotationRef: stableReference,
  verifiedAt: PricingInstantSchema,
});
export type PricingQuotationAuthenticityVerificationEvidence =
  typeof PricingQuotationAuthenticityVerificationEvidenceSchema.Type;

/**
 * Owner attestation that a change in evidence is semantically non-material. It binds both evidence
 * references to this quotation and purchase identity; equal JSON or revision labels are not proof.
 */
export const PricingQuotationOwnerTransitionEvidenceSchema = Schema.Struct({
  candidateRef: stableReference,
  materiality: Schema.Literal('NON_MATERIAL'),
  originalEvidenceRef: stableReference,
  ownerModuleId: PricingQuotationOwnerModuleIdSchema,
  ownerRef: stableReference,
  proposedEvidenceRef: stableReference,
  quotationRef: stableReference,
  source: Schema.Literal('OWNING_DOMAIN_ATTESTATION'),
  status: Schema.Literal('CONFIRMED'),
  tenantId: PricingTenantIdSchema,
  transitionEvidenceRef: stableReference,
  transitionEvidenceVersion: stableReference,
  verifiedAt: PricingInstantSchema,
});
export type PricingQuotationOwnerTransitionEvidence = typeof PricingQuotationOwnerTransitionEvidenceSchema.Type;

export const PricingQuotationBindingMismatchReasonSchema = Schema.Literals([
  'AUTHORITY_CONTEXT_CHANGED',
  'CANDIDATE_CHANGED',
  'COMMERCIAL_SCOPE_CHANGED',
  'CURRENCY_CHANGED',
  'MATERIAL_EVIDENCE_CHANGED',
  'MONETARY_BOUNDARY_CHANGED',
  'OCCURRENCE_STRUCTURE_CHANGED',
  'QUANTITY_CHANGED',
  'SELECTION_CHANGED',
  'TENANT_CHANGED',
]);
export type PricingQuotationBindingMismatchReason = typeof PricingQuotationBindingMismatchReasonSchema.Type;

export const PricingQuotationBindingExactMatchSchema = Schema.Struct({
  kind: Schema.Literal('EXACT_MATCH'),
  quotationRef: stableReference,
});

export const PricingQuotationOwnerRevalidationRequiredSchema = Schema.Struct({
  kind: Schema.Literal('OWNER_REVALIDATION_REQUIRED'),
  originalEvidenceRef: stableReference,
  ownerModuleId: PricingQuotationOwnerModuleIdSchema,
  ownerRef: stableReference,
  proposedEvidenceRef: stableReference,
  quotationRef: stableReference,
});

export const PricingQuotationOwnerRevalidationAcceptedSchema = Schema.Struct({
  kind: Schema.Literal('OWNER_REVALIDATION_ACCEPTED'),
  transitionEvidence: PricingQuotationOwnerTransitionEvidenceSchema,
});

export const PricingQuotationBindingMismatchSchema = Schema.Struct({
  kind: Schema.Literal('MISMATCH'),
  quotationRef: stableReference,
  reason: PricingQuotationBindingMismatchReasonSchema,
});

export const PricingQuotationBindingUnverifiableReasonSchema = Schema.Literals([
  'BINDING_DEPENDENCY_UNAVAILABLE',
  'OWNER_EVIDENCE_UNAVAILABLE',
  'OWNER_REVALIDATION_UNAVAILABLE',
]);
export type PricingQuotationBindingUnverifiableReason = typeof PricingQuotationBindingUnverifiableReasonSchema.Type;

export const PricingQuotationBindingUnverifiableSchema = Schema.Struct({
  kind: Schema.Literal('BINDING_UNVERIFIABLE'),
  quotationRef: stableReference,
  reason: PricingQuotationBindingUnverifiableReasonSchema,
  retryable: Schema.Literal(true),
});

/** Low-level binding decision; only exact or owner-confirmed non-material transitions may proceed. */
export const PricingQuotationBindingRevalidationAssessmentSchema = Schema.Union([
  PricingQuotationBindingExactMatchSchema,
  PricingQuotationOwnerRevalidationRequiredSchema,
  PricingQuotationOwnerRevalidationAcceptedSchema,
  PricingQuotationBindingMismatchSchema,
  PricingQuotationBindingUnverifiableSchema,
]);
export type PricingQuotationBindingRevalidationAssessment =
  typeof PricingQuotationBindingRevalidationAssessmentSchema.Type;

export const PricingQuotationDirectExactMatchProofSchema = Schema.Struct({
  kind: Schema.Literal('DIRECT_EXACT_MATCH'),
});

export const PricingQuotationOwnerConfirmedTransitionProofSchema = Schema.Struct({
  kind: Schema.Literal('OWNER_CONFIRMED_NON_MATERIAL_TRANSITION'),
  transitionEvidence: PricingQuotationOwnerTransitionEvidenceSchema,
});

export const PricingQuotationReuseBindingProofSchema = Schema.Union([
  PricingQuotationDirectExactMatchProofSchema,
  PricingQuotationOwnerConfirmedTransitionProofSchema,
]);
export type PricingQuotationReuseBindingProof = typeof PricingQuotationReuseBindingProofSchema.Type;

export interface PricingQuotationExactReuse {
  readonly authenticityEvidence: PricingQuotationAuthenticityVerificationEvidence;
  readonly bindingProof: PricingQuotationReuseBindingProof;
  readonly evaluatedAt: typeof PricingInstantSchema.Type;
  readonly kind: 'EXACT_REUSE';
  readonly quotation: PricingQuotationIssued;
  readonly termsAuthority: 'ORIGINAL_QUOTATION';
}

export const PricingQuotationExactReuseSchema: Schema.Codec<PricingQuotationExactReuse, unknown> = Schema.Struct({
  authenticityEvidence: PricingQuotationAuthenticityVerificationEvidenceSchema,
  bindingProof: PricingQuotationReuseBindingProofSchema,
  evaluatedAt: PricingInstantSchema,
  kind: Schema.Literal('EXACT_REUSE'),
  quotation: Schema.toType(PricingQuotationIssuedSchema),
  termsAuthority: Schema.Literal('ORIGINAL_QUOTATION'),
}).check(
  Schema.makeFilter(({ authenticityEvidence, bindingProof, quotation }) => {
    if (authenticityEvidence.quotationRef !== quotation.quotationRef) {
      return 'Authenticity evidence must verify the exact reused Pricing Quotation';
    }
    return bindingProof.kind === 'OWNER_CONFIRMED_NON_MATERIAL_TRANSITION' &&
      (bindingProof.transitionEvidence.quotationRef !== quotation.quotationRef ||
        bindingProof.transitionEvidence.candidateRef !== quotation.binding.candidateRef ||
        bindingProof.transitionEvidence.tenantId !== quotation.binding.tenantId)
      ? 'Owner transition evidence must bind the exact reused Quotation, candidate, and Tenant'
      : undefined;
  }),
);

const PricingQuotationRevalidationTemporalFields = {
  evaluatedAt: PricingInstantSchema,
  quotationRef: stableReference,
  validity: PricingQuotationValiditySchema,
};

export const PricingQuotationRevalidationExpiredSchema = Schema.Struct({
  ...PricingQuotationRevalidationTemporalFields,
  kind: Schema.Literal('EXPIRED'),
}).check(
  Schema.makeFilter(({ evaluatedAt, validity }) =>
    evaluatedAt >= validity.validUntil ? undefined : 'EXPIRED requires trusted time at or after validUntil',
  ),
);

export const PricingQuotationRevalidationNotYetValidSchema = Schema.Struct({
  ...PricingQuotationRevalidationTemporalFields,
  kind: Schema.Literal('NOT_YET_VALID'),
}).check(
  Schema.makeFilter(({ evaluatedAt, validity }) =>
    evaluatedAt < validity.validFrom ? undefined : 'NOT_YET_VALID requires trusted time before validFrom',
  ),
);

export const PricingQuotationRevalidationValidityUnverifiableSchema = Schema.Struct({
  kind: Schema.Literal('VALIDITY_UNVERIFIABLE'),
  quotationRef: stableReference,
  reason: Schema.Literal('TRUSTED_TIME_UNAVAILABLE'),
  retryable: Schema.Literal(true),
});

export const PricingQuotationAuthenticityInvalidReasonSchema = Schema.Literals(['INVALID_PROOF', 'PAYLOAD_TAMPERED']);
export type PricingQuotationAuthenticityInvalidReason = typeof PricingQuotationAuthenticityInvalidReasonSchema.Type;

export const PricingQuotationAuthenticityInvalidSchema = Schema.Struct({
  kind: Schema.Literal('AUTHENTICITY_INVALID'),
  quotationRef: stableReference,
  reason: PricingQuotationAuthenticityInvalidReasonSchema,
  retryable: Schema.Literal(false),
});

export const PricingQuotationAuthenticityUnverifiableReasonSchema = Schema.Literals([
  'DEPENDENCY_UNAVAILABLE',
  'LINEAGE_UNVERIFIABLE',
  'MISSING_PROOF',
  'RETIRED_KEY_WITHOUT_LINEAGE',
  'UNKNOWN_KEY',
  'UNSUPPORTED_KEY_VERSION',
]);
export type PricingQuotationAuthenticityUnverifiableReason =
  typeof PricingQuotationAuthenticityUnverifiableReasonSchema.Type;

const retryabilityMatchesAuthenticityReason = (value: {
  readonly reason: PricingQuotationAuthenticityUnverifiableReason;
  readonly retryable: boolean;
}): boolean => value.retryable === (value.reason === 'DEPENDENCY_UNAVAILABLE');

export const PricingQuotationAuthenticityUnverifiableSchema = Schema.Struct({
  kind: Schema.Literal('AUTHENTICITY_UNVERIFIABLE'),
  quotationRef: stableReference,
  reason: PricingQuotationAuthenticityUnverifiableReasonSchema,
  retryable: Schema.Boolean,
}).check(
  Schema.makeFilter((value) =>
    retryabilityMatchesAuthenticityReason(value)
      ? undefined
      : 'Only an unavailable authenticity dependency is retryable',
  ),
);

/** A definitive material mismatch requires fresh Current Pricing and a distinct new Quotation. */
export const PricingQuotationNewQuotationRequiredSchema = Schema.Struct({
  kind: Schema.Literal('NEW_QUOTATION_REQUIRED'),
  mismatchReason: PricingQuotationBindingMismatchReasonSchema,
  quotationRef: stableReference,
  retryable: Schema.Literal(false),
});

/**
 * Complete backend revalidation outcome. It never contains a replacement Current amount: exact
 * reuse returns the immutable original quotation, while a mismatch only requests a new evaluation.
 */
export const PricingQuotationRevalidationOutcomeSchema = Schema.Union([
  PricingQuotationExactReuseSchema,
  PricingQuotationRevalidationExpiredSchema,
  PricingQuotationRevalidationNotYetValidSchema,
  PricingQuotationRevalidationValidityUnverifiableSchema,
  PricingQuotationAuthenticityInvalidSchema,
  PricingQuotationAuthenticityUnverifiableSchema,
  PricingQuotationBindingUnverifiableSchema,
  PricingQuotationNewQuotationRequiredSchema,
]);
export type PricingQuotationRevalidationOutcome = typeof PricingQuotationRevalidationOutcomeSchema.Type;

/**
 * Opaque link to a separately issued commitment proof. #788 owns the proof's canonical issuance,
 * renewal, Attempt/Bundle binding, verification, and failure contract.
 */
export const PricingCommitmentConfirmationReferenceSchema = Schema.Struct({
  confirmationRef: stableReference,
  kind: Schema.Literal('PRICING_COMMITMENT_CONFIRMATION_REFERENCE'),
});
export type PricingCommitmentConfirmationReference = typeof PricingCommitmentConfirmationReferenceSchema.Type;

/** Public semantic separation; consumers must branch on authority instead of treating all money alike. */
export const PricingCommercialAuthorityResultSchema = Schema.Union([
  PricingCurrentCommercialResultSchema,
  PricingRetainedDisplayOnlyResultSchema,
  PricingQuotationIssuedSchema,
  PricingCommitmentConfirmationReferenceSchema,
]);
export type PricingCommercialAuthorityResult = typeof PricingCommercialAuthorityResultSchema.Type;
