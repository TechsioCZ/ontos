import { Schema } from 'effect';

import { ProductRefSchema } from '../resources/product.ts';
import { VariantRefSchema } from '../resources/variant.ts';
import { ProductEvidenceReferenceSchema, ProductInstantSchema, ProductReasonSchema } from './product.ts';

/** The meaning is closed; a note cannot introduce an unreviewed relationship type. */
export const ProductRelationshipTypeSchema = Schema.Literals(['ACCESSORY_FOR', 'RELATED_PRODUCT', 'SUCCESSOR']);

/** Either endpoint names a stable, Tenant-qualified Catalog resource, never a SKU or selection. */
export const ProductRelationshipEndpointSchema = Schema.Union([ProductRefSchema, VariantRefSchema]);
export type ProductRelationshipEndpoint = typeof ProductRelationshipEndpointSchema.Type;

/** Unknown historical boundaries remain absent. The end, when known, is exclusive. */
export const ProductRelationshipEffectivePeriodSchema = Schema.Struct({
  effectiveFrom: Schema.optionalKey(ProductInstantSchema),
  effectiveTo: Schema.optionalKey(ProductInstantSchema),
}).check(
  Schema.makeFilter(({ effectiveFrom, effectiveTo }) =>
    effectiveFrom === undefined || effectiveTo === undefined || effectiveFrom < effectiveTo
      ? undefined
      : 'Effective end must be after effective start',
  ),
);

/** Source and target are assertion roles, not an unordered pair. */
export const ProductRelationshipSchema = Schema.Struct({
  effectivePeriod: ProductRelationshipEffectivePeriodSchema,
  evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
  reason: ProductReasonSchema,
  source: ProductRelationshipEndpointSchema,
  target: ProductRelationshipEndpointSchema,
  type: ProductRelationshipTypeSchema,
}).check(
  Schema.makeFilter(({ source, target }) => {
    const issues: string[] = [];
    if (source.tenantId !== target.tenantId) {
      issues.push('Relationship endpoints must share one Tenant');
    }
    if (source.resourceType === target.resourceType && source.resourceId === target.resourceId) {
      issues.push('A relationship cannot point to the same endpoint');
    }
    return issues;
  }),
);
export type ProductRelationship = typeof ProductRelationshipSchema.Type;

/** This only evaluates known effective bounds; a missing past bound is not an invented date. */
export const productRelationshipIsCurrent = (
  relationship: Pick<ProductRelationship, 'effectivePeriod'>,
  at: string,
): boolean => {
  const { effectiveFrom, effectiveTo } = relationship.effectivePeriod;
  return (effectiveFrom === undefined || effectiveFrom <= at) && (effectiveTo === undefined || at < effectiveTo);
};

const endpointKey = (endpoint: ProductRelationshipEndpoint): string =>
  `${endpoint.tenantId}:${endpoint.resourceType}:${endpoint.resourceId}`;

/** Exact directed, typed duplicates are invalid; different meanings may share the same pair. */
export const productRelationshipHasDuplicate = (
  existing: readonly ProductRelationship[],
  candidate: ProductRelationship,
): boolean =>
  existing.some(
    (relationship) =>
      relationship.type === candidate.type &&
      endpointKey(relationship.source) === endpointKey(candidate.source) &&
      endpointKey(relationship.target) === endpointKey(candidate.target) &&
      relationship.effectivePeriod.effectiveFrom === candidate.effectivePeriod.effectiveFrom &&
      relationship.effectivePeriod.effectiveTo === candidate.effectivePeriod.effectiveTo,
  );
