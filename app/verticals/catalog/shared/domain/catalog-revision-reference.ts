import { DateTime, Option, Schema, SchemaGetter } from 'effect';

import { ProductRefSchema } from '../resources/product.ts';
import { VariantRefSchema } from '../resources/variant.ts';

const checkedUuid = Schema.String.check(Schema.isUUID(), Schema.isTrimmed());

/** Tenant identity carried by every Catalog historical reference. */
export const CatalogRevisionTenantIdSchema = checkedUuid.pipe(
  Schema.brand('CatalogRevisionTenantId'),
  Schema.decodeTo(checkedUuid),
);
export type CatalogRevisionTenantId = typeof CatalogRevisionTenantIdSchema.Type;

/** Resource identity used when a future Catalog resource has no public private-contract import here. */
export const CatalogRevisionResourceIdSchema = checkedUuid.pipe(
  Schema.brand('CatalogRevisionResourceId'),
  Schema.decodeTo(checkedUuid),
);
export type CatalogRevisionResourceId = typeof CatalogRevisionResourceIdSchema.Type;

export const CatalogRevisionIdSchema = checkedUuid.pipe(
  Schema.brand('CatalogRevisionId'),
  Schema.decodeTo(checkedUuid),
);
export type CatalogRevisionId = typeof CatalogRevisionIdSchema.Type;

/** Business revision sequence; this is deliberately distinct from an OntOS Build Revision. */
export const CatalogRevisionNumberSchema = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({ maximum: 2_147_483_647, minimum: 1 }),
).pipe(Schema.brand('CatalogRevisionNumber'));
export type CatalogRevisionNumber = typeof CatalogRevisionNumberSchema.Type;

const nonEmptyText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());
const catalogResourceType = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(160),
  Schema.isPattern(/^commerce\.catalog\.[a-z0-9][a-z0-9.-]*$/u),
  Schema.isTrimmed(),
).pipe(Schema.brand('CatalogRevisionResourceType'), Schema.decodeTo(Schema.String));

/** Public, tenant-qualified identity for a Catalog-owned resource. */
export const CatalogResourceRefSchema = Schema.Struct({
  moduleId: Schema.Literal('commerce.catalog'),
  resourceId: CatalogRevisionResourceIdSchema,
  resourceType: catalogResourceType,
  tenantId: CatalogRevisionTenantIdSchema,
});
export type CatalogResourceRef = typeof CatalogResourceRefSchema.Type;

export interface CatalogResourceRefInput {
  readonly moduleId: 'commerce.catalog';
  readonly resourceId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}

/** Variant revision references use the Catalog-owned public Variant identity. */

const instantDecoded = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u),
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    const canonicalInput = value.length === 20 ? value.replace(/Z$/u, '.000Z') : value;
    return Option.isSome(parsed) && DateTime.formatIso(parsed.value) === canonicalInput
      ? undefined
      : 'Expected a canonical UTC timestamp';
  }),
).pipe(
  Schema.decodeTo(Schema.toType(Schema.DateTimeUtc), {
    decode: SchemaGetter.transform(DateTime.makeUnsafe),
    encode: SchemaGetter.transform(DateTime.formatIso),
  }),
);
/** Canonical UTC timestamp used for the observation of retained historical evidence. */
export const CatalogRevisionInstantSchema = Schema.toEncoded(instantDecoded);
export type CatalogRevisionInstant = typeof CatalogRevisionInstantSchema.Type;

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
