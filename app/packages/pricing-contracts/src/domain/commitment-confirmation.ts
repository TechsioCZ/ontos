import { DateTime, Schema } from 'effect';

import { PricingInstantSchema } from './currency-support.ts';
import { PricingMaterialCalculationVersionsSchema, PricingMaterialEvidenceReadySchema } from './material-evidence.ts';
import type { PricingMaterialEvidenceReady } from './material-evidence.ts';
import { PricingFreshAttemptOutcomeSchema } from './material-change.ts';
import { PricingCatalogSelectionSchema, PricingDecisionSchema } from './pricing-decision.ts';
import {
  PricingCurrentCommercialResultSchema,
  PricingQuotationBindingSchema,
  PricingQuotationExactReuseSchema,
} from './quotation.ts';
import type {
  PricingCurrentCommercialResult,
  PricingQuotationBinding,
  PricingQuotationExactReuse,
} from './quotation.ts';
import { PricingCommercialTotalReadySchema } from './commercial-total.ts';
import type { PricingCommercialTotalReady } from './commercial-total.ts';
import {
  PricingSourceEvidenceResultSchema,
  PricingSourceEvidenceVerifiedAbsentSchema,
  PricingSourceEvidenceVerifiedPresentSchema,
} from './source-revision-evidence.ts';
import type { PricingSourceEvidenceResult } from './source-revision-evidence.ts';

const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());
const boundedReason = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());
const sameDecision = Schema.toEquivalence(PricingDecisionSchema);
const sameMaterialEvidence = Schema.toEquivalence(PricingMaterialEvidenceReadySchema);
const sameSourceEvidence = Schema.toEquivalence(PricingSourceEvidenceResultSchema);

const materialSources = (evidence: PricingMaterialEvidenceReady): readonly PricingSourceEvidenceResult[] => [
  ...evidence.sourceEvidence.externalOwnerEvidence.catalogSelections.map(({ sourceEvidence }) => sourceEvidence),
  evidence.sourceEvidence.externalOwnerEvidence.market,
  ...(evidence.sourceEvidence.externalOwnerEvidence.priceGroupAssignment === undefined
    ? []
    : [evidence.sourceEvidence.externalOwnerEvidence.priceGroupAssignment]),
  ...(evidence.sourceEvidence.externalOwnerEvidence.promotion.kind === 'PROMOTION_SELECTED'
    ? [evidence.sourceEvidence.externalOwnerEvidence.promotion.sourceEvidence]
    : []),
  evidence.sourceEvidence.currencySupport,
  ...evidence.sourceEvidence.lines.flatMap(({ commercialFees, lineDiscounts, pricePath, quantityTiers, zeroFloor }) => [
    pricePath.usedPrice,
    ...(pricePath.assignedGroupAbsence === undefined ? [] : [pricePath.assignedGroupAbsence]),
    quantityTiers,
    ...(lineDiscounts.kind === 'DISCOUNT_SELECTED' ? [lineDiscounts.sourceEvidence] : []),
    commercialFees,
    ...(zeroFloor === undefined ? [] : [zeroFloor]),
  ]),
  ...(evidence.sourceEvidence.wholePurchase.contractualDiscounts.kind === 'DISCOUNT_SELECTED'
    ? [evidence.sourceEvidence.wholePurchase.contractualDiscounts.sourceEvidence]
    : []),
];

const exactSourceMultiset = (
  bindings: readonly { readonly sourceEvidence: PricingSourceEvidenceResult }[],
  sources: readonly PricingSourceEvidenceResult[],
): boolean => {
  if (bindings.length !== sources.length) {
    return false;
  }
  const matched = new Set<number>();
  return bindings.every(({ sourceEvidence }) => {
    const index = sources.findIndex((source, candidateIndex) =>
      matched.has(candidateIndex) ? false : sameSourceEvidence(sourceEvidence, source),
    );
    if (index === -1) {
      return false;
    }
    matched.add(index);
    return true;
  });
};

