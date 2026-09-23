import { Schema } from 'effect';

import { CatalogRevisionInstantSchema, CatalogRevisionNumberSchema } from '../domain/catalog-revision-reference.ts';
import { ProductTypeAttributeRuleSchema } from '../domain/product-type-rules.ts';
import { ProductRefSchema } from '../resources/product.ts';
import { ProductTypeRefSchema } from '../resources/product-type.ts';

/** The owner-side impact scan issues a SHA-256 digest of its complete v2 basis. */
const ImpactBasisTokenSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u), Schema.isTrimmed());

/** A preview is intent; the owner must reread and lock this exact basis. */
export const ReviseProductTypePayloadSchema = Schema.Struct({
  effectiveFrom: CatalogRevisionInstantSchema,
  expectedCurrentRevision: CatalogRevisionNumberSchema,
  impactBasisToken: ImpactBasisTokenSchema,
  productTypeRef: ProductTypeRefSchema,
  proposedRules: Schema.Array(ProductTypeAttributeRuleSchema),
  unresolvedProductRefs: Schema.Array(ProductRefSchema),
}).check(
  Schema.makeFilter(({ productTypeRef, proposedRules, unresolvedProductRefs }) => {
    const violations: string[] = [];
    const seenRules = new Set<string>();
    for (const rule of proposedRules) {
      if (rule.attributeDefinitionRef.tenantId !== productTypeRef.tenantId) {
        violations.push('All rules must belong to the Product Type Tenant');
      }
      const key = `${rule.level}:${rule.attributeDefinitionRef.resourceId}`;
      if (seenRules.has(key)) {
        violations.push('A Product Type revision cannot repeat a rule at one level');
      }
      seenRules.add(key);
    }
    const seenProducts = new Set<string>();
    for (const productRef of unresolvedProductRefs) {
      if (productRef.tenantId !== productTypeRef.tenantId || seenProducts.has(productRef.resourceId)) {
        violations.push('Unresolved Products must be unique and belong to the Product Type Tenant');
      }
      seenProducts.add(productRef.resourceId);
    }
    return violations[0];
  }),
);
export type ReviseProductTypePayload = typeof ReviseProductTypePayloadSchema.Type;

export const ReviseProductTypeResultSchema = Schema.Struct({
  effectiveFrom: CatalogRevisionInstantSchema,
  productTypeRef: ProductTypeRefSchema,
  revision: CatalogRevisionNumberSchema,
  unresolvedProductRefs: Schema.Array(ProductRefSchema),
});
