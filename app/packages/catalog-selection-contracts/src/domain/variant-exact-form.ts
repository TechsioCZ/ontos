import { CatalogIdentityScopeSchema } from './identity-scope.ts';

/**
 * An exact predefined form identifies both its Product and one explicit Variant.
 * This private contract carries identity only: it does not certify Current validity,
 * axis completeness, assortment, price, availability, or permission.
 */
export const VariantExactFormSchema = CatalogIdentityScopeSchema;
export type VariantExactForm = typeof VariantExactFormSchema.Type;
