import { Schema } from 'effect';

import { ProductRefSchema } from '../resources/product.ts';
import { VariantRefSchema } from '../resources/variant.ts';
import {
  CatalogDocumentOwnerRevisionSchema,
  CatalogDocumentResourceRefSchema,
  sameCatalogDocumentResourceRef,
} from './catalog-media-assignment.ts';
import type { CatalogDocumentOwnerRevision, CatalogDocumentResourceRef } from './catalog-media-assignment.ts';
import { CatalogResourceRefSchema, CatalogRevisionInstantSchema } from './catalog-revision-reference.ts';

/**
 * One fact has exactly one authoritative owner, decided by business meaning rather than by the
 * screen, form, or cache that shows it. This module is a pure boundary: it never stores Content
 * marketing copy, document bytes, Storefront routes, or publication output, and it returns a typed
 * not-owner/unverifiable decision for every request that would create a second canonical authority.
 */

const checkedUuid = Schema.String.check(Schema.isUUID(), Schema.isTrimmed());
const qualifiedText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200), Schema.isTrimmed());

export const CatalogPrincipalIdSchema = checkedUuid.pipe(
  Schema.brand('CatalogPrincipalId'),
  Schema.decodeTo(checkedUuid),
);
export type CatalogPrincipalId = typeof CatalogPrincipalIdSchema.Type;

export const CatalogFactKeySchema = qualifiedText.pipe(Schema.brand('CatalogFactKey'));
export type CatalogFactKey = typeof CatalogFactKeySchema.Type;

export const CatalogFactPermissionKeySchema = qualifiedText.pipe(Schema.brand('CatalogFactPermissionKey'));
export type CatalogFactPermissionKey = typeof CatalogFactPermissionKeySchema.Type;

/** The five applications that may be authoritative for a business meaning. */
export const CatalogFactOwnerSchema = Schema.Literals([
  'CATALOG',
  'CONTENT',
  'DOCUMENTS_CENTER',
  'STOREFRONT',
  'CHANNEL_PUBLICATION',
]);
export type CatalogFactOwner = typeof CatalogFactOwnerSchema.Type;

/** A claim can also arrive from an external source, which never by itself becomes a fact owner. */
export const CatalogFactClaimantSchema = Schema.Literals([
  'CATALOG',
  'CONTENT',
  'DOCUMENTS_CENTER',
  'STOREFRONT',
  'CHANNEL_PUBLICATION',
  'EXTERNAL_SOURCE',
]);
export type CatalogFactClaimant = typeof CatalogFactClaimantSchema.Type;

/** Business meaning, never a field location. Distinct meanings may be correct at the same time. */
export const CatalogFactMeaningSchema = Schema.Literals([
  'PRODUCT_IDENTITY',
  'STRUCTURED_PROPERTY',
  'CATALOG_NAME',
  'FACTUAL_DESCRIPTION',
  'MARKETING_HEADLINE',
  'SELLING_COPY',
  'THEMATIC_CONTENT',
  'DOCUMENT_RESOURCE_CONTENT',
  'DOCUMENT_VERSION_ACCESS_RETENTION',
  'PRODUCT_DOCUMENT_MEDIA_ASSIGNMENT',
  'STOREFRONT_ROUTING_RENDER_LAYOUT_SEO',
  'PUBLICATION_OUTPUT',
]);
export type CatalogFactMeaning = typeof CatalogFactMeaningSchema.Type;

/**
 * The single authority for each meaning. Catalog owns product identity, structured properties, the
 * catalog name, the factual description, and the product document/media assignment. Content owns
 * marketing copy, Documents Center owns document/media Resource state, Storefront owns routing and
 * SEO, and Channel Publication owns agreed publication output.
 */
const factMeaningOwners = {
  CATALOG_NAME: 'CATALOG',
  DOCUMENT_RESOURCE_CONTENT: 'DOCUMENTS_CENTER',
  DOCUMENT_VERSION_ACCESS_RETENTION: 'DOCUMENTS_CENTER',
  FACTUAL_DESCRIPTION: 'CATALOG',
  MARKETING_HEADLINE: 'CONTENT',
  PRODUCT_DOCUMENT_MEDIA_ASSIGNMENT: 'CATALOG',
  PRODUCT_IDENTITY: 'CATALOG',
  PUBLICATION_OUTPUT: 'CHANNEL_PUBLICATION',
  SELLING_COPY: 'CONTENT',
  STOREFRONT_ROUTING_RENDER_LAYOUT_SEO: 'STOREFRONT',
  STRUCTURED_PROPERTY: 'CATALOG',
  THEMATIC_CONTENT: 'CONTENT',
} as const satisfies Record<CatalogFactMeaning, CatalogFactOwner>;

