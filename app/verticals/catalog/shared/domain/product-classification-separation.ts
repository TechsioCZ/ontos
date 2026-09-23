import { Schema } from 'effect';

import type { ProductCategoryRef } from '../resources/product-category.ts';
import { ProductCategoryRefSchema } from '../resources/product-category.ts';
import { ProductRefSchema } from '../resources/product.ts';
import type { ProductTypeRef } from '../resources/product-type.ts';
import { ProductTypeRefSchema } from '../resources/product-type.ts';
import type { ProductTypeAttributeRule, ProductTypeCurrentRulesRevision } from './product-type-rules.ts';

/**
 * #425 keeps the three Product classifications distinct:
 *
 * - Product Type answers which structured Attribute Definitions are allowed or required;
 * - Product Category answers where the Product is classified for merchandising;
 * - Sales Channel answers where it is available or sold, which Catalog does not own.
 *
 * A Product has at most one Product Type, zero or more Product Categories, and zero or more Sales
 * Channels. This module is the Catalog-owned seam: a transition touches exactly one facet and
 * carries every non-classification fact unchanged, and Product Type rules can only be read from the
 * assigned Product Type revision — never inferred from a Category or a Sales Channel.
 */

const checkedUuid = Schema.String.check(Schema.isUUID(), Schema.isTrimmed());
const checkedKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200), Schema.isTrimmed());
const TenantIdSchema = checkedUuid.pipe(Schema.brand('CatalogTenantId'), Schema.decodeTo(checkedUuid));
const SalesChannelModuleIdSchema = checkedKey.pipe(
  Schema.brand('CatalogSalesChannelModuleId'),
  Schema.decodeTo(checkedKey),
);
const SalesChannelResourceIdSchema = checkedKey.pipe(
  Schema.brand('CatalogSalesChannelResourceId'),
  Schema.decodeTo(checkedKey),
);

const CATALOG_CLASSIFICATION_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  'commerce.catalog.product-category',
  'commerce.catalog.product-type',
]);

/**
 * Availability and selling context are owned outside Catalog; Catalog stores only an
 * owner-qualified reference. A Product Type or Product Category reference is deliberately not a
 * valid Sales Channel, so the two classifications cannot collapse into one another.
 */
export const SalesChannelRefSchema = Schema.Struct({
  moduleId: SalesChannelModuleIdSchema,
  resourceId: SalesChannelResourceIdSchema,
  resourceType: checkedKey,
  tenantId: TenantIdSchema,
}).check(
  Schema.makeFilter(({ resourceType }) =>
    CATALOG_CLASSIFICATION_RESOURCE_TYPES.has(resourceType)
      ? 'A Sales Channel must not be a Catalog Product Type or Product Category'
      : undefined,
  ),
);
export type SalesChannelRef = typeof SalesChannelRefSchema.Type;

const sameCategoryRef = (left: ProductCategoryRef, right: ProductCategoryRef): boolean =>
  left.tenantId === right.tenantId && left.resourceId === right.resourceId;

const sameTypeRef = (left: ProductTypeRef | undefined, right: ProductTypeRef): boolean =>
  left !== undefined && left.tenantId === right.tenantId && left.resourceId === right.resourceId;

const salesChannelKey = (ref: SalesChannelRef): string =>
  `${ref.moduleId}:${ref.resourceType}:${ref.resourceId}:${ref.tenantId}`;

const sameSalesChannelRef = (left: SalesChannelRef, right: SalesChannelRef): boolean =>
  salesChannelKey(left) === salesChannelKey(right);

export const ProductClassificationSchema = Schema.Struct({
  /** Zero or one canonical Product Type; a draft may stay untyped. */
  currentProductTypeRef: Schema.optionalKey(ProductTypeRefSchema),
  /** Zero or more independent merchandising links; no primary Category is recorded. */
  productCategoryRefs: Schema.Array(ProductCategoryRefSchema),
  productRef: ProductRefSchema,
  /** Zero or more external availability and selling contexts. */
  salesChannelRefs: Schema.Array(SalesChannelRefSchema),
}).check(
  Schema.makeFilter(({ currentProductTypeRef, productCategoryRefs, productRef, salesChannelRefs }) => {
    if (currentProductTypeRef !== undefined && currentProductTypeRef.tenantId !== productRef.tenantId) {
      return 'The Product Type and Product must belong to the same Tenant';
    }
    if (productCategoryRefs.some((ref) => ref.tenantId !== productRef.tenantId)) {
      return 'Product Category links must belong to the Product Tenant';
    }
    if (salesChannelRefs.some((ref) => ref.tenantId !== productRef.tenantId)) {
      return 'Sales Channel links must belong to the Product Tenant';
    }
    if (new Set(productCategoryRefs.map((ref) => ref.resourceId)).size !== productCategoryRefs.length) {
      return 'A Product cannot repeat a direct Product Category link';
    }
    return new Set(salesChannelRefs.map(salesChannelKey)).size === salesChannelRefs.length
      ? undefined
      : 'A Product cannot repeat a Sales Channel link';
  }),
);
export type ProductClassification = typeof ProductClassificationSchema.Type;

export const ProductClassificationFacetSchema = Schema.Literals(['PRODUCT_TYPE', 'PRODUCT_CATEGORY', 'SALES_CHANNEL']);
export type ProductClassificationFacet = typeof ProductClassificationFacetSchema.Type;

