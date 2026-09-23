import type { EffectiveAttributeValuesResult } from '../../shared/domain/effective-attribute-values.ts';
import type { AttributeValue } from '../../shared/domain/attribute-values.ts';
import type {
  ProductTypeAttributeRule,
  ProductTypeCurrentValue,
  ProductTypeRulesResult,
} from '../../shared/domain/product-type-rules.ts';
import { evaluateProductTypeRules } from '../../shared/domain/product-type-rules.ts';
import type { ProductRef } from '../../shared/resources/product.ts';
import type { VariantRef } from '../../shared/resources/variant.ts';
import type { ProductTypeReadinessSource } from './product-type-readiness-source.ts';

/** A complete, owner-verified Current snapshot; callers must not construct this from browser input. */
export interface ProductTypeReadinessSnapshot {
  /** Owner-validated latest decision; absent means Type necessity remains unresolved. */
  readonly confirmedUntypedDecisionRevision?: number | undefined;
  readonly productValues: readonly ProductTypeCurrentValue[];
  /** Exact owner-read value-set/definition revisions; an empty list is valid only with complete inventory proof. */
  readonly productValueSource?: { readonly complete: true; readonly revisionTokens: readonly string[] };
  readonly source: ProductTypeReadinessSource;
  /** Exact Current Variant inventory verified by the owner in the same read transaction. */
  readonly variantRefs: readonly VariantRef[];
  readonly variants: readonly {
    /** Complete direct Current Variant facts, including attributes outside the Type's allowed set. */
    readonly currentAttributeDefinitionIds?: readonly string[];
    readonly currentValueSource?: { readonly complete: true; readonly revisionTokens: readonly string[] };
    /** One result per allowed Variant-level rule, including absent values. */
    readonly effectiveValues: readonly {
      readonly attributeDefinitionId: string;
      readonly result: EffectiveAttributeValuesResult;
    }[];
    readonly variantRef: VariantRef;
  }[];
}

export type ProductTypeReadinessEvaluation =
  | { readonly reason: string; readonly status: 'INDETERMINATE' }
  | {
      readonly rules: ProductTypeRulesResult;
      readonly status: 'UNTYPED_PARTIAL';
    }
  | {
      readonly decisionRevision: number;
      readonly rules: ProductTypeRulesResult;
      readonly status: 'CONFIRMED_UNTYPED_MINIMUM';
    }
  | {
      readonly assignmentRevision: number;
      readonly productValueSourceRevisionTokens: readonly string[];
      readonly rules: ProductTypeRulesResult;
      readonly rulesRevision: number;
      readonly rulesRevisionId: string;
      readonly status: 'VERIFIED_TYPE_MINIMUM' | 'INVALID';
      readonly valueRevisions: readonly {
        readonly attributeDefinitionId: string;
        readonly productRevision?: number | undefined;
        readonly variantId: string;
        readonly variantRevision?: number | undefined;
      }[];
    };

const sameRef = (left: ProductRef | VariantRef, right: ProductRef | VariantRef): boolean =>
  left.tenantId === right.tenantId && left.resourceId === right.resourceId;
const catalogModuleId = 'commerce.catalog';
const definitionResourceType = 'commerce.catalog.attribute-definition';

const countsAsEffectiveValue = (
  values: readonly AttributeValue[],
  rules: readonly ProductTypeAttributeRule[],
  definitionId: string,
): boolean => {
  if (values.length === 0) {
    return false;
  }
  const required = rules.some(
    (rule) => rule.level === 'VARIANT' && rule.required && rule.attributeDefinitionRef.resourceId === definitionId,
  );
  // An allowed explicit special state is structurally valid, but it does not confirm a required fact.
  return !required || values.some((value) => value.kind !== 'SPECIAL');
};

const currentVariantValue = (attributeDefinitionId: string, tenantId: string): ProductTypeCurrentValue => ({
  attributeDefinitionRef: {
    moduleId: catalogModuleId,
    resourceId: attributeDefinitionId,
    resourceType: definitionResourceType,
    tenantId,
  },
  valid: false,
});

const untypedVariantValues = (
  variant: ProductTypeReadinessSnapshot['variants'][number],
  tenantId: string,
): ProductTypeCurrentValue[] =>
  (variant.currentAttributeDefinitionIds ?? []).map((attributeDefinitionId) =>
    currentVariantValue(attributeDefinitionId, tenantId),
  );

const disallowedVariantValues = (
  ids: readonly string[] | undefined,
  source: Extract<ProductTypeReadinessSource, { readonly status: 'VERIFIED' }>,
): ProductTypeCurrentValue[] => {
  const allowed = new Set<string>();
  for (const rule of source.rulesRevision.rules) {
    if (rule.level === 'VARIANT') {
      allowed.add(rule.attributeDefinitionRef.resourceId);
    }
  }
  const { tenantId } = source.productRef;
  const disallowed: ProductTypeCurrentValue[] = [];
  for (const id of ids ?? []) {
    if (!allowed.has(id)) {
      disallowed.push(currentVariantValue(id, tenantId));
    }
  }
  return disallowed;
};