/** One permanent Attempt and its exact unchanged pre-attempt Decision Bundle. */
export const PricingCommitmentConfirmationBindingSchema = Schema.Struct({
  attemptRef: stableReference,
  decisionBundleHash: stableReference,
  decisionBundleRef: stableReference,
  decisionBundleVersion: stableReference,
  purchase: PricingQuotationBindingSchema,
});
export type PricingCommitmentConfirmationBinding = typeof PricingCommitmentConfirmationBindingSchema.Type;

/** Full fresh Current lineage; a revision tuple or retained result cannot inhabit this contract. */
export interface PricingCurrentBackedConfirmationSource {
  readonly currentness: typeof PricingFreshAttemptOutcomeSchema.Type;
  readonly currentResult: PricingCurrentCommercialResult;
  readonly kind: 'CURRENT_BACKED';
  readonly materialEvidence: PricingMaterialEvidenceReady;
}

export const PricingCurrentBackedConfirmationSourceSchema: Schema.Codec<
  PricingCurrentBackedConfirmationSource,
  unknown
> = Schema.Struct({
  currentness: Schema.toType(PricingFreshAttemptOutcomeSchema),
  currentResult: Schema.toType(PricingCurrentCommercialResultSchema),
  kind: Schema.Literal('CURRENT_BACKED'),
  materialEvidence: Schema.toType(PricingMaterialEvidenceReadySchema),
}).check(
  Schema.makeFilter(({ currentness, currentResult, materialEvidence }) => {
    const result = currentResult.commercialTotal;
    const { snapshot } = currentness.attempt;
    const sources = materialSources(materialEvidence);
    return result.candidateRef === materialEvidence.candidateRef &&
      result.candidateRef === currentness.attempt.candidateRef &&
      sameDecision(result.decision, snapshot.decision) &&
      Schema.toEquivalence(PricingCommercialTotalReadySchema)(
        result,
        materialEvidence.sourceEvidence.commercialTotal,
      ) &&
      Schema.toEquivalence(PricingMaterialCalculationVersionsSchema)(
        materialEvidence.calculationVersions,
        snapshot.calculationVersions,
      ) &&
      snapshot.requestedAt === materialEvidence.sourceEvidence.requestedAt &&
      snapshot.capturedAt === materialEvidence.validatedAt &&
      exactSourceMultiset(snapshot.materialBindings, sources) &&
      materialEvidence.validatedAt <= currentness.attempt.completedAt
      ? undefined
      : 'Current-backed confirmation source must preserve one fresh complete candidate and final validation';
  }),
);

/** Exact Quotation and its fresh #785 revalidation; ordinary Current pricing is deliberately absent. */
export interface PricingQuotationBackedConfirmationSource {
  readonly kind: 'QUOTATION_BACKED';
  readonly materialEvidence: PricingMaterialEvidenceReady;
  readonly quotationRevalidation: PricingQuotationExactReuse;
}

export const PricingQuotationBackedConfirmationSourceSchema: Schema.Codec<
  PricingQuotationBackedConfirmationSource,
  unknown
> = Schema.Struct({
  kind: Schema.Literal('QUOTATION_BACKED'),
  materialEvidence: Schema.toType(PricingMaterialEvidenceReadySchema),
  quotationRevalidation: Schema.toType(PricingQuotationExactReuseSchema),
}).check(
  Schema.makeFilter(({ materialEvidence, quotationRevalidation }) => {
    const { authenticityEvidence, evaluatedAt, quotation } = quotationRevalidation;
    if (
      !sameMaterialEvidence(materialEvidence, quotation.materialEvidence) ||
      materialEvidence.candidateRef !== quotation.quotedResult.candidateRef ||
      !Schema.toEquivalence(PricingCommercialTotalReadySchema)(
        materialEvidence.sourceEvidence.commercialTotal,
        quotation.quotedResult,
      )
    ) {
      return 'Quotation-backed source must retain the exact material evidence authenticated by the original Quotation';
    }
    return authenticityEvidence.verifiedAt === evaluatedAt &&
      evaluatedAt >= quotation.validity.validFrom &&
      evaluatedAt < quotation.validity.validUntil
      ? undefined
      : 'Quotation-backed source requires one fresh temporally coherent exact revalidation';
  }),
);