export const catalogFactMeaningOwner = (meaning: CatalogFactMeaning): CatalogFactOwner => factMeaningOwners[meaning];

/** A tenant-qualified Catalog fact on one exact target, without any value yet. */
export const CatalogFactRefSchema = Schema.Struct({
  factKey: CatalogFactKeySchema,
  meaning: CatalogFactMeaningSchema,
  target: CatalogResourceRefSchema,
});
export type CatalogFactRef = typeof CatalogFactRefSchema.Type;

/** A permission a caller must actually hold for the exact target before a canonical mutation. */
export const CatalogFactPermissionSchema = Schema.Struct({
  permissionKey: CatalogFactPermissionKeySchema,
  scope: CatalogResourceRefSchema,
});
export type CatalogFactPermission = typeof CatalogFactPermissionSchema.Type;

/**
 * `origin` is the application the user started from; `operationOwner` is the application whose
 * public operation performs the write. A Catalog fact edited from Content is legitimate only when
 * `operationOwner` is Catalog and the Catalog permission matches the exact target.
 */
export const CatalogFactMutationAuthoritySchema = Schema.Struct({
  operationOwner: CatalogFactOwnerSchema,
  origin: CatalogFactOwnerSchema,
  permission: Schema.optionalKey(CatalogFactPermissionSchema),
  principalId: CatalogPrincipalIdSchema,
});
export type CatalogFactMutationAuthority = typeof CatalogFactMutationAuthoritySchema.Type;

export type CatalogFactMutationDecision =
  | { readonly owner: CatalogFactOwner; readonly status: 'NOT_OWNER' }
  | { readonly status: 'PERMISSION_REQUIRED' }
  | { readonly reason: string; readonly status: 'UNVERIFIABLE' }
  | { readonly status: 'ACCEPTED' };

/** The same Catalog target identity in every field; a pointer is never a fact on its own. */
export const sameCatalogFactTarget = (left: CatalogFactRef['target'], right: CatalogFactRef['target']): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

/**
 * Only the meaning owner may write the canonical fact, and only through its own operation with a
 * real permission for the exact target. Foreign-owner content (a marketing headline, a document
 * version, a Storefront route) is refused as `NOT_OWNER`; a bare copy with no permission is
 * refused as `PERMISSION_REQUIRED`.
 */
export const assessCatalogCanonicalFactMutation = (input: {
  readonly authority: CatalogFactMutationAuthority | null;
  readonly fact: CatalogFactRef;
  readonly targetVerified: boolean;
  readonly valueValid: boolean;
}): CatalogFactMutationDecision => {
  const owner = catalogFactMeaningOwner(input.fact.meaning);
  if (owner !== 'CATALOG') {
    return { owner, status: 'NOT_OWNER' };
  }
  const { authority } = input;
  if (authority === null) {
    return { reason: 'Mutation authority is missing', status: 'UNVERIFIABLE' };
  }
  if (authority.operationOwner !== 'CATALOG') {
    return { owner: authority.operationOwner, status: 'NOT_OWNER' };
  }
  if (!input.targetVerified) {
    return { reason: 'Exact Catalog target is not verified', status: 'UNVERIFIABLE' };
  }
  if (!input.valueValid) {
    return { reason: 'Catalog fact value is invalid', status: 'UNVERIFIABLE' };
  }
  const { permission } = authority;
  if (permission === undefined || !sameCatalogFactTarget(permission.scope, input.fact.target)) {
    return { status: 'PERMISSION_REQUIRED' };
  }
  return { status: 'ACCEPTED' };
};

/** A claimant's proposed value. `observedAt` is retained only as provenance, never as precedence. */
export const CatalogFactClaimSchema = Schema.Struct({
  claimant: CatalogFactClaimantSchema,
  meaning: CatalogFactMeaningSchema,
  observedAt: CatalogRevisionInstantSchema,
  value: Schema.Json,
});
export type CatalogFactClaim = typeof CatalogFactClaimSchema.Type;

export const CatalogFactConflictResolutionSchema = Schema.Literals([
  'FACT_OWNER',
  'EXTERNAL_SOURCE_ASSERTION_AND_LOCAL_OVERRIDE_481',
]);
export type CatalogFactConflictResolution = typeof CatalogFactConflictResolutionSchema.Type;