const effectiveSourceProblem = (
  result: Extract<EffectiveAttributeValuesResult, { readonly status: 'CURRENT' }>,
  productRef: ProductRef,
  variantRef: VariantRef,
): string | null => {
  const effectiveSource = result.source;
  if (effectiveSource === undefined) {
    return null;
  }
  if (!sameRef(effectiveSource.productRef, productRef)) {
    return 'Effective value belongs to another Product';
  }
  const sourceVariantRef = effectiveSource.variantRef;
  if (sourceVariantRef !== undefined && !sameRef(sourceVariantRef, variantRef)) {
    return 'Effective value belongs to another Variant';
  }
  if (
    effectiveSource.level === 'PRODUCT'
      ? sourceVariantRef !== undefined || effectiveSource.revision !== result.productRevision
      : sourceVariantRef === undefined || effectiveSource.revision !== result.variantRevision
  ) {
    return 'Effective value source revision is inconsistent';
  }
  return null;
};

const snapshotProblem = ({
  productValues,
  productValueSource,
  source,
  variantRefs,
  variants,
}: ProductTypeReadinessSnapshot): string | null => {
  if (
    productValueSource?.complete !== true ||
    productValueSource.revisionTokens.some((token) => token.length === 0) ||
    new Set(productValueSource.revisionTokens).size !== productValueSource.revisionTokens.length
  ) {
    return 'Complete Current Product value source is unavailable';
  }
  const productValueIds = new Set<string>();
  for (const value of productValues) {
    const ref = value.attributeDefinitionRef;
    if (
      ref.tenantId !== source.productRef.tenantId ||
      ref.moduleId !== catalogModuleId ||
      ref.resourceType !== definitionResourceType
    ) {
      return 'Product value inventory contains a foreign Attribute Definition';
    }
    if (productValueIds.has(ref.resourceId)) {
      return 'Product value inventory contains a duplicate Attribute Definition';
    }
    productValueIds.add(ref.resourceId);
  }
  if (
    variantRefs.some(
      (variant) =>
        variant.tenantId !== source.productRef.tenantId ||
        variant.moduleId !== catalogModuleId ||
        variant.resourceType !== 'commerce.catalog.variant',
    )
  ) {
    return 'Current Variant inventory contains a foreign Variant';
  }
  const variantIds = new Set(variantRefs.map((variant) => variant.resourceId));
  if (
    variantIds.size !== variantRefs.length ||
    variants.length !== variantRefs.length ||
    variants.some(
      (variant) =>
        variant.variantRef.tenantId !== source.productRef.tenantId ||
        variant.variantRef.moduleId !== catalogModuleId ||
        variant.variantRef.resourceType !== 'commerce.catalog.variant' ||
        !variantIds.has(variant.variantRef.resourceId),
    ) ||
    new Set(variants.map((variant) => variant.variantRef.resourceId)).size !== variants.length
  ) {
    return 'Current Variant inventory is incomplete or inconsistent';
  }
  if (
    variants.some(
      (variant) =>
        variant.currentValueSource?.complete !== true ||
        variant.currentValueSource.revisionTokens.some((token) => token.length === 0) ||
        new Set(variant.currentValueSource.revisionTokens).size !== variant.currentValueSource.revisionTokens.length ||
        variant.currentAttributeDefinitionIds === undefined ||
        new Set(variant.currentAttributeDefinitionIds).size !== variant.currentAttributeDefinitionIds.length,
    )
  ) {
    return 'Complete Current Variant value inventory is unavailable or ambiguous';
  }
  return null;
};

const evaluateUntypedReadiness = (snapshot: ProductTypeReadinessSnapshot): ProductTypeReadinessEvaluation => {
  const { productValues, productValueSource, source, variants } = snapshot;
  if (source.status !== 'UNTYPED' || productValueSource === undefined) {
    return { reason: 'Untyped Product source is unavailable', status: 'INDETERMINATE' };
  }
  if (variants.some((variant) => variant.effectiveValues.length > 0)) {
    return { reason: 'Untyped Variant value authority is unavailable', status: 'INDETERMINATE' };
  }
  const rules = evaluateProductTypeRules({
    productRef: source.productRef,
    productValues,
    variants: variants.map((variant) => ({
      effectiveValues: untypedVariantValues(variant, source.productRef.tenantId),
      productRef: source.productRef,
      variantRef: variant.variantRef,
    })),
  });
  if (rules.basisStatus !== 'UNTYPED') {
    return { reason: 'Untyped Product snapshot is malformed', status: 'INDETERMINATE' };
  }
  const revision = snapshot.confirmedUntypedDecisionRevision;
  if (revision === undefined) {
    return { rules, status: 'UNTYPED_PARTIAL' };
  }
  if (!Number.isSafeInteger(revision) || revision < 1) {
    return { reason: 'Untyped decision revision is invalid', status: 'INDETERMINATE' };
  }
  if (productValues.length > 0 || variants.some((variant) => variant.currentAttributeDefinitionIds?.length !== 0)) {
    return { reason: 'Confirmed untyped Product has structured Current facts', status: 'INDETERMINATE' };
  }
  return { decisionRevision: revision, rules, status: 'CONFIRMED_UNTYPED_MINIMUM' };
};

