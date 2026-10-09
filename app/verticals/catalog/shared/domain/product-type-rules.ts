import { Option, Schema } from 'effect';

import { ProductRefSchema } from '../resources/product.ts';
import { ProductTypeRefSchema } from '../resources/product-type.ts';
import { VariantRefSchema } from '../resources/variant.ts';
import {
  CatalogResourceRefSchema,
  CatalogRevisionIdSchema,
  CatalogRevisionInstantSchema,
  CatalogRevisionNumberSchema,
} from './catalog-revision-reference.ts';

/** The Definition resource is owned by #402; a type only references its identity. */
const AttributeDefinitionRefSchema = CatalogResourceRefSchema.check(
  Schema.makeFilter((ref) =>
    ref.resourceType === 'commerce.catalog.attribute-definition'
      ? undefined
      : 'Product Type rules must reference an Attribute Definition',
  ),
);

export const ProductTypeAttributeRuleSchema = Schema.Struct({
  attributeDefinitionRef: AttributeDefinitionRefSchema,
  level: Schema.Literals(['PRODUCT', 'VARIANT']),
  required: Schema.Boolean,
});
export type ProductTypeAttributeRule = typeof ProductTypeAttributeRuleSchema.Type;

const validateRules = (
  productTypeRef: { readonly tenantId: string },
  rules: readonly ProductTypeAttributeRule[],
): string | undefined => {
  const keys = new Set<string>();
  for (const rule of rules) {
    if (rule.attributeDefinitionRef.tenantId !== productTypeRef.tenantId) {
      return 'Attribute Definitions must belong to the Product Type Tenant';
    }
    const key = `${rule.level}:${rule.attributeDefinitionRef.resourceId}`;
    if (keys.has(key)) {
      return 'A Product Type revision cannot repeat an Attribute Definition at one level';
    }
    keys.add(key);
  }
  return keys.size === rules.length
    ? undefined
    : 'A Product Type revision cannot repeat an Attribute Definition at one level';
};

/** Exact immutable rules; optional is represented by required=false, never an inferred default. */
export const ProductTypeRulesRevisionSchema = Schema.Struct({
  productTypeRef: ProductTypeRefSchema,
  revision: CatalogRevisionNumberSchema,
  rules: Schema.Array(ProductTypeAttributeRuleSchema),
}).check(Schema.makeFilter(({ productTypeRef, rules }) => validateRules(productTypeRef, rules)));

/** Persisted, immutable revision identity used for Current evaluation. */
export const ProductTypeCurrentRulesRevisionSchema = Schema.Struct({
  effectiveFrom: CatalogRevisionInstantSchema,
  productTypeRef: ProductTypeRefSchema,
  revision: CatalogRevisionNumberSchema,
  revisionId: CatalogRevisionIdSchema,
  rules: Schema.Array(ProductTypeAttributeRuleSchema),
}).check(Schema.makeFilter(({ productTypeRef, rules }) => validateRules(productTypeRef, rules)));
export type ProductTypeCurrentRulesRevision = typeof ProductTypeCurrentRulesRevisionSchema.Type;

const ProductTypeCurrentValueSchema = Schema.Struct({
  attributeDefinitionRef: AttributeDefinitionRefSchema,
  /** #402 validates shape, unit and business values; an invalid optional value still fails. */
  valid: Schema.Boolean,
});
export type ProductTypeCurrentValue = typeof ProductTypeCurrentValueSchema.Type;

const ProductTypeVariantValuesSchema = Schema.Struct({
  /** Inheritance is included here only after #429/#430 explicitly permit and validate it. */
  effectiveValues: Schema.Array(ProductTypeCurrentValueSchema),
  productRef: ProductRefSchema,
  variantRef: VariantRefSchema,
});

