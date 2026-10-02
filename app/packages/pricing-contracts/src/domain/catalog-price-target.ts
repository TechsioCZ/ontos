import {
  CatalogSelectionSchema,
  CatalogSelectionValidEvidenceSchema,
} from '@app/catalog/domain/catalog-selection-evidence';
import { ProductRefSchema } from '@app/catalog/resources/product';
import { VariantRefSchema } from '@app/catalog/resources/variant';
import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import { Schema } from 'effect';

import { PricingInstantSchema } from '../apis/current-supported-currencies.ts';

const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());
const productRefEquivalence = Schema.toEquivalence(ProductRefSchema);
const targetEquivalence = Schema.toEquivalence(CatalogSelectionSchema);

/**
 * Pricing keeps Catalog's exact selection value intact. Product parentage and one concrete Variant
 * are mandatory; optional package, configuration, and Set material remain part of exact equality.
 */
export const PriceCatalogTargetSchema = CatalogSelectionSchema;
export type PriceCatalogTarget = typeof PriceCatalogTargetSchema.Type;

export const priceCatalogTargetsEqual = (left: PriceCatalogTarget, right: PriceCatalogTarget): boolean =>
  targetEquivalence(left, right);

export const PriceCatalogTargetRejectionReasonSchema = Schema.Literals([
  'PRODUCT_ONLY_TARGET',
  'VARIANT_MISSING',
  'VARIANT_FOREIGN_TENANT',
  'VARIANT_NOT_CHILD_OF_PRODUCT',
  'PACKAGE_CONTENT_EVIDENCE_MISSING',
  'CONFIGURATION_EVIDENCE_MISSING',
  'SET_COMPOSITION_EVIDENCE_MISSING',
]);
export type PriceCatalogTargetRejectionReason = typeof PriceCatalogTargetRejectionReasonSchema.Type;

const PriceCatalogTargetAcceptedSchema = Schema.Struct({
  catalogEvidence: CatalogSelectionValidEvidenceSchema,
  outcome: Schema.Literal('PRICE_CATALOG_TARGET_ACCEPTED'),
  target: PriceCatalogTargetSchema,
}).check(
  Schema.makeFilter(({ catalogEvidence, target }) =>
    priceCatalogTargetsEqual(catalogEvidence.selection, target)
      ? undefined
      : 'Catalog evidence must bind the exact accepted Price target',
  ),
);

const rejectedTargetReference = {
  productRef: ProductRefSchema,
  variantRef: Schema.optionalKey(VariantRefSchema),
};

const PriceCatalogTargetRejectedSchema = Schema.Struct({
  ...rejectedTargetReference,
  outcome: Schema.Literal('PRICE_CATALOG_TARGET_REJECTED'),
  reason: PriceCatalogTargetRejectionReasonSchema,
}).check(
  Schema.makeFilter(({ productRef, reason, variantRef }) => {
    if (reason === 'PRODUCT_ONLY_TARGET' || reason === 'VARIANT_MISSING') {
      return variantRef === undefined ? undefined : `${reason} cannot identify a Variant`;
    }
    if (variantRef === undefined) {
      return `${reason} must identify the rejected Variant`;
    }
    if (reason === 'VARIANT_FOREIGN_TENANT') {
      return variantRef.tenantId === productRef.tenantId
        ? 'A foreign-Tenant Variant must differ from the Product Tenant'
        : undefined;
    }
    return variantRef.tenantId === productRef.tenantId
      ? undefined
      : 'Only VARIANT_FOREIGN_TENANT may describe a cross-Tenant Variant';
  }),
);

export const PriceCatalogTargetIndeterminateReasonSchema = Schema.Literals([
  'CATALOG_TARGET_NOT_FOUND',
  'CATALOG_PERMISSION_DENIED',
  'CATALOG_CONFLICT',
  'CATALOG_UNAVAILABLE',
]);
export type PriceCatalogTargetIndeterminateReason = typeof PriceCatalogTargetIndeterminateReasonSchema.Type;

const PriceCatalogTargetIndeterminateSchema = Schema.Struct({
  ...rejectedTargetReference,
  outcome: Schema.Literal('PRICE_CATALOG_TARGET_INDETERMINATE'),
  reason: PriceCatalogTargetIndeterminateReasonSchema,
}).check(
  Schema.makeFilter(({ productRef, variantRef }) =>
    variantRef === undefined || variantRef.tenantId === productRef.tenantId
      ? undefined
      : 'Cross-Tenant Variants are rejected, not indeterminate',
  ),
);

