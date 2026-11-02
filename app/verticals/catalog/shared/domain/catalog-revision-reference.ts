import { Schema } from 'effect';

import {
  CatalogResourceRefSchema,
  CatalogRevisionIdSchema,
  CatalogRevisionInstantSchema,
  CatalogRevisionNumberSchema,
} from '@app/catalog-selection-contracts/catalog-resource-reference';
import { ProductRefSchema } from '../resources/product.ts';
import { VariantRefSchema } from '../resources/variant.ts';

export {
  CatalogResourceRefSchema,
  CatalogRevisionIdSchema,
  CatalogRevisionInstantSchema,
  CatalogRevisionNumberSchema,
  CatalogRevisionResourceIdSchema,
  CatalogRevisionTenantIdSchema,
} from '@app/catalog-selection-contracts/catalog-resource-reference';
export type {
  CatalogResourceRef,
  CatalogResourceRefInput,
  CatalogRevisionId,
  CatalogRevisionInstant,
  CatalogRevisionNumber,
  CatalogRevisionResourceId,
  CatalogRevisionTenantId,
} from '@app/catalog-selection-contracts/catalog-resource-reference';

const nonEmptyText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());

const revisionReferenceFields = {
  resourceRef: CatalogResourceRefSchema,
  revision: CatalogRevisionNumberSchema,
  revisionId: CatalogRevisionIdSchema,
};

/**
 * Exact immutable business revision identity. The ResourceRef supplies owner and Tenant scope;
 * the required sequence (and optional owner-issued revision ID) supplies the exact historical
 * version. There is intentionally no `latest`, current, or successor field.
 */
export const CatalogRevisionReferenceSchema = Schema.Struct(revisionReferenceFields);
export type CatalogRevisionReference = typeof CatalogRevisionReferenceSchema.Type;

/** Product-specific form without importing Product's private domain model. */
export const ProductRevisionReferenceSchema = Schema.Struct({
  resourceRef: ProductRefSchema,
  revision: CatalogRevisionNumberSchema,
  revisionId: CatalogRevisionIdSchema,
});
export type ProductRevisionReference = typeof ProductRevisionReferenceSchema.Type;

/** Variant-specific form without importing a future Variant implementation contract. */
export const VariantRevisionReferenceSchema = Schema.Struct({
  resourceRef: VariantRefSchema,
  revision: CatalogRevisionNumberSchema,
  revisionId: CatalogRevisionIdSchema,
});
export type VariantRevisionReference = typeof VariantRevisionReferenceSchema.Type;

export const CatalogHistoricalProductLifecycleSchema = Schema.Literals(['DRAFT', 'ACTIVE', 'RETIRED']);
export type CatalogHistoricalProductLifecycle = typeof CatalogHistoricalProductLifecycleSchema.Type;

export const CatalogHistoricalVariantLifecycleSchema = Schema.Literals(['WORK_IN_PROGRESS', 'ACTIVE', 'RETIRED']);
export type CatalogHistoricalVariantLifecycle = typeof CatalogHistoricalVariantLifecycleSchema.Type;

const historicalProductName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240), Schema.isTrimmed());
const historicalProductDescription = Schema.String.check(Schema.isMaxLength(4000), Schema.isTrimmed());

/**
 * Retained Product values are explicitly historical and carry only the relevant immutable form;
 * they do not imply today's lifecycle, readiness, price, Assortment, Availability, or Permission.
 */
export const CatalogRetainedProductSchema = Schema.Struct({
  description: Schema.optionalKey(historicalProductDescription),
  historical: Schema.Literal(true),
  kind: Schema.Literal('PRODUCT'),
  lifecycle: CatalogHistoricalProductLifecycleSchema,
  name: Schema.optionalKey(historicalProductName),
  reference: ProductRevisionReferenceSchema,
});
export type CatalogRetainedProduct = typeof CatalogRetainedProductSchema.Type;

/** Retained Variant form, including its stable Product owner identity. */
export const CatalogRetainedVariantSchema = Schema.Struct({
  historical: Schema.Literal(true),
  kind: Schema.Literal('VARIANT'),
  lifecycle: CatalogHistoricalVariantLifecycleSchema,
  productRef: ProductRefSchema,
  reference: VariantRevisionReferenceSchema,
}).check(
  Schema.makeFilter((value) =>
    value.productRef.tenantId === value.reference.resourceRef.tenantId
      ? undefined
      : 'Retained Variant and Product must belong to the same Tenant',
  ),
);
export type CatalogRetainedVariant = typeof CatalogRetainedVariantSchema.Type;