/** One explicit change to exactly one classification facet. */
export const ProductClassificationChangeSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('SET_PRODUCT_TYPE'),
    nextProductTypeRef: ProductTypeRefSchema,
  }),
  Schema.Struct({ categoryRef: ProductCategoryRefSchema, kind: Schema.Literal('ADD_PRODUCT_CATEGORY') }),
  Schema.Struct({ categoryRef: ProductCategoryRefSchema, kind: Schema.Literal('REMOVE_PRODUCT_CATEGORY') }),
  Schema.Struct({ kind: Schema.Literal('ADD_SALES_CHANNEL'), salesChannelRef: SalesChannelRefSchema }),
  Schema.Struct({ kind: Schema.Literal('REMOVE_SALES_CHANNEL'), salesChannelRef: SalesChannelRefSchema }),
]);
export type ProductClassificationChange = typeof ProductClassificationChangeSchema.Type;

/**
 * `facts` carries every non-classification Product fact (attribute values, Package content, Set
 * composition, identity) through a classification change by reference. The change can only return
 * a new classification; it never reaches into the facts.
 */
export type ProductClassificationChangeOutcome<Facts = Readonly<Record<string, never>>> =
  | {
      readonly changedFacets: readonly ProductClassificationFacet[];
      readonly facts: Facts;
      readonly product: ProductClassification;
      readonly status: 'APPLIED';
    }
  | { readonly status: 'TENANT_MISMATCH' };

const applied = <Facts>(
  changedFacets: readonly ProductClassificationFacet[],
  product: ProductClassification,
  facts: Facts,
): ProductClassificationChangeOutcome<Facts> => ({ changedFacets, facts, product, status: 'APPLIED' });

const TENANT_MISMATCH_OUTCOME = { status: 'TENANT_MISMATCH' } as const;

/**
 * Apply one facet change to a Product classification. A Category or Sales Channel change can never
 * rewrite the Product Type, and a Product Type change can never move a Category. Reclassifying a
 * Product Type back to untyped is a #423 owner decision, not a classification rewrite.
 */
export const applyProductClassificationChange = <Facts>(
  product: ProductClassification,
  facts: Facts,
  change: ProductClassificationChange,
): ProductClassificationChangeOutcome<Facts> => {
  if (change.kind === 'SET_PRODUCT_TYPE') {
    const { nextProductTypeRef } = change;
    if (nextProductTypeRef.tenantId !== product.productRef.tenantId) {
      return TENANT_MISMATCH_OUTCOME;
    }
    return sameTypeRef(product.currentProductTypeRef, nextProductTypeRef)
      ? applied([], product, facts)
      : applied(['PRODUCT_TYPE'], { ...product, currentProductTypeRef: nextProductTypeRef }, facts);
  }
  if (change.kind === 'ADD_PRODUCT_CATEGORY') {
    const { categoryRef } = change;
    if (categoryRef.tenantId !== product.productRef.tenantId) {
      return TENANT_MISMATCH_OUTCOME;
    }
    return product.productCategoryRefs.some((ref) => sameCategoryRef(ref, categoryRef))
      ? applied([], product, facts)
      : applied(
          ['PRODUCT_CATEGORY'],
          { ...product, productCategoryRefs: [...product.productCategoryRefs, categoryRef] },
          facts,
        );
  }
  if (change.kind === 'REMOVE_PRODUCT_CATEGORY') {
    const { categoryRef } = change;
    if (categoryRef.tenantId !== product.productRef.tenantId) {
      return TENANT_MISMATCH_OUTCOME;
    }
    const productCategoryRefs = product.productCategoryRefs.filter((ref) => !sameCategoryRef(ref, categoryRef));
    return productCategoryRefs.length === product.productCategoryRefs.length
      ? applied([], product, facts)
      : applied(['PRODUCT_CATEGORY'], { ...product, productCategoryRefs }, facts);
  }
  if (change.kind === 'ADD_SALES_CHANNEL') {
    const { salesChannelRef } = change;
    if (salesChannelRef.tenantId !== product.productRef.tenantId) {
      return TENANT_MISMATCH_OUTCOME;
    }
    return product.salesChannelRefs.some((ref) => sameSalesChannelRef(ref, salesChannelRef))
      ? applied([], product, facts)
      : applied(
          ['SALES_CHANNEL'],
          { ...product, salesChannelRefs: [...product.salesChannelRefs, salesChannelRef] },
          facts,
        );
  }
  const { salesChannelRef } = change;
  if (salesChannelRef.tenantId !== product.productRef.tenantId) {
    return TENANT_MISMATCH_OUTCOME;
  }
  const salesChannelRefs = product.salesChannelRefs.filter((ref) => !sameSalesChannelRef(ref, salesChannelRef));
  return salesChannelRefs.length === product.salesChannelRefs.length
    ? applied([], product, facts)
    : applied(['SALES_CHANNEL'], { ...product, salesChannelRefs }, facts);
};

/**
 * The only Product Type rule source is the assigned Product Type's Current revision. Categories and
 * Sales Channels are not parameters, so required structured data cannot be inferred from either
 * classification.
 */
export const productTypeRulesFor = (
  classification: ProductClassification,
  currentRevision: ProductTypeCurrentRulesRevision | undefined,
): readonly ProductTypeAttributeRule[] => {
  const { currentProductTypeRef } = classification;
  return currentProductTypeRef !== undefined &&
    currentRevision !== undefined &&
    currentRevision.productTypeRef.resourceId === currentProductTypeRef.resourceId &&
    currentRevision.productTypeRef.tenantId === currentProductTypeRef.tenantId
    ? currentRevision.rules
    : [];
};