export type CatalogFactClaimDecision =
  | { readonly meanings: readonly CatalogFactMeaning[]; readonly status: 'DISTINCT_MEANINGS' }
  | {
      readonly owner: CatalogFactOwner;
      readonly resolution: CatalogFactConflictResolution;
      readonly status: 'OWNER_DECIDES';
      readonly suppressed: readonly CatalogFactClaimant[];
    }
  | { readonly reason: string; readonly status: 'UNVERIFIABLE' };

/**
 * A catalog name and a marketing headline have different meanings, so both stay valid. Claims about
 * one meaning are decided by its owner from evidence; non-owner and external claims never win by
 * being newer or more prominent. External source authority and Local Override follow #481.
 */
export const assessCatalogFactClaims = (input: {
  readonly claims: readonly CatalogFactClaim[];
}): CatalogFactClaimDecision => {
  const meanings = [...new Set(input.claims.map((claim) => claim.meaning))];
  if (meanings.length > 1) {
    return { meanings, status: 'DISTINCT_MEANINGS' };
  }
  const [meaning] = meanings;
  if (meaning === undefined) {
    return { reason: 'No fact claim was supplied', status: 'UNVERIFIABLE' };
  }
  const owner = catalogFactMeaningOwner(meaning);
  if (!input.claims.some((claim) => claim.claimant === owner)) {
    return { reason: `No claim was supplied by the ${owner} fact owner`, status: 'UNVERIFIABLE' };
  }
  const suppressed = [
    ...new Set(input.claims.flatMap((claim) => (claim.claimant === owner ? [] : [claim.claimant]))),
  ].toSorted();
  return {
    owner,
    resolution:
      owner === 'CATALOG' && suppressed.includes('EXTERNAL_SOURCE')
        ? 'EXTERNAL_SOURCE_ASSERTION_AND_LOCAL_OVERRIDE_481'
        : 'FACT_OWNER',
    status: 'OWNER_DECIDES',
    suppressed,
  };
};

export const CatalogDocumentTargetSchema = Schema.Union([ProductRefSchema, VariantRefSchema]);
export type CatalogDocumentTarget = typeof CatalogDocumentTargetSchema.Type;

/** Live use follows the same Resource's Current version; a different Resource is a relation change. */
export const CatalogLiveDocumentReferenceSchema = Schema.Struct({
  mode: Schema.Literal('LIVE_CURRENT'),
  resourceRef: CatalogDocumentResourceRefSchema,
  target: CatalogDocumentTargetSchema,
});
export type CatalogLiveDocumentReference = typeof CatalogLiveDocumentReferenceSchema.Type;

/** Accepted evidence pins the exact owner-issued version/bytes that were actually used. */
export const CatalogPinnedDocumentEvidenceSchema = Schema.Struct({
  exact: CatalogDocumentOwnerRevisionSchema,
  mode: Schema.Literal('ACCEPTED_PINNED'),
  target: CatalogDocumentTargetSchema,
});
export type CatalogPinnedDocumentEvidence = typeof CatalogPinnedDocumentEvidenceSchema.Type;

export const CatalogDocumentReferenceSchema = Schema.Union([
  CatalogLiveDocumentReferenceSchema,
  CatalogPinnedDocumentEvidenceSchema,
]);
export type CatalogDocumentReference = typeof CatalogDocumentReferenceSchema.Type;

export type CatalogDocumentReferenceDecision =
  | { readonly perVersionApprovalRequired: false; readonly status: 'CURRENT_FROM_OWNER' }
  | {
      readonly exact: CatalogDocumentOwnerRevision;
      readonly perVersionApprovalRequired: false;
      readonly status: 'EVIDENCE_PINNED';
    }
  | { readonly status: 'RELATION_CHANGE_REQUIRED' }
  | { readonly reason: string; readonly status: 'UNVERIFIABLE' };

/**
 * A live Catalog reference resolves to the Current version of the same Documents Center Resource
 * without per-version Catalog approval. A different Resource (D2) is not a new version of D1 and
 * requires an explicit Catalog relation change; a missing owner result is unverifiable, not proof.
 */
export const assessCatalogDocumentReference = (input: {
  readonly currentOwnerResourceRef: CatalogDocumentResourceRef;
  readonly reference: CatalogDocumentReference;
}): CatalogDocumentReferenceDecision => {
  const { currentOwnerResourceRef, reference } = input;
  const referenceResourceRef = reference.mode === 'LIVE_CURRENT' ? reference.resourceRef : reference.exact.resourceRef;
  if (referenceResourceRef.tenantId !== currentOwnerResourceRef.tenantId) {
    return { reason: 'Catalog reference and owner Resource cross the Tenant boundary', status: 'UNVERIFIABLE' };
  }
  if (!sameCatalogDocumentResourceRef(referenceResourceRef, currentOwnerResourceRef)) {
    return { status: 'RELATION_CHANGE_REQUIRED' };
  }
  return reference.mode === 'LIVE_CURRENT'
    ? { perVersionApprovalRequired: false, status: 'CURRENT_FROM_OWNER' }
    : { exact: reference.exact, perVersionApprovalRequired: false, status: 'EVIDENCE_PINNED' };
};

