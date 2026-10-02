import { Schema } from 'effect';

import {
  PricingCurrencySupportGenerationSchema,
  PricingInstantSchema,
  PricingNonEmptyCurrencyCodeSetSchema,
} from './currency-support.ts';
import { PricingCommitmentConfirmationVerifiedSchema } from './commitment-confirmation.ts';
import { PricingCommercialTotalReadySchema } from './commercial-total.ts';
import type { PricingCommercialTotalReady } from './commercial-total.ts';
import { PricingMaterialEvidenceReadySchema } from './material-evidence.ts';
import type { PricingMaterialEvidenceReady } from './material-evidence.ts';
import {
  PricingSourceEvidenceOwnerScopeSchema,
  PricingSourceEvidenceReferenceSchema,
  PricingSourceEvidenceVerifiedPresentSchema,
  PricingSourceFactEffectivePeriodSchema,
} from './source-revision-evidence.ts';

const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());
const sameCommercialTotal = Schema.toEquivalence(PricingCommercialTotalReadySchema);
const sameMaterialEvidence = Schema.toEquivalence(PricingMaterialEvidenceReadySchema);
const sameOwnerScope = Schema.toEquivalence(PricingSourceEvidenceOwnerScopeSchema);

/**
 * Explicit corrective lineage preserves the original qualified legacy reference. The successor is
 * additional audit evidence and never replaces or relabels the historical source.
 */
export const PricingAcceptedCorrectiveMigrationLineageSchema = Schema.Struct({
  auditRef: PricingSourceEvidenceReferenceSchema,
  migratedAt: PricingInstantSchema,
  migrationRef: PricingSourceEvidenceReferenceSchema,
  successorOwnerScope: PricingSourceEvidenceOwnerScopeSchema,
  successorSupportRevisionRef: PricingSourceEvidenceReferenceSchema,
});
export type PricingAcceptedCorrectiveMigrationLineage = typeof PricingAcceptedCorrectiveMigrationLineageSchema.Type;

/**
 * Owner-, Tenant-, root-, predicate-, and generation-qualified historical Currency Support.
 * Currency codes are intentionally generalized for already accepted history; this does not enable
 * any currency for new Launch issuance.
 */
export const PricingAcceptedLegacyCurrencySupportReferenceSchema = Schema.Struct({
  correctiveMigrationLineage: Schema.optionalKey(PricingAcceptedCorrectiveMigrationLineageSchema),
  effectivePeriod: PricingSourceFactEffectivePeriodSchema,
  generation: PricingCurrencySupportGenerationSchema,
  ownerScope: PricingSourceEvidenceOwnerScopeSchema,
  supportedCurrencies: PricingNonEmptyCurrencyCodeSetSchema,
  supportRevisionRef: PricingSourceEvidenceReferenceSchema,
  verificationRef: PricingSourceEvidenceReferenceSchema,
}).check(
  Schema.makeFilter(({ correctiveMigrationLineage, ownerScope, supportRevisionRef }) =>
    correctiveMigrationLineage !== undefined &&
    (correctiveMigrationLineage.successorOwnerScope.tenantId !== ownerScope.tenantId ||
      (sameOwnerScope(correctiveMigrationLineage.successorOwnerScope, ownerScope) &&
        correctiveMigrationLineage.successorSupportRevisionRef === supportRevisionRef))
      ? 'Corrective migration lineage must identify a distinct successor in the same Tenant without replacing the original source'
      : undefined,
  ),
);
export type PricingAcceptedLegacyCurrencySupportReference =
  typeof PricingAcceptedLegacyCurrencySupportReferenceSchema.Type;

const confirmationBindingFields = {
  attemptRef: stableReference,
  confirmationRef: stableReference,
  decisionBundleHash: stableReference,
  decisionBundleRef: stableReference,
  decisionBundleVersion: stableReference,
} as const;

/** Exact Current evaluation to the concrete Confirmation used by the accepted commitment. */
export const PricingAcceptedCurrentLineageSchema = Schema.Struct({
  ...confirmationBindingFields,
  kind: Schema.Literal('CURRENT_TO_CONFIRMATION'),
  materialEvidenceValidatedAt: PricingInstantSchema,
});
export type PricingAcceptedCurrentLineage = typeof PricingAcceptedCurrentLineageSchema.Type;

