import { Schema } from 'effect';

import {
  CatalogDocumentOwnerRevisionSchema,
  CatalogMediaPurposeSchema,
  sameCatalogDocumentResourceRef,
} from './catalog-media-assignment.ts';
import type { CatalogCurrentUse, CatalogDocumentOwnerRevision } from './catalog-media-assignment.ts';
import { CatalogRevisionInstantSchema } from './catalog-revision-reference.ts';
import { ProductRefSchema } from '../resources/product.ts';
import { VariantRefSchema } from '../resources/variant.ts';

const sameTargetRef = (
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

/**
 * The exact Documents Center Resource version an accepting process used as a basis. It is a
 * historical value and is never replaced by a live reference or a newer Current version.
 */
export const CatalogAcceptedDocumentBasisSchema = Schema.Struct({
  acceptedAt: CatalogRevisionInstantSchema,
  exact: CatalogDocumentOwnerRevisionSchema,
  historical: Schema.Literal(true),
  purpose: CatalogMediaPurposeSchema,
  target: Schema.Union([ProductRefSchema, VariantRefSchema]),
}).check(
  Schema.makeFilter(({ exact, target }) =>
    exact.resourceRef.tenantId === target.tenantId ? undefined : 'Accepted document basis must share one Tenant',
  ),
);
export type CatalogAcceptedDocumentBasis = typeof CatalogAcceptedDocumentBasisSchema.Type;

/** Equality includes owner, Tenant, exact Resource, exact revision, target, purpose, and acceptance. */
export const sameCatalogAcceptedDocumentBasis = (
  left: CatalogAcceptedDocumentBasis,
  right: CatalogAcceptedDocumentBasis,
): boolean =>
  left.acceptedAt === right.acceptedAt &&
  left.purpose === right.purpose &&
  sameCatalogDocumentResourceRef(left.exact.resourceRef, right.exact.resourceRef) &&
  left.exact.revision === right.exact.revision &&
  left.exact.revisionId === right.exact.revisionId &&
  sameTargetRef(left.target, right.target);

/**
 * A live reference is compared only through the owner-issued Current identity. A missing or
 * unverifiable Current stays indeterminate, and a different Resource is a new relationship rather
 * than a newer version of the accepted one.
 */
export type CatalogDocumentBasisComparison =
  | {
      readonly accepted: CatalogDocumentOwnerRevision;
      readonly kind: 'DIFFERENT_VERSION';
      readonly live: CatalogDocumentOwnerRevision;
    }
  | {
      readonly accepted: CatalogDocumentOwnerRevision;
      readonly kind: 'EXACT_VERSION';
      readonly live: CatalogDocumentOwnerRevision;
    }
  | { readonly kind: 'DIFFERENT_RESOURCE' }
  | { readonly kind: 'INDETERMINATE'; readonly reason: string };

export const compareCatalogAcceptedDocumentBasis = (
  accepted: CatalogAcceptedDocumentBasis,
  live: CatalogCurrentUse,
): CatalogDocumentBasisComparison => {
  if (live.kind === 'RESOURCE_MISMATCH') {
    return { kind: 'DIFFERENT_RESOURCE' };
  }
  if (live.kind !== 'AVAILABLE') {
    return { kind: 'INDETERMINATE', reason: `Live document reference is ${live.kind}` };
  }
  if (!sameCatalogDocumentResourceRef(accepted.exact.resourceRef, live.current.resourceRef)) {
    return { kind: 'DIFFERENT_RESOURCE' };
  }
  if (accepted.exact.revision !== live.current.revision || accepted.exact.revisionId !== live.current.revisionId) {
    return { accepted: accepted.exact, kind: 'DIFFERENT_VERSION', live: live.current };
  }
  return { accepted: accepted.exact, kind: 'EXACT_VERSION', live: live.current };
};

/** Availability alone never preserves an Accepted basis; only the exact owner revision identity does. */
export const catalogLiveReferencePreservesAcceptedBasis = (comparison: CatalogDocumentBasisComparison): boolean =>
  comparison.kind === 'EXACT_VERSION';

/** Owner-issued Current access decision. Catalog never derives it from the assignment. */
export const CatalogDocumentOwnerAccessSchema = Schema.Literals(['DENIED', 'GRANTED', 'UNVERIFIED']);
export type CatalogDocumentOwnerAccess = typeof CatalogDocumentOwnerAccessSchema.Type;

export type CatalogDocumentReadAccess =
  | { readonly kind: 'OWNER_DENIED' | 'OWNER_GRANTED' }
  | { readonly kind: 'REFERENCE_DOES_NOT_GRANT' };

/**
 * A valid Catalog reference proves a product relationship, never read permission and never a public
 * copy. Only the Documents Center Current access decision grants or denies a read.
 */
export const evaluateCatalogDocumentReadAccess = (
  ownerAccess?: CatalogDocumentOwnerAccess,
): CatalogDocumentReadAccess => {
  if (ownerAccess === 'GRANTED') {
    return { kind: 'OWNER_GRANTED' };
  }
  if (ownerAccess === 'DENIED') {
    return { kind: 'OWNER_DENIED' };
  }
  return { kind: 'REFERENCE_DOES_NOT_GRANT' };
};

/** Bounded public explanation; internal distinctions never leak inaccessible existence or content. */
export type CatalogDocumentSafeExplanation =
  | { readonly kind: 'AVAILABLE' }
  | { readonly kind: 'DENIED' | 'INDETERMINATE' | 'NOT_FOUND' | 'RETRYABLE' };

export const catalogDocumentSafeExplanation = (reference: CatalogCurrentUse): CatalogDocumentSafeExplanation => {
  if (reference.kind === 'FORBIDDEN') {
    return { kind: 'DENIED' };
  }
  if (reference.kind === 'ABSENT') {
    return { kind: 'NOT_FOUND' };
  }
  if (reference.kind === 'UNAVAILABLE') {
    return { kind: 'RETRYABLE' };
  }
  if (reference.kind === 'AVAILABLE') {
    return { kind: 'AVAILABLE' };
  }
  return { kind: 'INDETERMINATE' };
};
