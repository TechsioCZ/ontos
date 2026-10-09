import { Schema } from 'effect';

import {
  AssortmentDecisionSubjectSchema,
  AssortmentEvidenceReferenceSchema,
  AssortmentTrustedCommerceContextSchema,
  CatalogProductRefSchema,
} from './decision-contracts.ts';
import type {
  AssortmentDecisionSubject,
  AssortmentEvidenceReference,
  AssortmentOwnerResourceRef,
  AssortmentTrustedCommerceContext,
} from './decision-contracts.ts';

const sameRef = (left: AssortmentOwnerResourceRef, right: AssortmentOwnerResourceRef): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const subjectReference = (subject: AssortmentDecisionSubject): AssortmentOwnerResourceRef => {
  if (subject.kind === 'GUEST_PURCHASE_CONTEXT') {
    return subject.guestEvidence.evidenceRef;
  }
  return subject.subject.kind === 'RETAIL_CUSTOMER_PROFILE'
    ? subject.subject.profileRef
    : subject.subject.counterpartyRef;
};

const disclosureContextTenant = (context: {
  readonly subject: AssortmentDecisionSubject;
  readonly trustedContext: AssortmentTrustedCommerceContext;
}): string => context.trustedContext.tenantId;

const disclosureContextReferences = (context: {
  readonly subject: AssortmentDecisionSubject;
  readonly trustedContext: AssortmentTrustedCommerceContext;
}): readonly AssortmentOwnerResourceRef[] => [subjectReference(context.subject)];

const proofBelongsToTenant = (proof: AssortmentEvidenceReference, tenantId: string): boolean =>
  proof.evidenceRef.tenantId === tenantId &&
  (proof.sourceRevision === undefined || proof.sourceRevision.sourceRef.tenantId === tenantId);

const DisclosureContextFields = {
  decisionPurpose: Schema.Literal('VISIBILITY'),
  subject: AssortmentDecisionSubjectSchema,
  trustedContext: AssortmentTrustedCommerceContextSchema,
} as const;
const AssortmentOwnerModuleId = 'commerce.assortment' as const;

/**
 * The exact scope in which Assortment may permit derived Product disclosure.
 * Principal identity is deliberately absent: it is actor context, not the
 * Guest or Purchasing Subject whose Product disclosure meaning is evaluated.
 */
export const AssortmentDiscoveryDisclosureContextSchema = Schema.Struct(DisclosureContextFields).check(
  Schema.makeFilter((context) => {
    const tenantId = disclosureContextTenant(context);
    return context.trustedContext.tenantId === tenantId &&
      disclosureContextReferences(context).every((reference) => reference.tenantId === tenantId)
      ? undefined
      : 'Discovery Disclosure context references must share the trusted context tenant';
  }),
);
export type AssortmentDiscoveryDisclosureContext = typeof AssortmentDiscoveryDisclosureContextSchema.Type;

const coverageContextMatches = (
  left: AssortmentDiscoveryDisclosureContext,
  right: AssortmentDiscoveryDisclosureContext,
): boolean =>
  left.decisionPurpose === right.decisionPurpose &&
  Schema.toEquivalence(AssortmentDecisionSubjectSchema)(left.subject, right.subject) &&
  left.trustedContext.tenantId === right.trustedContext.tenantId &&
  Schema.toEquivalence(AssortmentTrustedCommerceContextSchema)(left.trustedContext, right.trustedContext);

const DisclosureCoverageBaseFields = {
  context: AssortmentDiscoveryDisclosureContextSchema,
  productRef: CatalogProductRefSchema,
  proof: AssortmentEvidenceReferenceSchema,
} as const;

export const AssortmentDiscoveryDisclosureEstablishedCoverageSchema = Schema.Struct({
  ...DisclosureCoverageBaseFields,
  state: Schema.Literal('ESTABLISHED'),
}).check(
  Schema.makeFilter((coverage) =>
    coverage.proof.ownerModuleId === AssortmentOwnerModuleId &&
    coverage.productRef.tenantId === coverage.context.trustedContext.tenantId &&
    proofBelongsToTenant(coverage.proof, coverage.context.trustedContext.tenantId)
      ? undefined
      : 'Disclosure coverage proof must be Assortment-owned and belong to the exact context tenant',
  ),
);
export type AssortmentDiscoveryDisclosureEstablishedCoverage =
  typeof AssortmentDiscoveryDisclosureEstablishedCoverageSchema.Type;

const AssortmentDiscoveryDisclosureInvalidatedCoverageSchema = Schema.Struct({
  ...DisclosureCoverageBaseFields,
  state: Schema.Literal('INVALIDATED'),
}).check(
  Schema.makeFilter((coverage) =>
    coverage.proof.ownerModuleId === AssortmentOwnerModuleId &&
    coverage.productRef.tenantId === coverage.context.trustedContext.tenantId &&
    proofBelongsToTenant(coverage.proof, coverage.context.trustedContext.tenantId)
      ? undefined
      : 'Disclosure invalidation proof must be Assortment-owned and belong to the exact context tenant',
  ),
);

