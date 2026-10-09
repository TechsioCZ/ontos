import type { CatalogResourceRef } from './catalog-revision-reference.ts';
import type { CatalogSelectionRevision } from './catalog-selection-evidence.ts';
import type { VariantExactForm } from './variant-exact-form.ts';

/** Option is a selectable role on the same Package Definition Resource, never another register. */
export interface PackageOptionRole {
  readonly currentContent: CatalogSelectionRevision;
  readonly definitionRef: CatalogResourceRef;
  readonly form: VariantExactForm;
  readonly independentlyRequested: boolean;
  readonly lifecycle: 'ACTIVE' | 'RETIRED';
  readonly substitutionWithLooseQuantitySatisfiesRequest: boolean;
}

export type PackageOptionDecision =
  | {
      readonly contentRevision: CatalogSelectionRevision;
      readonly optionRef: CatalogResourceRef;
      readonly status: 'SELECTABLE';
    }
  | { readonly reason: string; readonly status: 'QUANTITY_ONLY' | 'INVALID' | 'UNVERIFIABLE' };

/** Price, codes, label, and sales multiple intentionally cannot establish an Option. */
export const assessPackageOption = (
  role: PackageOptionRole,
  productLifecycle: 'ACTIVE' | 'DRAFT' | 'RETIRED',
  variantLifecycle: 'ACTIVE' | 'WORK_IN_PROGRESS' | 'RETIRED',
): PackageOptionDecision => {
  if (
    role.definitionRef.moduleId !== 'commerce.catalog' ||
    role.definitionRef.resourceType !== 'commerce.catalog.package-definition' ||
    role.currentContent.resourceRef.moduleId !== role.definitionRef.moduleId ||
    role.currentContent.resourceRef.resourceType !== role.definitionRef.resourceType ||
    role.currentContent.resourceRef.resourceId !== role.definitionRef.resourceId ||
    role.currentContent.resourceRef.tenantId !== role.definitionRef.tenantId ||
    role.form.productRef.moduleId !== role.definitionRef.moduleId ||
    role.form.productRef.resourceType !== 'commerce.catalog.product' ||
    role.form.variantRef.moduleId !== role.definitionRef.moduleId ||
    role.form.variantRef.resourceType !== 'commerce.catalog.variant' ||
    role.form.productRef.tenantId !== role.definitionRef.tenantId ||
    role.form.variantRef.tenantId !== role.definitionRef.tenantId
  ) {
    return { reason: 'Option role must use its one Package Definition and Variant Tenant', status: 'INVALID' };
  }
  if (productLifecycle !== 'ACTIVE' || variantLifecycle !== 'ACTIVE' || role.lifecycle !== 'ACTIVE') {
    return { reason: 'Retired or inactive target cannot be newly selected', status: 'UNVERIFIABLE' };
  }
  if (!role.independentlyRequested || role.substitutionWithLooseQuantitySatisfiesRequest) {
    return { reason: 'Loose Variant quantity satisfies the same legitimate request', status: 'QUANTITY_ONLY' };
  }
  return { contentRevision: role.currentContent, optionRef: role.definitionRef, status: 'SELECTABLE' };
};
