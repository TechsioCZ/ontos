export {
  CatalogRevisionTenantIdSchema,
  CatalogRevisionResourceIdSchema,
  CatalogRevisionIdSchema,
  CatalogRevisionNumberSchema,
  CatalogResourceRefSchema,
  CatalogRevisionInstantSchema,
} from './domain/catalog-resource-reference.ts';
export type {
  CatalogRevisionTenantId,
  CatalogRevisionResourceId,
  CatalogRevisionId,
  CatalogRevisionNumber,
  CatalogResourceRef,
  CatalogResourceRefInput,
  CatalogRevisionInstant,
} from './domain/catalog-resource-reference.ts';
export {
  CatalogSelectionRevisionSchema,
  ProductSelectionRevisionSchema,
  VariantSelectionRevisionSchema,
  PackageDefinitionSelectionRevisionSchema,
  SetCompositionSelectionRevisionSchema,
  ProductConfigurationSelectionSchema,
  CatalogSelectionSchema,
} from './domain/catalog-selection.ts';
export type { CatalogSelectionRevision, CatalogSelection } from './domain/catalog-selection.ts';
export { ProductRefSchema } from './resources/product.ts';
export type { ProductRef } from './resources/product.ts';
export { ProductUnitRefSchema } from './resources/product-unit.ts';
export type { ProductUnitRef } from './resources/product-unit.ts';
export { VariantRefSchema } from './resources/variant.ts';
export type { VariantRef } from './resources/variant.ts';