export const ProductTypeSubjectSchema = Schema.Struct({
  currentProductTypeRef: Schema.optionalKey(ProductTypeRefSchema),
  productRef: ProductRefSchema,
  productValues: Schema.Array(ProductTypeCurrentValueSchema),
  variants: Schema.Array(ProductTypeVariantValuesSchema),
}).check(
  Schema.makeFilter(({ currentProductTypeRef, productRef, productValues, variants }) =>
    (currentProductTypeRef === undefined || currentProductTypeRef.tenantId === productRef.tenantId) &&
    productValues.every((value) => value.attributeDefinitionRef.tenantId === productRef.tenantId) &&
    variants.every(
      (variant) =>
        variant.variantRef.tenantId === productRef.tenantId &&
        variant.productRef.resourceId === productRef.resourceId &&
        variant.productRef.tenantId === productRef.tenantId &&
        variant.effectiveValues.every((value) => value.attributeDefinitionRef.tenantId === productRef.tenantId),
    )
      ? undefined
      : 'Product Type subject, values, and Variants must belong to one Tenant',
  ),
  Schema.makeFilter(({ productValues, variants }) => {
    if (new Set(productValues.map((value) => value.attributeDefinitionRef.resourceId)).size !== productValues.length) {
      return 'A Product cannot repeat a Current Attribute Definition';
    }
    if (new Set(variants.map((variant) => variant.variantRef.resourceId)).size !== variants.length) {
      return 'A Product cannot repeat a Current Variant';
    }
    return variants.every(
      (variant) =>
        new Set(variant.effectiveValues.map((value) => value.attributeDefinitionRef.resourceId)).size ===
        variant.effectiveValues.length,
    )
      ? undefined
      : 'A Variant cannot repeat an effective Attribute Definition';
  }),
);
export type ProductTypeSubject = typeof ProductTypeSubjectSchema.Type;

/** Owner-issued Current basis, not an implicit latest revision or a caller-selected rule set. */
export const ProductTypeCurrentBasisSchema = Schema.Struct({
  currentRevision: CatalogRevisionNumberSchema,
  effectiveFrom: CatalogRevisionInstantSchema,
  effectiveUntil: Schema.optionalKey(CatalogRevisionInstantSchema),
  evaluatedAt: CatalogRevisionInstantSchema,
  productTypeRef: ProductTypeRefSchema,
  revision: CatalogRevisionNumberSchema,
  revisionId: CatalogRevisionIdSchema,
}).check(
  Schema.makeFilter(({ effectiveFrom, effectiveUntil }) =>
    effectiveUntil === undefined || effectiveFrom < effectiveUntil
      ? undefined
      : 'Product Type revision effective interval must be nonempty',
  ),
);
export type ProductTypeCurrentBasis = typeof ProductTypeCurrentBasisSchema.Type;

interface ProductTypeViolation {
  readonly attributeDefinitionId: string;
  readonly kind: 'DISALLOWED' | 'INVALID' | 'MISSING_REQUIRED';
  readonly level: 'PRODUCT' | 'VARIANT';
  variantId?: string;
}

export interface ProductTypeRulesResult {
  readonly basisStatus:
    | 'CURRENT'
    | 'UNTYPED'
    | 'MISSING'
    | 'MALFORMED'
    | 'WRONG_TYPE'
    | 'STALE_REVISION'
    | 'NOT_EFFECTIVE';
  readonly minimumSatisfied: boolean;
  revision?: number;
  revisionContext?: ProductTypeCurrentBasis;
  readonly violations: readonly ProductTypeViolation[];
}