export const PricingCommitmentConfirmationSourceSchema = Schema.Union([
  PricingCurrentBackedConfirmationSourceSchema,
  PricingQuotationBackedConfirmationSourceSchema,
]);
export type PricingCommitmentConfirmationSource = typeof PricingCommitmentConfirmationSourceSchema.Type;

/** Issuer proof metadata is part of the immutable instance, but never a bearer permission. */
export const PricingCommitmentConfirmationAuthenticityProofSchema = Schema.Struct({
  authority: Schema.Literal('EVIDENCE_ONLY'),
  issuerRef: stableReference,
  keyRef: stableReference,
  keyVersion: stableReference,
  lineageRef: stableReference,
  payloadDigest: stableReference,
  proofRef: stableReference,
  proofVersion: stableReference,
});
export type PricingCommitmentConfirmationAuthenticityProof =
  typeof PricingCommitmentConfirmationAuthenticityProofSchema.Type;

/** Strict half-open commitment interval. The issued instance, not ordinary source state, owns it. */
export const PricingCommitmentConfirmationValiditySchema = Schema.Struct({
  expiresAt: PricingInstantSchema,
  issuedAt: PricingInstantSchema,
}).check(
  Schema.makeFilter(({ expiresAt, issuedAt }) => {
    const issuedMilliseconds = DateTime.toEpochMillis(DateTime.makeUnsafe(issuedAt));
    const expiresMilliseconds = DateTime.toEpochMillis(DateTime.makeUnsafe(expiresAt));
    return expiresMilliseconds > issuedMilliseconds && expiresMilliseconds - issuedMilliseconds <= 30_000
      ? undefined
      : 'Pricing Commitment Confirmation requires a non-empty interval of at most 30 seconds';
  }),
);
export type PricingCommitmentConfirmationValidity = typeof PricingCommitmentConfirmationValiditySchema.Type;

const samePurchase = Schema.toEquivalence(PricingQuotationBindingSchema);
const sameTerms = Schema.toEquivalence(PricingCommercialTotalReadySchema);
const sameCatalogSelection = Schema.toEquivalence(PricingCatalogSelectionSchema);

const purchaseMatchesTerms = (purchase: PricingQuotationBinding, terms: PricingCommercialTotalReady): boolean => {
  const { decision } = terms;
  return (
    purchase.candidateRef === terms.candidateRef &&
    purchase.tenantId === decision.tenantId &&
    purchase.currencyCode === decision.currencyCode &&
    purchase.monetaryBoundary === decision.monetaryBoundary &&
    purchase.commercialScope.channelId === decision.commercialScope.channelId &&
    purchase.commercialScope.marketId === decision.commercialScope.marketId &&
    purchase.commercialScope.sellingLegalEntityId === decision.commercialScope.sellingLegalEntityId &&
    purchase.subject.purchaseContext.contextRef === decision.purchasingContext.contextRef &&
    purchase.subject.purchaseContext.contextRevision === decision.purchasingContext.contextRevision &&
    purchase.lines.length === decision.lines.length &&
    purchase.lines.every((line, index) => {
      const decisionLine = decision.lines[index];
      return (
        decisionLine !== undefined &&
        line.occurrenceId === decisionLine.occurrenceId &&
        sameCatalogSelection(line.selection, decisionLine.catalog.selection) &&
        line.quantity.amount === decisionLine.catalog.quantity.resulting &&
        line.quantity.unitRef.moduleId === decisionLine.catalog.unitRef.moduleId &&
        line.quantity.unitRef.resourceId === decisionLine.catalog.unitRef.resourceId &&
        line.quantity.unitRef.resourceType === decisionLine.catalog.unitRef.resourceType &&
        line.quantity.unitRef.tenantId === decisionLine.catalog.unitRef.tenantId
      );
    })
  );
};