export type CatalogDocumentEvidenceBasis =
  | { readonly status: 'NOT_HISTORICAL_PROOF' }
  | { readonly exact: CatalogDocumentOwnerRevision; readonly status: 'EVIDENCE_PINNED' };

/** A live reference is today's use, never the historical proof of what a past result consumed. */
export const assessLiveDocumentReferenceAsEvidence = (
  reference: CatalogDocumentReference,
): CatalogDocumentEvidenceBasis =>
  reference.mode === 'LIVE_CURRENT'
    ? { status: 'NOT_HISTORICAL_PROOF' }
    : { exact: reference.exact, status: 'EVIDENCE_PINNED' };

export const CatalogAcceptedResultRefSchema = qualifiedText.pipe(Schema.brand('CatalogAcceptedResultRef'));
export type CatalogAcceptedResultRef = typeof CatalogAcceptedResultRefSchema.Type;

export const CatalogAcceptedDocumentEvidenceSchema = Schema.Struct({
  acceptedResultRef: CatalogAcceptedResultRefSchema,
  exact: CatalogDocumentOwnerRevisionSchema,
});
export type CatalogAcceptedDocumentEvidence = typeof CatalogAcceptedDocumentEvidenceSchema.Type;

export type CatalogAcceptedEvidenceDecision =
  | { readonly evidence: CatalogAcceptedDocumentEvidence; readonly status: 'RETAINED' }
  | {
      readonly rejected: CatalogAcceptedDocumentEvidence;
      readonly retained: CatalogAcceptedDocumentEvidence;
      readonly status: 'IMMUTABLE';
    }
  | { readonly reason: string; readonly status: 'UNVERIFIABLE' };

const sameAcceptedEvidence = (left: CatalogAcceptedDocumentEvidence, right: CatalogAcceptedDocumentEvidence): boolean =>
  sameCatalogDocumentResourceRef(left.exact.resourceRef, right.exact.resourceRef) &&
  left.exact.revision === right.exact.revision &&
  left.exact.revisionId === right.exact.revisionId;

/**
 * Accepted evidence keeps the exact version/bytes that were actually used. A concurrent Catalog,
 * Content, document, or publication change never rewrites that accepted Order history; a later live
 * detail page or another Resource cannot be substituted for it.
 */
export const preserveAcceptedDocumentEvidence = (input: {
  readonly retained: CatalogAcceptedDocumentEvidence;
  readonly used: CatalogAcceptedDocumentEvidence;
}): CatalogAcceptedEvidenceDecision => {
  if (input.retained.acceptedResultRef !== input.used.acceptedResultRef) {
    return { reason: 'Evidence belongs to a different accepted result', status: 'UNVERIFIABLE' };
  }
  return sameAcceptedEvidence(input.retained, input.used)
    ? { evidence: input.retained, status: 'RETAINED' }
    : { rejected: input.used, retained: input.retained, status: 'IMMUTABLE' };
};

export type CatalogDocumentApplicabilityDecision =
  | { readonly scope: 'VARIANT'; readonly status: 'DIRECT' }
  | { readonly scope: 'PRODUCT'; readonly status: 'PRODUCT_LEVEL' }
  | { readonly status: 'NOT_APPLICABLE' };

const isVariantTarget = (target: CatalogDocumentTarget): boolean => target.resourceType === 'commerce.catalog.variant';

/**
 * Catalog owns the applicability scope. A Variant-only assignment never widens to another Variant;
 * an explicit Product-level assignment covers its Variants without inferring universal use.
 */
export const assessCatalogDocumentApplicability = (input: {
  readonly assignmentTarget: CatalogDocumentTarget;
  readonly requestedTarget: CatalogDocumentTarget;
}): CatalogDocumentApplicabilityDecision => {
  const { assignmentTarget, requestedTarget } = input;
  if (assignmentTarget.tenantId !== requestedTarget.tenantId) {
    return { status: 'NOT_APPLICABLE' };
  }
  if (isVariantTarget(assignmentTarget)) {
    return isVariantTarget(requestedTarget) && assignmentTarget.resourceId === requestedTarget.resourceId
      ? { scope: 'VARIANT', status: 'DIRECT' }
      : { status: 'NOT_APPLICABLE' };
  }
  if (isVariantTarget(requestedTarget)) {
    return { scope: 'PRODUCT', status: 'PRODUCT_LEVEL' };
  }
  return assignmentTarget.resourceId === requestedTarget.resourceId
    ? { scope: 'PRODUCT', status: 'PRODUCT_LEVEL' }
    : { status: 'NOT_APPLICABLE' };
};