/** Closed validation result; malformed or unverifiable Catalog meaning never becomes a Price target. */
export const PriceCatalogTargetAssessmentSchema = Schema.Union([
  PriceCatalogTargetAcceptedSchema,
  PriceCatalogTargetRejectedSchema,
  PriceCatalogTargetIndeterminateSchema,
]);
export type PriceCatalogTargetAssessment = typeof PriceCatalogTargetAssessmentSchema.Type;

export const PriceProductTargetSnapshotIdSchema = stableReference.pipe(
  Schema.brand('PriceProductTargetSnapshotId'),
  Schema.decodeTo(Schema.String),
);
export type PriceProductTargetSnapshotId = typeof PriceProductTargetSnapshotIdSchema.Type;

export const PriceProductTargetIdSchema = stableReference.pipe(
  Schema.brand('PriceProductTargetId'),
  Schema.decodeTo(Schema.String),
);
export type PriceProductTargetId = typeof PriceProductTargetIdSchema.Type;

export const PriceProductTargetSnapshotEntrySchema = Schema.Struct({
  catalogEvidence: CatalogSelectionValidEvidenceSchema,
  target: PriceCatalogTargetSchema,
  targetId: PriceProductTargetIdSchema,
}).check(
  Schema.makeFilter(({ catalogEvidence, target }) =>
    priceCatalogTargetsEqual(catalogEvidence.selection, target)
      ? undefined
      : 'Product target snapshot evidence must bind its exact target',
  ),
);
export type PriceProductTargetSnapshotEntry = typeof PriceProductTargetSnapshotEntrySchema.Type;

const PriceProductTargetSnapshotEntriesSchema = Schema.Array(PriceProductTargetSnapshotEntrySchema).check(
  Schema.isMinLength(1),
  Schema.makeFilter((entries) =>
    new Set(entries.map(({ targetId }) => targetId)).size === entries.length
      ? undefined
      : 'Product target snapshot target IDs must be unique',
  ),
  Schema.makeFilter((entries) =>
    entries.some(({ target }, index) =>
      entries.slice(index + 1).some(({ target: later }) => priceCatalogTargetsEqual(target, later)),
    )
      ? 'Product target snapshot cannot contain the same exact target twice'
      : undefined,
  ),
);

/**
 * Immutable Product-admin expansion. Only these owner-resolved exact targets belong to the bulk
 * intent; a later Variant is not added and absence of optional material never means wildcard.
 */
export const PriceProductTargetSnapshotSchema = Schema.Struct({
  capturedAt: PricingInstantSchema,
  catalogOwnerRevision: stableReference,
  productRef: ProductRefSchema,
  snapshotId: PriceProductTargetSnapshotIdSchema,
  targets: PriceProductTargetSnapshotEntriesSchema,
  targetSetCompleteness: Schema.toEncoded(OwnerVerifiableSetCompletenessEvidenceSchema),
}).check(
  Schema.makeFilter(({ catalogOwnerRevision, targetSetCompleteness }) =>
    catalogOwnerRevision === targetSetCompleteness.ownerRevision
      ? undefined
      : 'Product target snapshot must bind the same Catalog owner revision as its completeness evidence',
  ),
  Schema.makeFilter(({ capturedAt, targetSetCompleteness }) =>
    capturedAt === targetSetCompleteness.observedAt
      ? undefined
      : 'Product target snapshot capture time must equal its owner completeness observation time',
  ),
  Schema.makeFilter(({ productRef, targets }) =>
    targets.every(({ target }) => productRefEquivalence(target.productRef, productRef))
      ? undefined
      : 'Every Product target snapshot entry must belong to the snapshot Product',
  ),
  Schema.makeFilter(({ capturedAt, targets }) =>
    targets.every(
      ({ catalogEvidence }) =>
        catalogEvidence.purpose === 'PRICING' &&
        catalogEvidence.assessedAt >= capturedAt &&
        catalogEvidence.membership.observedAt === catalogEvidence.assessedAt,
    )
      ? undefined
      : 'Every Product target snapshot entry requires Pricing evidence assessed no earlier than capture',
  ),
);
export type PriceProductTargetSnapshot = typeof PriceProductTargetSnapshotSchema.Type;

/** Stable identity for one per-target result; outcome and retry transport are owned by later work. */
export const PriceProductTargetOutcomeIdentitySchema = Schema.Struct({
  snapshotId: PriceProductTargetSnapshotIdSchema,
  target: PriceCatalogTargetSchema,
  targetId: PriceProductTargetIdSchema,
});
export type PriceProductTargetOutcomeIdentity = typeof PriceProductTargetOutcomeIdentitySchema.Type;
