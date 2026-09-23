/** Pure, owner-private assessment of a proposed Product Type rule change. */
export interface ProductTypeImpactRule {
  readonly attributeDefinitionId: string;
  readonly level: 'PRODUCT' | 'VARIANT';
  readonly required: boolean;
}

interface ProductTypeImpactValue {
  readonly attributeDefinitionId: string;
  /** Value validity is established by #402, not inferred from presence. */
  readonly valid: boolean;
}

interface ProductTypeImpactVariant {
  readonly values: readonly ProductTypeImpactValue[];
  readonly variantId: string;
}

export interface ProductTypeImpactProduct {
  readonly productId: string;
  readonly values: readonly ProductTypeImpactValue[];
  readonly variantAxes: readonly string[];
  readonly variants: readonly ProductTypeImpactVariant[];
}

interface ProductTypeImpactSubject {
  readonly affectedVariantAxes: readonly string[];
  readonly catalogReadyForAffectedUse: boolean;
  readonly disallowedCurrentValues: readonly string[];
  readonly invalidCurrentValues: readonly string[];
  readonly missingRequired: readonly string[];
  readonly productId: string;
  readonly variantId?: string;
}

export interface ProductTypeImpactPreview {
  readonly affectedProductIds: readonly string[];
  readonly requiresExplicitRemediation: boolean;
  readonly subjects: readonly ProductTypeImpactSubject[];
}

const uniqueSorted = (values: readonly string[]): string[] => [...new Set(values)].toSorted();

const inspectValues = (
  values: readonly ProductTypeImpactValue[],
  level: ProductTypeImpactRule['level'],
  allowed: ReadonlySet<string>,
) => {
  const valid = new Set<string>();
  const invalid: string[] = [];
  const disallowed: string[] = [];
  for (const value of values) {
    if (value.valid) {
      valid.add(value.attributeDefinitionId);
    } else {
      invalid.push(value.attributeDefinitionId);
    }
    if (!allowed.has(`${level}:${value.attributeDefinitionId}`)) {
      disallowed.push(value.attributeDefinitionId);
    }
  }
  return { disallowed: uniqueSorted(disallowed), invalid: uniqueSorted(invalid), valid };
};

/**
 * `nextRules === null` means type removal, not permission for free-form values.
 * The caller must supply the complete, unchanged population and Current values;
 * this function grants neither permission nor authority to apply its preview.
 */
export const previewProductTypeImpact = (
  products: readonly ProductTypeImpactProduct[],
  nextRules: readonly ProductTypeImpactRule[] | null,
): ProductTypeImpactPreview => {
  const rules = nextRules ?? [];
  const allowed = new Set(rules.map((rule) => `${rule.level}:${rule.attributeDefinitionId}`));
  const requiredProduct: string[] = [];
  const requiredVariant: string[] = [];
  for (const rule of rules) {
    if (!rule.required) {
      continue;
    }
    (rule.level === 'PRODUCT' ? requiredProduct : requiredVariant).push(rule.attributeDefinitionId);
  }
  const subjects: ProductTypeImpactSubject[] = [];

  for (const product of products) {
    const productValues = inspectValues(product.values, 'PRODUCT', allowed);
    const productMissing = uniqueSorted(requiredProduct.filter((id) => !productValues.valid.has(id)));
    const productInvalid = productValues.invalid;
    const productDisallowed = productValues.disallowed;
    const affectedVariantAxes = uniqueSorted(product.variantAxes.filter((id) => !allowed.has(`VARIANT:${id}`)));
    const productAffected =
      productMissing.length > 0 ||
      productDisallowed.length > 0 ||
      productInvalid.length > 0 ||
      affectedVariantAxes.length > 0;
    if (productAffected) {
      subjects.push({
        affectedVariantAxes,
        catalogReadyForAffectedUse: false,
        disallowedCurrentValues: productDisallowed,
        invalidCurrentValues: productInvalid,
        missingRequired: productMissing,
        productId: product.productId,
      });
    }

    for (const variant of product.variants) {
      const variantValues = inspectValues(variant.values, 'VARIANT', allowed);
      const missingRequired = requiredVariant.filter((id) => !variantValues.valid.has(id));
      const invalidCurrentValues = variantValues.invalid;
      const disallowedCurrentValues = variantValues.disallowed;
      if (
        productAffected ||
        missingRequired.length > 0 ||
        disallowedCurrentValues.length > 0 ||
        invalidCurrentValues.length > 0
      ) {
        subjects.push({
          affectedVariantAxes,
          catalogReadyForAffectedUse: false,
          disallowedCurrentValues,
          invalidCurrentValues,
          missingRequired,
          productId: product.productId,
          variantId: variant.variantId,
        });
      }
    }
  }

  return {
    affectedProductIds: uniqueSorted(subjects.map((subject) => subject.productId)),
    requiresExplicitRemediation: subjects.length > 0,
    subjects,
  };
};

export interface ProductTypeEffectiveRevision {
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly revisionId: string;
}

export type ProductTypeRevisionResolution =
  | { readonly status: 'NONE' }
  | { readonly revisionId: string; readonly status: 'CURRENT' }
  | { readonly revisionIds: readonly string[]; readonly status: 'AMBIGUOUS' };

/** Inclusive start, exclusive end; overlap fails closed instead of choosing the last write. */
export const resolveCurrentProductTypeRevision = (
  revisions: readonly ProductTypeEffectiveRevision[],
  at: string,
): ProductTypeRevisionResolution => {
  const current = revisions.filter(
    (revision) => revision.effectiveFrom <= at && (revision.effectiveTo === null || at < revision.effectiveTo),
  );
  if (current.length === 0) {
    return { status: 'NONE' };
  }
  const [first] = current;
  if (current.length === 1 && first !== undefined) {
    return { revisionId: first.revisionId, status: 'CURRENT' };
  }
  return { revisionIds: uniqueSorted(current.map((revision) => revision.revisionId)), status: 'AMBIGUOUS' };
};