export const CatalogDepictionClaimSchema = Schema.Literals(['COLOR', 'CONFIGURATION', 'DIMENSIONS', 'IDENTITY']);
export type CatalogDepictionClaim = typeof CatalogDepictionClaimSchema.Type;

export interface CatalogMediaDepictionDecision {
  readonly orderingOwner: 'CATALOG_474';
  readonly status: 'ILLUSTRATIVE_ONLY' | 'NOT_IDENTITY_EVIDENCE';
}

/** A media fallback or first item may illustrate another realization; it never establishes Color or identity. */
export const assessMediaDepictionIdentity = (input: {
  readonly claims: readonly CatalogDepictionClaim[];
}): CatalogMediaDepictionDecision => ({
  orderingOwner: 'CATALOG_474',
  status: input.claims.length === 0 ? 'ILLUSTRATIVE_ONLY' : 'NOT_IDENTITY_EVIDENCE',
});

export const CatalogCanonicalAddressSourceSchema = Schema.Literals([
  'CATALOG_IDENTITY',
  'CHANNEL_PUBLICATION',
  'FIRST_CATEGORY',
  'LOCAL_NAME_COPY',
  'STOREFRONT_ROUTE',
]);
export type CatalogCanonicalAddressSource = typeof CatalogCanonicalAddressSourceSchema.Type;

export interface CatalogCanonicalAddressDecision {
  readonly canonicalCatalogAddressCreated: boolean;
  readonly status: 'AUTHORITATIVE' | 'DERIVED_OUTPUT' | 'NOT_CANONICAL' | 'STOREFRONT_OWNED';
}

const canonicalAddressDecisions = {
  CATALOG_IDENTITY: { canonicalCatalogAddressCreated: true, status: 'AUTHORITATIVE' },
  CHANNEL_PUBLICATION: { canonicalCatalogAddressCreated: false, status: 'DERIVED_OUTPUT' },
  FIRST_CATEGORY: { canonicalCatalogAddressCreated: false, status: 'NOT_CANONICAL' },
  LOCAL_NAME_COPY: { canonicalCatalogAddressCreated: false, status: 'NOT_CANONICAL' },
  STOREFRONT_ROUTE: { canonicalCatalogAddressCreated: false, status: 'STOREFRONT_OWNED' },
} as const satisfies Record<CatalogCanonicalAddressSource, CatalogCanonicalAddressDecision>;

/**
 * Storefront owns routing, rendering, layout, and SEO; Channel Publication derives agreed output
 * from authoritative inputs. Neither a Storefront route, a first category, nor a local name copy
 * creates an alternative canonical Catalog address (#451).
 */
export const assessCatalogCanonicalAddress = (input: {
  readonly source: CatalogCanonicalAddressSource;
}): CatalogCanonicalAddressDecision => canonicalAddressDecisions[input.source];

export const CatalogPublicExistenceKindSchema = Schema.Literals(['MEDIA', 'PAGE', 'PUBLISHED_LINK']);
export type CatalogPublicExistenceKind = typeof CatalogPublicExistenceKindSchema.Type;

export const CatalogProtectedEntitlementSchema = Schema.Literals(['ASSORTMENT', 'PERMISSION']);
export type CatalogProtectedEntitlement = typeof CatalogProtectedEntitlementSchema.Type;

export interface CatalogPublicExistenceDecision {
  readonly entitlement: CatalogProtectedEntitlement;
  readonly existence: CatalogPublicExistenceKind;
  readonly status: 'NO_GRANT';
}

/**
 * A public page, media file, or published link is not an entitlement. Access is checked by the
 * owning Assortment, Permission, and Documents Center gates, and a Content cache or feed bypass is
 * never a path around them.
 */
export const assessPublicExistenceEntitlement = (input: {
  readonly entitlement: CatalogProtectedEntitlement;
  readonly existence: CatalogPublicExistenceKind;
}): CatalogPublicExistenceDecision => ({
  entitlement: input.entitlement,
  existence: input.existence,
  status: 'NO_GRANT',
});