/** Coverage is an owner-proofed allowance state, never an Assortment outcome. */
export const AssortmentDiscoveryDisclosureCoverageSchema = Schema.Union([
  AssortmentDiscoveryDisclosureEstablishedCoverageSchema,
  AssortmentDiscoveryDisclosureInvalidatedCoverageSchema,
]);
export type AssortmentDiscoveryDisclosureCoverage = typeof AssortmentDiscoveryDisclosureCoverageSchema.Type;

/** A known invalidation removes the prior positive allowance until re-established. */
export const AssortmentDiscoveryDisclosureInvalidationSchema = AssortmentDiscoveryDisclosureInvalidatedCoverageSchema;
export type AssortmentDiscoveryDisclosureInvalidation = typeof AssortmentDiscoveryDisclosureInvalidationSchema.Type;

/**
 * Explicit Assortment-owned proof for reusing one Product's disclosure across
 * two contexts. Matching tenant, Product, or cache identity alone is not
 * equivalence.
 */
export const AssortmentDiscoveryDisclosureEquivalenceSchema = Schema.Struct({
  kind: Schema.Literal('ASSORTMENT_PROVEN_CONTEXT_EQUIVALENCE'),
  productRef: CatalogProductRefSchema,
  proof: AssortmentEvidenceReferenceSchema,
  source: AssortmentDiscoveryDisclosureContextSchema,
  target: AssortmentDiscoveryDisclosureContextSchema,
}).check(
  Schema.makeFilter((equivalence) => {
    const sourceTenant = equivalence.source.trustedContext.tenantId;
    const proofIsAssortmentOwned = equivalence.proof.ownerModuleId === AssortmentOwnerModuleId;
    const productIsCoherent =
      equivalence.productRef.tenantId === sourceTenant &&
      equivalence.productRef.tenantId === equivalence.target.trustedContext.tenantId;
    const proofIsCoherent = proofBelongsToTenant(equivalence.proof, sourceTenant);
    return proofIsAssortmentOwned && productIsCoherent && proofIsCoherent
      ? undefined
      : 'Disclosure equivalence requires an Assortment proof for the same Product and tenant';
  }),
);
export type AssortmentDiscoveryDisclosureEquivalence = typeof AssortmentDiscoveryDisclosureEquivalenceSchema.Type;

/**
 * Internal-only discovery result. It records only safe inclusions and the
 * fact that at least one Product/slice was omitted; it never exposes omitted
 * identities, counts, reasons, or authoritative Assortment outcomes.
 */
export const AssortmentPartialDiscoveryResultSchema = Schema.Struct({
  context: AssortmentDiscoveryDisclosureContextSchema,
  includedProductRefs: Schema.Array(CatalogProductRefSchema),
  knownOmission: Schema.Literal(true),
}).check(
  Schema.makeFilter((result) => {
    const {
      trustedContext: { tenantId },
    } = result.context;
    const tenantSafe = result.includedProductRefs.every((productRef) => productRef.tenantId === tenantId);
    const unique = result.includedProductRefs.every((productRef, index, products) =>
      products.slice(0, index).every((previous) => !sameRef(previous, productRef)),
    );
    return tenantSafe && unique
      ? undefined
      : 'Partial discovery inclusions must be unique and belong to the context tenant';
  }),
);
export type AssortmentPartialDiscoveryResult = typeof AssortmentPartialDiscoveryResultSchema.Type;

const AssortmentDiscoveryIncludeDecisionSchema = Schema.Struct({
  context: AssortmentDiscoveryDisclosureContextSchema,
  coverage: AssortmentDiscoveryDisclosureEstablishedCoverageSchema,
  decision: Schema.Literal('INCLUDE'),
  productRef: CatalogProductRefSchema,
}).check(
  Schema.makeFilter((decision) =>
    coverageContextMatches(decision.context, decision.coverage.context) &&
    Schema.toEquivalence(CatalogProductRefSchema)(decision.productRef, decision.coverage.productRef)
      ? undefined
      : 'Discovery inclusion coverage must describe the exact included context',
  ),
);

const AssortmentDiscoveryOmitDecisionSchema = Schema.Struct({
  context: AssortmentDiscoveryDisclosureContextSchema,
  coverage: Schema.optionalKey(AssortmentDiscoveryDisclosureCoverageSchema),
  decision: Schema.Literal('OMIT'),
  productRef: CatalogProductRefSchema,
}).check(
  Schema.makeFilter((decision) =>
    (decision.coverage === undefined ||
      (coverageContextMatches(decision.context, decision.coverage.context) &&
        Schema.toEquivalence(CatalogProductRefSchema)(decision.productRef, decision.coverage.productRef))) &&
    decision.productRef.tenantId === decision.context.trustedContext.tenantId
      ? undefined
      : 'Discovery omission coverage must describe the exact omitted context',
  ),
);

/**
 * Disclosure is deliberately a two-way allowance decision, not a fourth
 * authoritative Assortment outcome. Omission is conservative and carries no
 * claim that authoritative VISIBILITY is INELIGIBLE.
 */
export const AssortmentDiscoveryInclusionDecisionSchema = Schema.Union([
  AssortmentDiscoveryIncludeDecisionSchema,
  AssortmentDiscoveryOmitDecisionSchema,
]);
export type AssortmentDiscoveryInclusionDecision = typeof AssortmentDiscoveryInclusionDecisionSchema.Type;
