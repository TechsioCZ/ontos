import { Schema } from 'effect';

import { ProductRefSchema } from '../resources/product.ts';
import { VariantRefSchema } from '../resources/variant.ts';
import { ProductConfigurationDefinitionReferenceSchema } from './configuration-definition.ts';

/**
 * Contract-only references for the product-form vocabulary.
 *
 * Product and Variant are Resources. SKU is a code for one selection target,
 * Product Configuration is an immutable value, Package Option is a role of a
 * Package Definition, and Set is a role of an ordinary Product/Variant. This
 * module intentionally does not implement the lifecycle, package, configuration,
 * or set rules owned by the corresponding Catalog slices. #479 owns final
 * Catalog Selection assembly and Current revalidation of these references.
 */

const checkedUuid = Schema.String.check(Schema.isUUID(), Schema.isTrimmed());
const catalogTenantId = checkedUuid.pipe(Schema.brand('CatalogProductFormTenantId'), Schema.decodeTo(checkedUuid));

const packageDefinitionResourceId = checkedUuid.pipe(
  Schema.brand('CatalogPackageDefinitionResourceId'),
  Schema.decodeTo(checkedUuid),
);
const revision = Schema.Finite.check(Schema.isInt(), Schema.isBetween({ maximum: 2_147_483_647, minimum: 1 })).pipe(
  Schema.brand('CatalogProductFormRevision'),
);

/** Product identity remains the generated Catalog Product ResourceRef. */
export const ProductReferenceSchema = ProductRefSchema;
export type ProductReference = typeof ProductReferenceSchema.Type;

/** A predefined realization of exactly one Product. */
export const VariantReferenceSchema = VariantRefSchema;
export type VariantReference = typeof VariantReferenceSchema.Type;

/** A stable Catalog Resource describing one homogeneous packaging level. */
export const PackageDefinitionReferenceSchema = Schema.Struct({
  moduleId: Schema.Literal('commerce.catalog'),
  resourceId: packageDefinitionResourceId,
  resourceType: Schema.Literal('commerce.catalog.package-definition'),
  tenantId: catalogTenantId,
});
export type PackageDefinitionReference = typeof PackageDefinitionReferenceSchema.Type;

/** A Product-level Resource describing supported configuration choices. */
export { ProductConfigurationDefinitionReferenceSchema } from './configuration-definition.ts';
export type { ProductConfigurationDefinitionReference } from './configuration-definition.ts';

/**
 * A Package Option is a selectable role of one Package Definition for one Variant.
 * It deliberately has no independently allocated Package Option ResourceRef.
 */
export const PackageOptionReferenceSchema = Schema.Struct({
  kind: Schema.Literal('PACKAGE_OPTION'),
  packageDefinitionRef: PackageDefinitionReferenceSchema,
  variantRef: VariantReferenceSchema,
}).check(
  Schema.makeFilter(({ packageDefinitionRef, variantRef }) =>
    packageDefinitionRef.tenantId === variantRef.tenantId
      ? undefined
      : 'Package Option references must share one Tenant',
  ),
);
export type PackageOptionReference = typeof PackageOptionReferenceSchema.Type;

/** One of the two stable predefined targets to which an SKU can point. */
export const VariantTargetReferenceSchema = Schema.Struct({
  kind: Schema.Literal('VARIANT'),
  variantRef: VariantReferenceSchema,
});
export type VariantTargetReference = typeof VariantTargetReferenceSchema.Type;

export const PackageOptionTargetReferenceSchema = Schema.Struct({
  kind: Schema.Literal('PACKAGE_OPTION'),
  packageOptionRef: PackageOptionReferenceSchema,
});
export type PackageOptionTargetReference = typeof PackageOptionTargetReferenceSchema.Type;

export const CatalogSelectionTargetReferenceSchema = Schema.Union([
  VariantTargetReferenceSchema,
  PackageOptionTargetReferenceSchema,
]);
export type CatalogSelectionTargetReference = typeof CatalogSelectionTargetReferenceSchema.Type;

/** SKU is an internal code for exactly one Catalog Selection Target, not a Resource identity. */
export const SkuCodeSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isTrimmed(),
).pipe(Schema.brand('CatalogSkuCode'), Schema.decodeTo(Schema.String));
export type SkuCode = typeof SkuCodeSchema.Type;

export const SkuReferenceSchema = Schema.Struct({
  code: SkuCodeSchema,
  kind: Schema.Literal('SKU'),
  target: CatalogSelectionTargetReferenceSchema,
});
export type SkuReference = typeof SkuReferenceSchema.Type;

/** An owner-qualified immutable revision; a bare number or implicit "latest" is not a reference. */
export { CatalogRevisionReferenceSchema } from './catalog-revision-reference.ts';
export type { CatalogRevisionReference } from './catalog-revision-reference.ts';

export const PackageContentRevisionReferenceSchema = Schema.Struct({
  packageDefinitionRef: PackageDefinitionReferenceSchema,
  revision,
});
export type PackageContentRevisionReference = typeof PackageContentRevisionReferenceSchema.Type;

export const ProductConfigurationDefinitionRevisionReferenceSchema = Schema.Struct({
  definitionRef: ProductConfigurationDefinitionReferenceSchema,
  revision,
});
export type ProductConfigurationDefinitionRevisionReference =
  typeof ProductConfigurationDefinitionRevisionReferenceSchema.Type;

export const SetCompositionRevisionReferenceSchema = Schema.Struct({
  revision,
  variantRef: VariantReferenceSchema,
});
export type SetCompositionRevisionReference = typeof SetCompositionRevisionReferenceSchema.Type;

/**
 * Product Configuration is an immutable value refining an exact target. The
 * values remain JSON data here; definition-specific choice and unit rules are
 * owned by the configuration slice.
 */
export const ProductConfigurationSchema = Schema.Struct({
  kind: Schema.Literal('PRODUCT_CONFIGURATION'),
  target: CatalogSelectionTargetReferenceSchema,
  values: Schema.Record(Schema.String, Schema.Json),
});
export type ProductConfiguration = typeof ProductConfigurationSchema.Type;

/**
 * A Set is a normal Product whose selected Variant carries an exact composition
 * revision. This role is not a parallel Set Resource or registry.
 */
export const SetReferenceSchema = Schema.Struct({
  compositionRevision: SetCompositionRevisionReferenceSchema,
  kind: Schema.Literal('SET'),
  productRef: ProductReferenceSchema,
  variantRef: VariantReferenceSchema,
}).check(
  Schema.makeFilter(({ compositionRevision, productRef, variantRef }) =>
    productRef.tenantId === variantRef.tenantId &&
    variantRef.resourceId === compositionRevision.variantRef.resourceId &&
    variantRef.tenantId === compositionRevision.variantRef.tenantId
      ? undefined
      : 'Set references must share one Tenant and the exact Variant',
  ),
);
export type SetReference = typeof SetReferenceSchema.Type;

/** Explicitly tagged vocabulary when a consumer needs to carry one product-form reference. */
export const ProductFormReferenceSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('PRODUCT'),
    ref: ProductReferenceSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('VARIANT'),
    ref: VariantReferenceSchema,
  }),
  SkuReferenceSchema,
  ProductConfigurationSchema,
  PackageOptionReferenceSchema,
  SetReferenceSchema,
]);
export type ProductFormReference = typeof ProductFormReferenceSchema.Type;