export interface PricingCommitmentConfirmationIssued {
  readonly authenticity: PricingCommitmentConfirmationAuthenticityProof;
  readonly binding: PricingCommitmentConfirmationBinding;
  readonly confirmationRef: string;
  readonly expiresAt: typeof PricingInstantSchema.Type;
  readonly issuedAt: typeof PricingInstantSchema.Type;
  readonly kind: 'PRICING_COMMITMENT_CONFIRMATION';
  readonly source: PricingCommitmentConfirmationSource;
  readonly terms: PricingCommercialTotalReady;
}

export const PricingCommitmentConfirmationIssuedSchema: Schema.Codec<PricingCommitmentConfirmationIssued, unknown> =
  Schema.Struct({
    authenticity: PricingCommitmentConfirmationAuthenticityProofSchema,
    binding: PricingCommitmentConfirmationBindingSchema,
    confirmationRef: stableReference,
    expiresAt: PricingInstantSchema,
    issuedAt: PricingInstantSchema,
    kind: Schema.Literal('PRICING_COMMITMENT_CONFIRMATION'),
    source: Schema.toType(PricingCommitmentConfirmationSourceSchema),
    terms: Schema.toType(PricingCommercialTotalReadySchema),
  }).check(
    Schema.makeFilter(({ binding, expiresAt, issuedAt, source, terms }) => {
      if (!Schema.is(PricingCommitmentConfirmationValiditySchema)({ expiresAt, issuedAt })) {
        return 'Pricing Commitment Confirmation requires a non-empty interval of at most 30 seconds';
      }
      if (
        terms.decision.currencyCode !== 'CZK' ||
        terms.pricingNetCommercialTotal.currencyCode !== 'CZK' ||
        terms.decision.monetaryBoundary !== 'PRE_TAX'
      ) {
        return 'Launch Pricing Commitment Confirmation requires native CZK pre-Tax terms without FX';
      }
      if (!purchaseMatchesTerms(binding.purchase, terms)) {
        return 'Pricing Commitment Confirmation must preserve the exact bound purchase and terms';
      }
      if (source.kind === 'CURRENT_BACKED') {
        const sources = materialSources(source.materialEvidence);
        return sameTerms(source.currentResult.commercialTotal, terms) &&
          source.currentness.attempt.completedAt <= issuedAt &&
          source.materialEvidence.validatedAt <= issuedAt &&
          sources.every((evidence) => {
            if (
              !Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(evidence) &&
              !Schema.is(PricingSourceEvidenceVerifiedAbsentSchema)(evidence)
            ) {
              return false;
            }
            const { nextMaterialBoundary } = evidence.completeness.temporal;
            return nextMaterialBoundary === undefined || issuedAt < nextMaterialBoundary;
          })
          ? undefined
          : 'Current-backed Confirmation must use exact fresh complete Current terms at issuance';
      }
      const { quotation } = source.quotationRevalidation;
      if (expiresAt > quotation.validity.validUntil) {
        return 'Quotation-backed Confirmation cannot outlive its source Quotation';
      }
      const revalidatedMilliseconds = DateTime.toEpochMillis(
        DateTime.makeUnsafe(source.quotationRevalidation.evaluatedAt),
      );
      const issuedMilliseconds = DateTime.toEpochMillis(DateTime.makeUnsafe(issuedAt));
      return samePurchase(binding.purchase, quotation.binding) &&
        sameTerms(quotation.quotedResult, terms) &&
        revalidatedMilliseconds <= issuedMilliseconds &&
        issuedMilliseconds - revalidatedMilliseconds <= 30_000
        ? undefined
        : 'Quotation-backed Confirmation must preserve one fresh exact revalidated Quotation binding and terms';
    }),
  );

