import { DateTime, Option, Schema, SchemaGetter } from 'effect';

import { ProductRefSchema } from '../resources/product.ts';
import { VariantRefSchema } from '../resources/variant.ts';
import { ProductRevisionReferenceSchema } from './catalog-revision-reference.ts';
import type { CatalogSelectionOwnerAssessmentResult } from './catalog-selection-owner-contract.ts';

export const ProductLifecycleSchema = Schema.Literals(['DRAFT', 'ACTIVE', 'RETIRED']);
export type ProductLifecycle = typeof ProductLifecycleSchema.Type;

export const ProductVariantLifecycleSchema = Schema.Literals(['WORK_IN_PROGRESS', 'ACTIVE', 'RETIRED']);
export type ProductVariantLifecycle = typeof ProductVariantLifecycleSchema.Type;

export const ProductNameSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(240));
export const ProductDescriptionSchema = Schema.Trim.check(Schema.isMaxLength(4000));
export const ProductReasonSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1000));
export const ProductEvidenceReferenceSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
export const ProductAuditEvidenceSchema = Schema.Struct({
  evidenceRefs: Schema.optionalKey(Schema.Array(ProductEvidenceReferenceSchema)),
  reason: ProductReasonSchema,
});
export const ProductRevisionSchema = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({ maximum: 2_147_483_647, minimum: 1 }),
);
const checkedUuid = Schema.String.check(Schema.isUUID(), Schema.isTrimmed());
export const ProductVariantIdSchema = checkedUuid.pipe(
  Schema.brand('CatalogProductVariantId'),
  Schema.decodeTo(checkedUuid),
);
export const ProductActionInvocationIdSchema = checkedUuid.pipe(
  Schema.brand('CatalogProductActionInvocationId'),
  Schema.decodeTo(checkedUuid),
);
export const ProductUuidSchema = ProductVariantIdSchema;

export const ProductInstantSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u),
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    const canonicalInput = value.length === 20 ? value.replace(/Z$/u, '.000Z') : value;
    return Option.isSome(parsed) && DateTime.formatIso(parsed.value) === canonicalInput
      ? undefined
      : 'Expected a canonical UTC timestamp';
  }),
).pipe(
  Schema.decode({
    decode: SchemaGetter.dateTimeUtcFromInput<string>().pipe(SchemaGetter.map(DateTime.formatIso)),
    encode: SchemaGetter.dateTimeUtcFromInput<string>().pipe(SchemaGetter.map(DateTime.formatIso)),
  }),
);

export const ProductVariantSchema = Schema.Struct({
  lifecycle: ProductVariantLifecycleSchema,
  productRef: ProductRefSchema,
  variantId: ProductVariantIdSchema,
  variantRef: VariantRefSchema,
});
export type ProductVariant = typeof ProductVariantSchema.Type;

/**
 * The foundation deliberately models a Variant only as a stable work-in-progress
 * realization. Variant axes, SKU, packages, configurations, and sets are added by
 * their owning downstream slices without changing Product identity.
 */
export const ProductSchema = Schema.Struct({
  catalogReady: Schema.Boolean,
  createdAt: ProductInstantSchema,
  description: Schema.optionalKey(ProductDescriptionSchema),
  lifecycle: ProductLifecycleSchema,
  name: Schema.optionalKey(ProductNameSchema),
  productRef: ProductRefSchema,
  revision: ProductRevisionSchema,
  updatedAt: ProductInstantSchema,
  variants: Schema.Array(ProductVariantSchema).check(Schema.isMinLength(1)),
}).check(
  Schema.makeFilter(({ productRef, variants }) =>
    variants.every(
      ({ productRef: owner, variantId, variantRef }) =>
        owner.resourceId === productRef.resourceId &&
        owner.tenantId === productRef.tenantId &&
        variantRef.tenantId === productRef.tenantId &&
        variantId === variantRef.resourceId,
    )
      ? undefined
      : 'Every Variant must retain its Product owner, Tenant, and stable Variant identity',
  ),
);
export type Product = typeof ProductSchema.Type;

export const ProductChangeKindSchema = Schema.Literals(['CREATED', 'UPDATED', 'COSMETIC_CORRECTION', 'LIFECYCLE']);
export type ProductChangeKind = typeof ProductChangeKindSchema.Type;

export const ProductRevisionRecordSchema = Schema.Struct({
  actionInvocationId: ProductActionInvocationIdSchema,
  changeKind: ProductChangeKindSchema,
  description: Schema.optionalKey(ProductDescriptionSchema),
  evidenceRefs: Schema.Array(ProductEvidenceReferenceSchema),
  lifecycle: ProductLifecycleSchema,
  name: Schema.optionalKey(ProductNameSchema),
  productRef: ProductRefSchema,
  reason: ProductReasonSchema,
  recordedAt: ProductInstantSchema,
  revision: ProductRevisionSchema,
  revisionReference: ProductRevisionReferenceSchema,
});
export type ProductRevisionRecord = typeof ProductRevisionRecordSchema.Type;