/** Exact original Quotation and fresh revalidation to the concrete Confirmation used at commit. */
export const PricingAcceptedQuotationLineageSchema = Schema.Struct({
  ...confirmationBindingFields,
  kind: Schema.Literal('QUOTATION_TO_CONFIRMATION'),
  quotationIssuedAt: PricingInstantSchema,
  quotationRef: stableReference,
  quotationRevalidatedAt: PricingInstantSchema,
});
export type PricingAcceptedQuotationLineage = typeof PricingAcceptedQuotationLineageSchema.Type;

export const PricingAcceptedOrderHandoffLineageSchema = Schema.Union([
  PricingAcceptedCurrentLineageSchema,
  PricingAcceptedQuotationLineageSchema,
]);
export type PricingAcceptedOrderHandoffLineage = typeof PricingAcceptedOrderHandoffLineageSchema.Type;

const lineageBindsConfirmation = (
  lineage: PricingAcceptedOrderHandoffLineage,
  confirmation: (typeof PricingCommitmentConfirmationVerifiedSchema.Type)['confirmation'],
): boolean => {
  const { binding } = confirmation;
  if (
    lineage.attemptRef !== binding.attemptRef ||
    lineage.confirmationRef !== confirmation.confirmationRef ||
    lineage.decisionBundleHash !== binding.decisionBundleHash ||
    lineage.decisionBundleRef !== binding.decisionBundleRef ||
    lineage.decisionBundleVersion !== binding.decisionBundleVersion
  ) {
    return false;
  }
  if (confirmation.source.kind === 'CURRENT_BACKED') {
    return (
      lineage.kind === 'CURRENT_TO_CONFIRMATION' &&
      lineage.materialEvidenceValidatedAt === confirmation.source.materialEvidence.validatedAt
    );
  }
  const { quotationRevalidation } = confirmation.source;
  return (
    lineage.kind === 'QUOTATION_TO_CONFIRMATION' &&
    lineage.quotationRef === quotationRevalidation.quotation.quotationRef &&
    lineage.quotationIssuedAt === quotationRevalidation.quotation.issuedAt &&
    lineage.quotationRevalidatedAt === quotationRevalidation.evaluatedAt
  );
};

const qualifiedLegacyReferencesAreCoherent = (
  references: readonly PricingAcceptedLegacyCurrencySupportReference[],
  tenantId: string,
): boolean => {
  const hasDuplicateIdentity = references.some((reference, index) =>
    references
      .slice(index + 1)
      .some(
        (later) =>
          reference.generation === later.generation &&
          reference.supportRevisionRef === later.supportRevisionRef &&
          sameOwnerScope(reference.ownerScope, later.ownerScope),
      ),
  );
  return references.every(({ ownerScope }) => ownerScope.tenantId === tenantId) && !hasDuplicateIdentity;
};

const currencySupportBindsAcceptedTerms = (
  materialEvidence: PricingMaterialEvidenceReady,
  terms: PricingCommercialTotalReady,
): boolean => {
  const {
    sourceEvidence: { currencySupport },
  } = materialEvidence;
  return (
    Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(currencySupport) &&
    currencySupport.request.family === 'CURRENCY_SUPPORT' &&
    currencySupport.request.currencyCode === terms.decision.currencyCode &&
    currencySupport.request.ownerScope.tenantId === terms.decision.tenantId &&
    currencySupport.currentFacts.some(
      ({ currencyCode, ownerScope }) =>
        currencyCode === terms.decision.currencyCode && ownerScope.tenantId === terms.decision.tenantId,
    )
  );
};