export const PricingCurrentBackedConfirmationIssuanceRequestSchema = Schema.Struct({
  binding: PricingCommitmentConfirmationBindingSchema,
  kind: Schema.Literal('ISSUE_CURRENT_BACKED_PRICING_CONFIRMATION'),
  source: PricingCurrentBackedConfirmationSourceSchema,
});
export type PricingCurrentBackedConfirmationIssuanceRequest =
  typeof PricingCurrentBackedConfirmationIssuanceRequestSchema.Type;

export const PricingQuotationBackedConfirmationIssuanceRequestSchema = Schema.Struct({
  binding: PricingCommitmentConfirmationBindingSchema,
  kind: Schema.Literal('ISSUE_QUOTATION_BACKED_PRICING_CONFIRMATION'),
  source: PricingQuotationBackedConfirmationSourceSchema,
});
export type PricingQuotationBackedConfirmationIssuanceRequest =
  typeof PricingQuotationBackedConfirmationIssuanceRequestSchema.Type;

export const PricingCommitmentConfirmationIssuanceRequestSchema = Schema.Union([
  PricingCurrentBackedConfirmationIssuanceRequestSchema,
  PricingQuotationBackedConfirmationIssuanceRequestSchema,
]);
export type PricingCommitmentConfirmationIssuanceRequest =
  typeof PricingCommitmentConfirmationIssuanceRequestSchema.Type;

export const PricingCommitmentConfirmationIssuedOutcomeSchema = Schema.TaggedStruct('ISSUED', {
  confirmation: Schema.toType(PricingCommitmentConfirmationIssuedSchema),
});
export const PricingCommitmentConfirmationBindingMismatchSchema = Schema.TaggedStruct('BINDING_MISMATCH', {
  confirmationRef: Schema.optionalKey(stableReference),
  reason: Schema.Literals([
    'ATTEMPT_CHANGED',
    'ATTEMPT_NOT_FOUND',
    'BUNDLE_CHANGED',
    'PURCHASE_CHANGED',
    'CANDIDATE_CHANGED',
    'AUTHORITY_CONTEXT_CHANGED',
    'COMMERCIAL_SCOPE_CHANGED',
    'CURRENCY_OR_BASIS_CHANGED',
    'OCCURRENCE_STRUCTURE_CHANGED',
    'SELECTION_CHANGED',
    'QUANTITY_OR_UNIT_CHANGED',
  ]),
  retryable: Schema.Literal(false),
});
export const PricingCommitmentConfirmationSourceInvalidSchema = Schema.TaggedStruct('SOURCE_INVALID', {
  reason: boundedReason,
  retryable: Schema.Literal(false),
});
export const PricingCommitmentConfirmationSourceUnverifiableSchema = Schema.TaggedStruct('SOURCE_UNVERIFIABLE', {
  reason: boundedReason,
  retryable: Schema.Boolean,
});
export const PricingCommitmentConfirmationIssuanceOutcomeSchema = Schema.Union([
  PricingCommitmentConfirmationIssuedOutcomeSchema,
  PricingCommitmentConfirmationBindingMismatchSchema,
  PricingCommitmentConfirmationSourceInvalidSchema,
  PricingCommitmentConfirmationSourceUnverifiableSchema,
]);
export type PricingCommitmentConfirmationIssuanceOutcome =
  typeof PricingCommitmentConfirmationIssuanceOutcomeSchema.Type;

export const PricingCommitmentConfirmationRenewalRequestSchema = Schema.Struct({
  binding: PricingCommitmentConfirmationBindingSchema,
  kind: Schema.Literal('RENEW_PRICING_COMMITMENT_CONFIRMATION'),
  previousConfirmation: Schema.toType(PricingCommitmentConfirmationIssuedSchema),
});
export type PricingCommitmentConfirmationRenewalRequest = typeof PricingCommitmentConfirmationRenewalRequestSchema.Type;