/** #424 partial minimum only; no result here asserts overall #414 Catalog readiness. */
export const evaluateCurrentProductTypeReadiness = (
  snapshot: ProductTypeReadinessSnapshot,
): ProductTypeReadinessEvaluation => {
  const { productValues, productValueSource, source, variants } = snapshot;
  const problem = snapshotProblem(snapshot);
  if (problem !== null) {
    return { reason: problem, status: 'INDETERMINATE' };
  }
  if (productValueSource === undefined) {
    return { reason: 'Current Product value source is unavailable', status: 'INDETERMINATE' };
  }
  if (source.status === 'UNTYPED') {
    return evaluateUntypedReadiness(snapshot);
  }
  const { basis, rulesRevision } = source;
  if (!Number.isSafeInteger(source.assignmentRevision) || source.assignmentRevision < 1) {
    return { reason: 'Current Product Type assignment revision is invalid', status: 'INDETERMINATE' };
  }
  const valueRevisions: {
    attributeDefinitionId: string;
    productRevision?: number | undefined;
    variantId: string;
    variantRevision?: number | undefined;
  }[] = [];
  const variantValues = [];
  for (const variant of variants) {
    const values: ProductTypeCurrentValue[] = disallowedVariantValues(variant.currentAttributeDefinitionIds, source);
    const seen = new Set<string>();
    for (const value of variant.effectiveValues) {
      if (seen.has(value.attributeDefinitionId)) {
        return { reason: 'Duplicate effective Attribute Definition', status: 'INDETERMINATE' };
      }
      seen.add(value.attributeDefinitionId);
      const { result } = value;
      if (
        !rulesRevision.rules.some(
          (rule) => rule.level === 'VARIANT' && rule.attributeDefinitionRef.resourceId === value.attributeDefinitionId,
        )
      ) {
        return { reason: 'Effective Variant inventory contains a foreign rule', status: 'INDETERMINATE' };
      }
      if (result.status === 'INVALID_VALUE') {
        values.push({
          attributeDefinitionRef: {
            moduleId: catalogModuleId,
            resourceId: value.attributeDefinitionId,
            resourceType: definitionResourceType,
            tenantId: source.productRef.tenantId,
          },
          valid: false,
        });
        continue;
      }
      if (result.status !== 'CURRENT') {
        return { reason: `Effective value is ${result.status}`, status: 'INDETERMINATE' };
      }
      const sourceProblem = effectiveSourceProblem(result, source.productRef, variant.variantRef);
      if (sourceProblem !== null) {
        return { reason: sourceProblem, status: 'INDETERMINATE' };
      }
      valueRevisions.push({
        attributeDefinitionId: value.attributeDefinitionId,
        productRevision: result.productRevision,
        variantId: variant.variantRef.resourceId,
        variantRevision: result.variantRevision,
      });
      if (countsAsEffectiveValue(result.values, rulesRevision.rules, value.attributeDefinitionId)) {
        values.push({
          attributeDefinitionRef: {
            moduleId: catalogModuleId,
            resourceId: value.attributeDefinitionId,
            resourceType: definitionResourceType,
            tenantId: source.productRef.tenantId,
          },
          valid: true,
        });
      }
    }
    if (
      rulesRevision.rules.some((rule) => rule.level === 'VARIANT' && !seen.has(rule.attributeDefinitionRef.resourceId))
    ) {
      return { reason: 'Effective Variant rule coverage is incomplete', status: 'INDETERMINATE' };
    }
    variantValues.push({ effectiveValues: values, productRef: source.productRef, variantRef: variant.variantRef });
  }
  const rules = evaluateProductTypeRules(
    {
      currentProductTypeRef: basis.productTypeRef,
      productRef: source.productRef,
      productValues,
      variants: variantValues,
    },
    rulesRevision,
    basis,
  );
  if (rules.basisStatus !== 'CURRENT') {
    return { reason: `Product Type basis is ${rules.basisStatus}`, status: 'INDETERMINATE' };
  }
  return {
    assignmentRevision: source.assignmentRevision,
    productValueSourceRevisionTokens: productValueSource.revisionTokens,
    rules,
    rulesRevision: rulesRevision.revision,
    rulesRevisionId: rulesRevision.revisionId,
    status: rules.minimumSatisfied ? 'VERIFIED_TYPE_MINIMUM' : 'INVALID',
    valueRevisions,
  };
};