export const ProductLifecycleEventSchema = Schema.Struct({
  actionInvocationId: ProductActionInvocationIdSchema,
  effectiveAt: ProductInstantSchema,
  event: Schema.Literals(['ACTIVATED', 'RETIRED']),
  productRef: ProductRefSchema,
  reason: ProductReasonSchema,
  recordedAt: ProductInstantSchema,
});
export type ProductLifecycleEvent = typeof ProductLifecycleEventSchema.Type;

export const ProductHistorySchema = Schema.Struct({
  historical: Schema.Literal(true),
  lifecycle: Schema.Array(ProductLifecycleEventSchema),
  productRef: ProductRefSchema,
  revisions: Schema.Array(ProductRevisionRecordSchema),
}).check(
  Schema.makeFilter(({ lifecycle, productRef, revisions }) =>
    revisions.every(
      (entry) =>
        entry.productRef.resourceId === productRef.resourceId &&
        entry.productRef.tenantId === productRef.tenantId &&
        entry.revisionReference.resourceRef.resourceId === productRef.resourceId &&
        entry.revisionReference.resourceRef.tenantId === productRef.tenantId &&
        entry.revisionReference.revision === entry.revision,
    ) &&
    lifecycle.every(
      (entry) =>
        entry.productRef.resourceId === productRef.resourceId && entry.productRef.tenantId === productRef.tenantId,
    )
      ? undefined
      : 'Product history must retain one Product identity and Tenant',
  ),
);
export type ProductHistory = typeof ProductHistorySchema.Type;

export const CatalogReadinessSchema = Schema.Struct({
  catalogReady: Schema.Boolean,
  reasons: Schema.Array(Schema.String),
});
export type CatalogReadiness = typeof CatalogReadinessSchema.Type;

/**
 * Necessary row evidence for a documented Product lifecycle transition into ACTIVE.
 * This is a state gate, not the derived Current Catalog-readiness of a concrete use:
 * an ACTIVE Product may still be Catalog-incomplete (#414, #479).
 */
export const productActivationBlockers = (
  product: Pick<Product, 'lifecycle' | 'variants'>,
  localizedNames: readonly string[],
): readonly string[] => {
  const reasons: string[] = [];
  if (product.lifecycle !== 'ACTIVE') {
    reasons.push('Product must be ACTIVE');
  }
  if (!localizedNames.some((name) => name.trim().length > 0)) {
    reasons.push('Product needs a current localized Catalog name');
  }
  if (!product.variants.some(({ lifecycle }) => lifecycle === 'ACTIVE')) {
    reasons.push('Product needs at least one ACTIVE Variant');
  }
  return reasons;
};

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

const hasCurrentValidSelection = (
  product: Pick<Product, 'variants'>,
  evidence: readonly CatalogSelectionOwnerAssessmentResult[],
): boolean =>
  evidence.some(
    (assessment) =>
      'status' in assessment &&
      assessment.status === 'VALID' &&
      assessment.purpose === 'PURCHASE_ACCEPTANCE' &&
      product.variants.some(
        (variant) =>
          variant.lifecycle === 'ACTIVE' &&
          sameResourceRef(assessment.selection.productRef, variant.productRef) &&
          sameResourceRef(assessment.selection.variantRef, variant.variantRef),
      ),
  );

/**
 * Current owner-local localized names satisfy the text minimum. Catalog readiness additionally
 * needs owner-issued Current evidence for one exact ACTIVE Variant selection. Missing,
 * indeterminate, invalid, other-purpose, or differently targeted evidence fails closed.
 */
export const catalogReadiness = (
  product: Pick<Product, 'lifecycle' | 'variants'>,
  localizedNames: readonly string[],
  selectionEvidence: readonly CatalogSelectionOwnerAssessmentResult[] = [],
): CatalogReadiness => {
  const reasons = [...productActivationBlockers(product, localizedNames)];
  if (!hasCurrentValidSelection(product, selectionEvidence)) {
    reasons.push('Current Product Type, required facts, Variant axes, Unit and dependent content are not verified');
  }
  return { catalogReady: reasons.length === 0, reasons };
};

export const productIsCatalogReady = (
  product: Pick<Product, 'lifecycle' | 'variants'>,
  localizedNames: readonly string[],
  selectionEvidence: readonly CatalogSelectionOwnerAssessmentResult[] = [],
): boolean => catalogReadiness(product, localizedNames, selectionEvidence).catalogReady;