export const PricingCommitmentConfirmationRenewedOutcomeSchema = Schema.TaggedStruct('RENEWED', {
  confirmation: Schema.toType(PricingCommitmentConfirmationIssuedSchema),
  previousConfirmationRef: stableReference,
}).check(
  Schema.makeFilter(({ confirmation, previousConfirmationRef }) =>
    confirmation.confirmationRef === previousConfirmationRef
      ? 'Renewal must mint a new immutable Confirmation identity'
      : undefined,
  ),
);
export const PricingCommitmentConfirmationReplacementBundleRequiredSchema = Schema.TaggedStruct(
  'REPLACEMENT_BUNDLE_REQUIRED',
  {
    reason: Schema.Literals(['BUNDLE_CHANGED', 'TERMS_CHANGED', 'SOURCE_EVIDENCE_CHANGED']),
    retryable: Schema.Literal(false),
  },
);
export const PricingCommitmentConfirmationRenewalOutcomeSchema = Schema.Union([
  PricingCommitmentConfirmationRenewedOutcomeSchema,
  PricingCommitmentConfirmationReplacementBundleRequiredSchema,
  PricingCommitmentConfirmationBindingMismatchSchema,
  PricingCommitmentConfirmationSourceInvalidSchema,
  PricingCommitmentConfirmationSourceUnverifiableSchema,
]);
export type PricingCommitmentConfirmationRenewalOutcome = typeof PricingCommitmentConfirmationRenewalOutcomeSchema.Type;

export const PricingCommitmentConfirmationVerificationRequestSchema = Schema.Struct({
  attemptedAt: PricingInstantSchema,
  confirmation: Schema.toType(PricingCommitmentConfirmationIssuedSchema),
  kind: Schema.Literal('VERIFY_PRICING_COMMITMENT_CONFIRMATION'),
  requestedBinding: PricingCommitmentConfirmationBindingSchema,
});
export type PricingCommitmentConfirmationVerificationRequest =
  typeof PricingCommitmentConfirmationVerificationRequestSchema.Type;

export const PricingCommitmentConfirmationVerificationEvidenceSchema = Schema.Struct({
  authenticityRef: stableReference,
  confirmationRef: stableReference,
  issuerRef: stableReference,
  keyRef: stableReference,
  keyStatus: Schema.Literals(['ACTIVE', 'HISTORICAL']),
  keyVersion: stableReference,
  lineageRef: stableReference,
  payloadDigest: stableReference,
  proofRef: stableReference,
  proofVersion: stableReference,
  verifiedAt: PricingInstantSchema,
});
export type PricingCommitmentConfirmationVerificationEvidence =
  typeof PricingCommitmentConfirmationVerificationEvidenceSchema.Type;

export const PricingCommitmentConfirmationVerifiedSchema = Schema.TaggedStruct('VERIFIED', {
  authenticityEvidence: PricingCommitmentConfirmationVerificationEvidenceSchema,
  confirmation: Schema.toType(PricingCommitmentConfirmationIssuedSchema),
  verifiedAt: PricingInstantSchema,
}).check(
  Schema.makeFilter(({ authenticityEvidence, confirmation, verifiedAt }) =>
    authenticityEvidence.confirmationRef === confirmation.confirmationRef &&
    authenticityEvidence.issuerRef === confirmation.authenticity.issuerRef &&
    authenticityEvidence.keyRef === confirmation.authenticity.keyRef &&
    authenticityEvidence.keyVersion === confirmation.authenticity.keyVersion &&
    authenticityEvidence.lineageRef === confirmation.authenticity.lineageRef &&
    authenticityEvidence.payloadDigest === confirmation.authenticity.payloadDigest &&
    authenticityEvidence.proofRef === confirmation.authenticity.proofRef &&
    authenticityEvidence.proofVersion === confirmation.authenticity.proofVersion &&
    authenticityEvidence.verifiedAt === verifiedAt &&
    confirmation.issuedAt <= verifiedAt &&
    verifiedAt < confirmation.expiresAt
      ? undefined
      : 'Verification evidence must authenticate the exact usable Confirmation instance',
  ),
);