export interface PricingAcceptedOrderHandoff {
  readonly acceptedAt: typeof PricingInstantSchema.Type;
  readonly commitmentVerification: typeof PricingCommitmentConfirmationVerifiedSchema.Type;
  readonly handoffRef: string;
  readonly kind: 'PRICING_ACCEPTED_ORDER_HANDOFF';
  readonly lineage: PricingAcceptedOrderHandoffLineage;
  readonly materialEvidence: PricingMaterialEvidenceReady;
  readonly owner: { readonly moduleId: 'commerce.pricing'; readonly scopeRef: string };
  readonly qualifiedLegacyCurrencySupportReferences: readonly PricingAcceptedLegacyCurrencySupportReference[];
  readonly terms: PricingCommercialTotalReady;
}

/**
 * Immutable Pricing-produced Accepted handoff. It retains the complete original calculation and
 * owner proof graph; downstream projections must not replace this owner-to-owner payload.
 */
export const PricingAcceptedOrderHandoffSchema: Schema.Codec<PricingAcceptedOrderHandoff, unknown> = Schema.Struct({
  acceptedAt: PricingInstantSchema,
  commitmentVerification: Schema.toType(PricingCommitmentConfirmationVerifiedSchema),
  handoffRef: stableReference,
  kind: Schema.Literal('PRICING_ACCEPTED_ORDER_HANDOFF'),
  lineage: PricingAcceptedOrderHandoffLineageSchema,
  materialEvidence: Schema.toType(PricingMaterialEvidenceReadySchema),
  owner: Schema.Struct({ moduleId: Schema.Literal('commerce.pricing'), scopeRef: stableReference }),
  qualifiedLegacyCurrencySupportReferences: Schema.Array(PricingAcceptedLegacyCurrencySupportReferenceSchema).check(
    Schema.isMaxLength(1000),
  ),
  terms: Schema.toType(PricingCommercialTotalReadySchema),
}).check(
  Schema.makeFilter((handoff) => {
    const { acceptedAt, commitmentVerification, lineage, materialEvidence, terms } = handoff;
    const { confirmation } = commitmentVerification;
    if (acceptedAt !== commitmentVerification.verifiedAt) {
      return 'Accepted handoff time must equal the verification instant of the actual used Confirmation';
    }
    if (!sameCommercialTotal(confirmation.terms, terms)) {
      return 'Accepted handoff must preserve the exact terms carried by the used Confirmation';
    }
    if (
      materialEvidence.candidateRef !== terms.candidateRef ||
      !sameCommercialTotal(materialEvidence.sourceEvidence.commercialTotal, terms)
    ) {
      return 'Accepted handoff must preserve the complete original material evidence for its exact terms';
    }
    if (!currencySupportBindsAcceptedTerms(materialEvidence, terms)) {
      return 'Accepted handoff requires owner-verifiable Tenant Currency Support evidence for its exact currency';
    }
    if (!lineageBindsConfirmation(lineage, confirmation)) {
      return 'Accepted handoff lineage must bind the actual Confirmation, Attempt, Bundle, and guarantee source';
    }
    if (confirmation.source.kind === 'CURRENT_BACKED') {
      if (!sameMaterialEvidence(confirmation.source.materialEvidence, materialEvidence)) {
        return 'Current-backed Accepted handoff must preserve the exact confirmed Current material evidence';
      }
    } else if (!sameMaterialEvidence(confirmation.source.materialEvidence, materialEvidence)) {
      return 'Quotation-backed Accepted handoff must preserve the exact evidence signed into the used Confirmation';
    }
    if (
      terms.decision.currencyCode !== 'CZK' ||
      terms.pricingNetCommercialTotal.currencyCode !== 'CZK' ||
      terms.decision.monetaryBoundary !== 'PRE_TAX'
    ) {
      return 'Launch Accepted handoff requires native CZK pre-Tax terms without FX';
    }
    return qualifiedLegacyReferencesAreCoherent(
      handoff.qualifiedLegacyCurrencySupportReferences,
      terms.decision.tenantId,
    )
      ? undefined
      : 'Legacy Currency Support references must be Tenant-qualified, distinct historical identities';
  }),
);

/** Lossless provider-safe wire codec; it intentionally includes internal owner-verifiable evidence. */
export const PricingAcceptedOrderHandoffWireSchema = Schema.toCodecJson(PricingAcceptedOrderHandoffSchema);
