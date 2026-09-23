import { Schema } from 'effect';

import type { ProductRef } from '../resources/product.ts';
import type { VariantRef } from '../resources/variant.ts';
import type { AttributeDefinition, AttributeValue, UnitConversion } from './attribute-values.ts';
import { AttributeDefinitionSchema, validateAttributeValues } from './attribute-values.ts';
import type { ProductTypeCurrentBasis, ProductTypeCurrentRulesRevision } from './product-type-rules.ts';
import {
  ProductTypeCurrentBasisSchema,
  ProductTypeCurrentRulesRevisionSchema,
  ProductTypeRulesRevisionSchema,
} from './product-type-rules.ts';

/** SET always contains an explicit nonempty answer; REMOVED is a tombstone, not a special value. */
export interface AttributeValueSetSnapshot {
  readonly revision: number;
  readonly state: 'SET' | 'REMOVED';
  readonly values: readonly AttributeValue[];
}

export interface AttributeValueSource {
  readonly level: 'PRODUCT' | 'VARIANT';
  readonly productRef: ProductRef;
  readonly revision: number;
  readonly variantRef?: VariantRef;
}

export type EffectiveAttributeValuesResult =
  | {
      readonly productRevision?: number | undefined;
      readonly source?: AttributeValueSource;
      readonly status: 'CURRENT';
      readonly values: readonly AttributeValue[];
      readonly variantRevision?: number | undefined;
    }
  | { readonly reasons: readonly string[]; readonly status: 'INVALID_AUTHORITY' | 'INVALID_VALUE' | 'STALE_BASIS' };

const sameRef = (
  left: { readonly resourceId: string; readonly tenantId: string },
  right: { readonly resourceId: string; readonly tenantId: string },
): boolean => left.tenantId === right.tenantId && left.resourceId === right.resourceId;

const validSet = (set: AttributeValueSetSnapshot | null): boolean =>
  set === null ||
  (Number.isInteger(set.revision) &&
    set.revision > 0 &&
    Array.isArray(set.values) &&
    (set.state === 'SET' ? set.values.length > 0 : set.state === 'REMOVED' && set.values.length === 0));

const validSnapshots = (
  productSet: AttributeValueSetSnapshot | null,
  variantSet: AttributeValueSetSnapshot | null,
  inheritable: boolean,
): boolean => validSet(productSet) && validSet(variantSet) && (productSet?.state !== 'SET' || inheritable);

const hasRule = (
  rulesRevision: ProductTypeCurrentRulesRevision,
  definition: AttributeDefinition,
  level: 'PRODUCT' | 'VARIANT',
): boolean =>
  rulesRevision.rules.some(
    (rule) =>
      rule.level === level &&
      rule.attributeDefinitionRef.tenantId === definition.ref.tenantId &&
      rule.attributeDefinitionRef.resourceId === definition.ref.resourceId,
  );

const staleRemoval = (
  removalBasis: { readonly productRevision?: number; readonly variantRevision: number } | undefined,
  productSet: AttributeValueSetSnapshot | null,
  variantSet: AttributeValueSetSnapshot | null,
): boolean =>
  removalBasis !== undefined &&
  (variantSet?.state !== 'REMOVED' ||
    removalBasis.variantRevision !== variantSet.revision ||
    removalBasis.productRevision !== (productSet?.revision ?? undefined));