const confirmationTemporalFields = {
  confirmationRef: stableReference,
  evaluatedAt: PricingInstantSchema,
};
export const PricingCommitmentConfirmationExpiredSchema = Schema.TaggedStruct('EXPIRED', {
  ...confirmationTemporalFields,
  expiresAt: PricingInstantSchema,
}).check(
  Schema.makeFilter(({ evaluatedAt, expiresAt }) =>
    evaluatedAt >= expiresAt ? undefined : 'EXPIRED requires trusted time at or after expiresAt',
  ),
);
export const PricingCommitmentConfirmationNotYetValidSchema = Schema.TaggedStruct('NOT_YET_VALID', {
  ...confirmationTemporalFields,
  issuedAt: PricingInstantSchema,
}).check(
  Schema.makeFilter(({ evaluatedAt, issuedAt }) =>
    evaluatedAt < issuedAt ? undefined : 'NOT_YET_VALID requires trusted time before issuedAt',
  ),
);
export const PricingCommitmentConfirmationAuthenticityInvalidSchema = Schema.TaggedStruct('AUTHENTICITY_INVALID', {
  confirmationRef: stableReference,
  reason: Schema.Literals(['INVALID_PROOF', 'PAYLOAD_TAMPERED']),
  retryable: Schema.Literal(false),
});
export const PricingCommitmentConfirmationAuthenticityUnverifiableSchema = Schema.TaggedStruct(
  'AUTHENTICITY_UNVERIFIABLE',
  {
    confirmationRef: stableReference,
    reason: Schema.Literals([
      'DEPENDENCY_UNAVAILABLE',
      'LINEAGE_UNVERIFIABLE',
      'MISSING_PROOF',
      'RETIRED_KEY_WITHOUT_LINEAGE',
      'UNKNOWN_KEY',
      'UNSUPPORTED_KEY_VERSION',
    ]),
    retryable: Schema.Boolean,
  },
).check(
  Schema.makeFilter(({ reason, retryable }) =>
    retryable === (reason === 'DEPENDENCY_UNAVAILABLE')
      ? undefined
      : 'Only an unavailable Confirmation authenticity dependency is retryable',
  ),
);
export const PricingCommitmentConfirmationBindingUnverifiableSchema = Schema.TaggedStruct('BINDING_UNVERIFIABLE', {
  confirmationRef: stableReference,
  reason: boundedReason,
  retryable: Schema.Literal(true),
});
export const PricingCommitmentConfirmationValidityUnverifiableSchema = Schema.TaggedStruct('VALIDITY_UNVERIFIABLE', {
  confirmationRef: stableReference,
  reason: Schema.Literal('TRUSTED_TIME_UNAVAILABLE'),
  retryable: Schema.Literal(true),
});
export const PricingCommitmentConfirmationVerificationOutcomeSchema = Schema.Union([
  PricingCommitmentConfirmationVerifiedSchema,
  PricingCommitmentConfirmationExpiredSchema,
  PricingCommitmentConfirmationNotYetValidSchema,
  PricingCommitmentConfirmationAuthenticityInvalidSchema,
  PricingCommitmentConfirmationAuthenticityUnverifiableSchema,
  PricingCommitmentConfirmationBindingMismatchSchema,
  PricingCommitmentConfirmationBindingUnverifiableSchema,
  PricingCommitmentConfirmationValidityUnverifiableSchema,
]);
export type PricingCommitmentConfirmationVerificationOutcome =
  typeof PricingCommitmentConfirmationVerificationOutcomeSchema.Type;