export const CatalogRetainedResourceSchema = Schema.Union([CatalogRetainedProductSchema, CatalogRetainedVariantSchema]);
export type CatalogRetainedResource = typeof CatalogRetainedResourceSchema.Type;

interface RevisionReferenceIdentity {
  readonly resourceRef: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  };
  readonly revision: number;
  readonly revisionId?: string;
}

/** Equality includes owner, Tenant, Resource identity, revision sequence, and optional revision ID. */
export const sameCatalogRevisionReference = (
  left: RevisionReferenceIdentity,
  right: RevisionReferenceIdentity,
): boolean =>
  left.resourceRef.moduleId === right.resourceRef.moduleId &&
  left.resourceRef.resourceId === right.resourceRef.resourceId &&
  left.resourceRef.resourceType === right.resourceRef.resourceType &&
  left.resourceRef.tenantId === right.resourceRef.tenantId &&
  left.revision === right.revision &&
  left.revisionId === right.revisionId;

/**
 * Evidence is a historical-only projection. The schema check prevents the retained form from
 * describing a different Resource or revision than the qualified reference beside it.
 */
export const CatalogRevisionEvidenceSchema = Schema.Struct({
  capturedAt: CatalogRevisionInstantSchema,
  evidenceRefs: Schema.optionalKey(Schema.Array(nonEmptyText)),
  historical: Schema.Literal(true),
  reference: CatalogRevisionReferenceSchema,
  retained: CatalogRetainedResourceSchema,
}).check(
  Schema.makeFilter((value) =>
    sameCatalogRevisionReference(value.reference, value.retained.reference)
      ? undefined
      : 'Historical evidence must retain the requested Resource and exact revision',
  ),
);
export type CatalogRevisionEvidence = typeof CatalogRevisionEvidenceSchema.Type;

export const CatalogRevisionLookupRequestSchema = Schema.Struct({
  reference: CatalogRevisionReferenceSchema,
});
export type CatalogRevisionLookupRequest = typeof CatalogRevisionLookupRequestSchema.Type;

export const CatalogRevisionLookupFoundSchema = Schema.Struct({
  evidence: CatalogRevisionEvidenceSchema,
  kind: Schema.Literal('FOUND'),
  requestedReference: CatalogRevisionReferenceSchema,
}).check(
  Schema.makeFilter((value) =>
    sameCatalogRevisionReference(value.requestedReference, value.evidence.reference)
      ? undefined
      : 'Historical lookup must return the exact requested revision',
  ),
);

export const CatalogRevisionLookupMissingSchema = Schema.Struct({
  kind: Schema.Literal('MISSING'),
  requestedReference: CatalogRevisionReferenceSchema,
});

export const CatalogRevisionLookupBrokenSchema = Schema.Struct({
  kind: Schema.Literal('BROKEN'),
  reason: nonEmptyText,
  requestedReference: CatalogRevisionReferenceSchema,
});

export const CatalogRevisionLookupUnavailableSchema = Schema.Struct({
  kind: Schema.Literal('UNAVAILABLE'),
  reason: nonEmptyText,
  requestedReference: CatalogRevisionReferenceSchema,
  retryable: Schema.Boolean,
});

/** Exhaustive historical lookup outcomes; no current/successor fallback is representable. */
export const CatalogRevisionLookupResultSchema = Schema.Union([
  CatalogRevisionLookupFoundSchema,
  CatalogRevisionLookupMissingSchema,
  CatalogRevisionLookupBrokenSchema,
  CatalogRevisionLookupUnavailableSchema,
]);
export type CatalogRevisionLookupResult = typeof CatalogRevisionLookupResultSchema.Type;

export const CatalogHistoricalLookupResultSchema = CatalogRevisionLookupResultSchema;

/** A lookup result is safe to compose only when it preserves the requested exact reference. */
export const catalogRevisionLookupPreservesReference = (
  request: CatalogRevisionLookupRequest,
  result: CatalogRevisionLookupResult,
): boolean => {
  const returnedReference = result.kind === 'FOUND' ? result.evidence.reference : result.requestedReference;
  return (
    sameCatalogRevisionReference(request.reference, result.requestedReference) &&
    sameCatalogRevisionReference(request.reference, returnedReference)
  );
};