const currentAuthority = (input: {
  readonly basis?: ProductTypeCurrentBasis;
  readonly definition: AttributeDefinition;
  readonly productRef: ProductRef;
  readonly rulesRevision?: ProductTypeCurrentRulesRevision;
  readonly variantProductRef: ProductRef;
  readonly variantRef: VariantRef;
}): boolean => {
  const { basis, definition, productRef, rulesRevision, variantRef } = input;
  return (
    basis !== undefined &&
    rulesRevision !== undefined &&
    Schema.is(ProductTypeCurrentBasisSchema)(basis) &&
    Schema.is(ProductTypeCurrentRulesRevisionSchema)(rulesRevision) &&
    Schema.is(ProductTypeRulesRevisionSchema)(rulesRevision) &&
    Schema.is(AttributeDefinitionSchema)(definition) &&
    sameRef(productRef, input.variantProductRef) &&
    productRef.tenantId === variantRef.tenantId &&
    definition.ref.tenantId === productRef.tenantId &&
    basis.productTypeRef.tenantId === productRef.tenantId &&
    sameRef(basis.productTypeRef, rulesRevision.productTypeRef) &&
    basis.revision === rulesRevision.revision &&
    basis.currentRevision === rulesRevision.revision &&
    basis.revisionId === rulesRevision.revisionId &&
    basis.effectiveFrom === rulesRevision.effectiveFrom &&
    basis.evaluatedAt >= basis.effectiveFrom &&
    (basis.effectiveUntil === undefined || basis.evaluatedAt < basis.effectiveUntil) &&
    definition.levels.includes('VARIANT') &&
    hasRule(rulesRevision, definition, 'VARIANT')
  );
};

/**
 * Resolve one definition on one Variant from a single owner-supplied Current snapshot.
 * The caller must load and lock the relevant revisions and enforce the Action/Permission boundary.
 */
export const resolveEffectiveAttributeValues = (input: {
  readonly basis?: ProductTypeCurrentBasis;
  readonly conversions?: readonly UnitConversion[];
  readonly definition: AttributeDefinition;
  readonly productRef: ProductRef;
  /** null means the owner verified that no set exists. */
  readonly productSet: AttributeValueSetSnapshot | null;
  /** The revisions displayed when a removal was requested; mismatch rejects stale fallback. */
  readonly removalBasis?: { readonly productRevision?: number; readonly variantRevision: number };
  readonly rulesRevision?: ProductTypeCurrentRulesRevision;
  /** Owner-verified parent identity of this recorded Variant. */
  readonly variantProductRef: ProductRef;
  readonly variantRef: VariantRef;
  readonly variantSet: AttributeValueSetSnapshot | null;
}): EffectiveAttributeValuesResult => {
  const { definition, productRef, productSet, rulesRevision, variantRef, variantSet } = input;
  if (!currentAuthority(input) || rulesRevision === undefined) {
    return { reasons: ['Missing or inconsistent Current Variant applicability'], status: 'INVALID_AUTHORITY' };
  }

  const inheritable = definition.levels.includes('PRODUCT') && hasRule(rulesRevision, definition, 'PRODUCT');
  if (!validSnapshots(productSet, variantSet, inheritable)) {
    return { reasons: ['Invalid value-set state or disallowed Product value'], status: 'INVALID_AUTHORITY' };
  }
  if (staleRemoval(input.removalBasis, productSet, variantSet)) {
    return { reasons: ['Value source changed before override removal'], status: 'STALE_BASIS' };
  }
  let selected: AttributeValueSetSnapshot | undefined;
  if (variantSet?.state === 'SET') {
    selected = variantSet;
  } else if (inheritable && productSet?.state === 'SET') {
    selected = productSet;
  }
  if (selected === undefined) {
    return {
      productRevision: productSet?.revision,
      status: 'CURRENT',
      values: [],
      variantRevision: variantSet?.revision,
    };
  }
  const checked = validateAttributeValues(definition, selected.values, input.conversions);
  if (!checked.valid) {
    return { reasons: checked.reasons, status: 'INVALID_VALUE' };
  }
  const source: AttributeValueSource =
    selected === variantSet
      ? { level: 'VARIANT', productRef, revision: selected.revision, variantRef }
      : { level: 'PRODUCT', productRef, revision: selected.revision };
  return {
    productRevision: productSet?.revision,
    source,
    status: 'CURRENT',
    values: checked.normalized,
    variantRevision: variantSet?.revision,
  };
};