/** Evaluates only Product Type minimum, never overall Catalog readiness or purchasing permission. */
export const evaluateProductTypeRules = (
  subject: ProductTypeSubject,
  rulesRevision?: ProductTypeCurrentRulesRevision,
  currentBasis?: typeof ProductTypeCurrentBasisSchema.Encoded,
): ProductTypeRulesResult => {
  const violations: ProductTypeViolation[] = [];
  if (!Schema.is(ProductTypeSubjectSchema)(subject)) {
    return { basisStatus: 'MALFORMED', minimumSatisfied: false, violations };
  }
  const decodedBasis =
    currentBasis === undefined
      ? undefined
      : Option.getOrUndefined(Schema.decodeOption(ProductTypeCurrentBasisSchema)(currentBasis));
  const basisStatus: ProductTypeRulesResult['basisStatus'] = (() => {
    if (subject.currentProductTypeRef === undefined) {
      return currentBasis === undefined ? 'UNTYPED' : 'WRONG_TYPE';
    }
    if (rulesRevision === undefined || currentBasis === undefined) {
      return 'MISSING';
    }
    if (
      decodedBasis === undefined ||
      !Schema.is(ProductTypeCurrentRulesRevisionSchema)(rulesRevision) ||
      !Schema.is(ProductTypeRulesRevisionSchema)(rulesRevision)
    ) {
      return 'MALFORMED';
    }
    if (
      decodedBasis.productTypeRef.resourceId !== subject.currentProductTypeRef.resourceId ||
      decodedBasis.productTypeRef.tenantId !== subject.currentProductTypeRef.tenantId ||
      rulesRevision.productTypeRef.resourceId !== decodedBasis.productTypeRef.resourceId ||
      rulesRevision.productTypeRef.tenantId !== decodedBasis.productTypeRef.tenantId
    ) {
      return 'WRONG_TYPE';
    }
    if (
      decodedBasis.revision !== rulesRevision.revision ||
      decodedBasis.currentRevision !== rulesRevision.revision ||
      decodedBasis.revisionId !== rulesRevision.revisionId ||
      decodedBasis.effectiveFrom !== rulesRevision.effectiveFrom
    ) {
      return 'STALE_REVISION';
    }
    if (
      decodedBasis.evaluatedAt < decodedBasis.effectiveFrom ||
      (decodedBasis.effectiveUntil !== undefined && decodedBasis.evaluatedAt >= decodedBasis.effectiveUntil)
    ) {
      return 'NOT_EFFECTIVE';
    }
    return 'CURRENT';
  })();
  const activeRevision =
    basisStatus === 'CURRENT' &&
    rulesRevision !== undefined &&
    subject.currentProductTypeRef !== undefined &&
    rulesRevision.productTypeRef.resourceId === subject.currentProductTypeRef.resourceId &&
    rulesRevision.productTypeRef.tenantId === subject.currentProductTypeRef.tenantId &&
    rulesRevision.productTypeRef.tenantId === subject.productRef.tenantId
      ? rulesRevision
      : undefined;
  const rules = activeRevision?.rules ?? [];
  const inspect = (
    level: 'PRODUCT' | 'VARIANT',
    values: readonly ProductTypeCurrentValue[],
    variantId?: string,
  ): void => {
    const allowed = rules.filter((rule) => rule.level === level);
    for (const value of values) {
      const attributeDefinitionId = value.attributeDefinitionRef.resourceId;
      if (
        value.attributeDefinitionRef.tenantId !== subject.productRef.tenantId ||
        !allowed.some((rule) => rule.attributeDefinitionRef.resourceId === attributeDefinitionId)
      ) {
        const violation: ProductTypeViolation = {
          attributeDefinitionId,
          kind: 'DISALLOWED',
          level,
        };
        if (variantId !== undefined) {
          violation.variantId = variantId;
        }
        violations.push(violation);
      } else if (!value.valid) {
        const violation: ProductTypeViolation = {
          attributeDefinitionId,
          kind: 'INVALID',
          level,
        };
        if (variantId !== undefined) {
          violation.variantId = variantId;
        }
        violations.push(violation);
      }
    }
    for (const rule of allowed) {
      if (
        rule.required &&
        !values.some(
          (value) => value.attributeDefinitionRef.resourceId === rule.attributeDefinitionRef.resourceId && value.valid,
        )
      ) {
        const violation: ProductTypeViolation = {
          attributeDefinitionId: rule.attributeDefinitionRef.resourceId,
          kind: 'MISSING_REQUIRED',
          level,
        };
        if (variantId !== undefined) {
          violation.variantId = variantId;
        }
        violations.push(violation);
      }
    }
  };
  inspect('PRODUCT', subject.productValues);
  for (const variant of subject.variants) {
    inspect('VARIANT', variant.effectiveValues, variant.variantRef.resourceId);
  }
  const result: ProductTypeRulesResult = {
    basisStatus,
    // Empty Current facts do not establish that an untyped Product needs no
    // structured attributes or Variant Axes. That decision needs its own basis.
    minimumSatisfied: violations.length === 0 && basisStatus === 'CURRENT',
    violations,
  };
  if (activeRevision !== undefined && decodedBasis !== undefined) {
    result.revision = activeRevision.revision;
    result.revisionContext = decodedBasis;
  }
  return result;
};
