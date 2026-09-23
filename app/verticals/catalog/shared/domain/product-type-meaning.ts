import { Effect, Match, Schema } from 'effect';

import { ProductRefSchema } from '../resources/product.ts';
import { ProductTypeRefSchema } from '../resources/product-type.ts';
import type { ProductTypeRef } from '../resources/product-type.ts';
import { CatalogRevisionNumberSchema, CatalogResourceRefSchema } from './catalog-revision-reference.ts';
import type { CatalogRevisionNumber } from './catalog-revision-reference.ts';
import { ProductTypeAttributeRuleSchema, ProductTypeRulesRevisionSchema } from './product-type-rules.ts';
import type { ProductTypeAttributeRule } from './product-type-rules.ts';

/**
 * A Product Type has exactly one canonical meaning: its stable Tenant-scoped
 * identity plus the owner-qualified rules of an exact revision. A display name,
 * Category, sales channel, Set marker or Package Option is not a meaning and
 * cannot stand in for the declared structured-data requirements.
 */

/** The immutable, order-normalized rules a caller must share to describe the same requirements. */
export const ProductTypeCanonicalMeaningSchema = Schema.Struct({
  productTypeRef: ProductTypeRefSchema,
  revision: CatalogRevisionNumberSchema,
  rules: Schema.Array(ProductTypeAttributeRuleSchema),
});
export type ProductTypeCanonicalMeaning = typeof ProductTypeCanonicalMeaningSchema.Type;

interface ProductTypeMeaningSource {
  readonly productTypeRef: ProductTypeRef;
  readonly revision: CatalogRevisionNumber;
  readonly rules: readonly ProductTypeAttributeRule[];
}

const levelRank = (level: ProductTypeAttributeRule['level']): number => (level === 'PRODUCT' ? 0 : 1);
const compareRules = (left: ProductTypeAttributeRule, right: ProductTypeAttributeRule): number =>
  levelRank(left.level) - levelRank(right.level) ||
  left.attributeDefinitionRef.resourceId.localeCompare(right.attributeDefinitionRef.resourceId, 'en') ||
  Number(left.required) - Number(right.required);

interface OwnedCatalogReference {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}

const sameCatalogRef = (left: OwnedCatalogReference, right: OwnedCatalogReference): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

/** The same declared requirements compare equal regardless of declaration order or display name. */
export const canonicalizeProductTypeMeaning = (source: ProductTypeMeaningSource): ProductTypeCanonicalMeaning => ({
  productTypeRef: source.productTypeRef,
  revision: source.revision,
  rules: [...source.rules].toSorted(compareRules),
});

/** Equality is identity, exact revision, and the complete owner-qualified rule set; never a name. */
export const sameProductTypeMeaning = (
  left: ProductTypeCanonicalMeaning,
  right: ProductTypeCanonicalMeaning,
): boolean =>
  sameCatalogRef(left.productTypeRef, right.productTypeRef) &&
  left.revision === right.revision &&
  left.rules.length === right.rules.length &&
  left.rules.every((rule, index) => {
    const other = right.rules[index];
    return (
      other !== undefined &&
      rule.level === other.level &&
      rule.required === other.required &&
      sameCatalogRef(rule.attributeDefinitionRef, other.attributeDefinitionRef)
    );
  });

const nonEmptyText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());

/**
 * A claim about what a Product Type "is". Only an owner-qualified rules revision
 * carries meaning; the other variants exist so a label, classification, channel,
 * Set marker or Package Option can be rejected explicitly instead of inferred.
 */
export const ProductTypeMeaningClaimSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('RULES_REVISION'),
    revision: ProductTypeRulesRevisionSchema,
  }),
  Schema.Struct({
    categoryRef: CatalogResourceRefSchema,
    kind: Schema.Literal('CATEGORY'),
  }),
  Schema.Struct({
    channelName: nonEmptyText,
    kind: Schema.Literal('SALES_CHANNEL'),
  }),
  Schema.Struct({
    kind: Schema.Literal('FREE_TEXT_LABEL'),
    label: nonEmptyText,
  }),
  Schema.Struct({
    kind: Schema.Literal('SET_MARKER'),
    productRef: ProductRefSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('PACKAGE_OPTION'),
    packageDefinitionRef: CatalogResourceRefSchema,
  }),
]);
export type ProductTypeMeaningClaim = typeof ProductTypeMeaningClaimSchema.Type;

export class ProductTypeMeaningRejected extends Schema.TaggedError<ProductTypeMeaningRejected>()(
  'ProductTypeMeaningRejected',
  {
    code: Schema.Literal('product_type_meaning_rejected'),
    reason: Schema.String,
    standIn: Schema.Literals(['CATEGORY', 'SALES_CHANNEL', 'FREE_TEXT_LABEL', 'SET_MARKER', 'PACKAGE_OPTION']),
  },
) {}

const standInLabel = (standIn: ProductTypeMeaningRejected['standIn']): string =>
  Match.value(standIn).pipe(
    Match.when('CATEGORY', () => 'a Product Category'),
    Match.when('SALES_CHANNEL', () => 'a sales channel'),
    Match.when('FREE_TEXT_LABEL', () => 'a free-text label'),
    Match.when('SET_MARKER', () => 'a Set marker'),
    Match.when('PACKAGE_OPTION', () => 'a Package Option'),
    Match.exhaustive,
  );

/** Resolves the single canonical meaning, or fails closed on any non-type stand-in. */
export const resolveCanonicalProductTypeMeaning = (
  claim: ProductTypeMeaningClaim,
): Effect.Effect<ProductTypeCanonicalMeaning, ProductTypeMeaningRejected> => {
  if (claim.kind === 'RULES_REVISION') {
    return Effect.succeed(canonicalizeProductTypeMeaning(claim.revision));
  }
  return Effect.fail(
    new ProductTypeMeaningRejected({
      code: 'product_type_meaning_rejected',
      reason: `A Product Type is defined by owner-qualified rules, not by ${standInLabel(claim.kind)}`,
      standIn: claim.kind,
    }),
  );
};
