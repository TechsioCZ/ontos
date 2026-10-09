import { sameCatalogRevisionReference } from './catalog-revision-reference.ts';
import type { CatalogResourceRef } from './catalog-revision-reference.ts';
import type { CatalogSelectionRevision } from './catalog-selection-evidence.ts';
import type { VariantExactForm } from './variant-exact-form.ts';

/** A revision is immutable after issue; storage must reject mutation of an issued key. */
export interface PackageContentRevision {
  /** Exact quantity of the Variant in one package, expressed in unitRef. */
  readonly amount: string;
  /** Complete configuration identity is pinned by its canonical immutable selection value. */
  readonly configurationKey?: string;
  readonly form: VariantExactForm;
  /** Optional exact lower-level revision; count is packages, not loose Variant units. */
  readonly lower?: { readonly count: string; readonly revision: CatalogSelectionRevision };
  readonly reference: CatalogSelectionRevision;
  /** Required for packaged Set Variants, and identical across homogeneous content. */
  readonly setComposition?: CatalogSelectionRevision;
  readonly unitRef: CatalogResourceRef;
}

export type PackageResolution =
  | {
      readonly amount: string;
      readonly path: readonly CatalogSelectionRevision[];
      readonly status: 'VALID';
      readonly unitRef: CatalogResourceRef;
    }
  | { readonly reason: string; readonly status: 'INVALID' | 'UNVERIFIABLE' };

const decimal = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const positive = (value: string): { coefficient: bigint; scale: number } | null => {
  if (!decimal.test(value)) {
    return null;
  }
  const [whole = '', fraction = ''] = value.split('.');
  const coefficient = BigInt(`${whole}${fraction}`);
  return coefficient > 0n ? { coefficient, scale: fraction.length } : null;
};
const format = (coefficient: bigint, scale: number): string => {
  if (scale === 0) {
    return coefficient.toString();
  }
  const padded = coefficient.toString().padStart(scale + 1, '0');
  const fraction = padded.slice(-scale).replace(/0+$/u, '');
  return fraction.length === 0 ? padded.slice(0, -scale) : `${padded.slice(0, -scale)}.${fraction}`;
};
const sameRef = (a: CatalogResourceRef, b: CatalogResourceRef): boolean =>
  a.moduleId === b.moduleId &&
  a.resourceType === b.resourceType &&
  a.resourceId === b.resourceId &&
  a.tenantId === b.tenantId;
const sameForm = (a: VariantExactForm, b: VariantExactForm): boolean =>
  a.productRef.resourceId === b.productRef.resourceId &&
  a.variantRef.resourceId === b.variantRef.resourceId &&
  a.productRef.tenantId === b.productRef.tenantId &&
  a.variantRef.tenantId === b.variantRef.tenantId;
const key = (revision: CatalogSelectionRevision): string =>
  `${revision.resourceRef.tenantId}/${revision.resourceRef.resourceId}/${revision.revision}/${revision.revisionId ?? ''}`;

const sameContentSubject = (upper: PackageContentRevision, lower: PackageContentRevision): boolean =>
  sameForm(upper.form, lower.form) &&
  sameRef(upper.unitRef, lower.unitRef) &&
  upper.configurationKey === lower.configurationKey &&
  ((upper.setComposition === undefined && lower.setComposition === undefined) ||
    (upper.setComposition !== undefined &&
      lower.setComposition !== undefined &&
      sameCatalogRevisionReference(upper.setComposition, lower.setComposition)));

const matchingRevisions = (revisions: readonly PackageContentRevision[], reference: CatalogSelectionRevision) =>
  revisions.filter((item) => sameCatalogRevisionReference(item.reference, reference));

const validScope = (item: PackageContentRevision): boolean => {
  const { tenantId } = item.reference.resourceRef;
  return (
    item.form.productRef.tenantId === tenantId &&
    item.form.variantRef.tenantId === tenantId &&
    item.unitRef.tenantId === tenantId
  );
};

/** Exact, pinned conversion. Missing lower revisions and inconsistent facts fail closed. */
export const resolvePackageContent = (
  selected: CatalogSelectionRevision,
  revisions: readonly PackageContentRevision[],
  packageCount: string,
): PackageResolution => {
  const count = positive(packageCount);
  if (count === null || count.scale !== 0) {
    return { reason: 'Package count must be a positive whole number', status: 'INVALID' };
  }
  const visited = new Set<string>();
  const path: CatalogSelectionRevision[] = [];
  let current = selected;
  let expected: PackageContentRevision | undefined;
  let multiplier = count.coefficient;
  const multiplierScale = 0;
  while (true) {
    if (current.resourceRef.resourceType !== 'commerce.catalog.package-definition') {
      return { reason: 'Package revision must identify a Package Definition', status: 'INVALID' };
    }
    const revisionKey = key(current);
    if (visited.has(revisionKey)) {
      return { reason: 'Package content cycle', status: 'INVALID' };
    }
    visited.add(revisionKey);
    const found = matchingRevisions(revisions, current);
    if (found.length !== 1) {
      return { reason: 'Exact Package Content Revision is missing or ambiguous', status: 'UNVERIFIABLE' };
    }
    const [item] = found;
    if (item === undefined) {
      return { reason: 'Exact Package Content Revision is missing', status: 'UNVERIFIABLE' };
    }
    const amount = positive(item.amount);
    if (amount === null) {
      return { reason: 'Package content must be positive and exact', status: 'INVALID' };
    }
    if (!validScope(item)) {
      return { reason: 'Package content crosses Tenant boundary', status: 'INVALID' };
    }
    if (expected !== undefined && !sameContentSubject(expected, item)) {
      return {
        reason: 'Lower package has different Variant, configuration, Set composition, or Unit',
        status: 'INVALID',
      };
    }
    path.push(item.reference);
    if (item.lower === undefined) {
      return {
        amount: format(multiplier * amount.coefficient, multiplierScale + amount.scale),
        path,
        status: 'VALID',
        unitRef: item.unitRef,
      };
    }
    const lowerCount = positive(item.lower.count);
    if (lowerCount === null || lowerCount.scale !== 0) {
      return { reason: 'Lower package count must be a positive whole number', status: 'INVALID' };
    }
    const [lower] = matchingRevisions(revisions, item.lower.revision);
    if (lower === undefined) {
      return { reason: 'Exact lower Package Content Revision is missing', status: 'UNVERIFIABLE' };
    }
    const lowerAmount = positive(lower.amount);
    if (
      lowerAmount === null ||
      amount.coefficient * 10n ** BigInt(lowerAmount.scale) !==
        lowerCount.coefficient * lowerAmount.coefficient * 10n ** BigInt(amount.scale)
    ) {
      return { reason: 'Higher package content disagrees with exact lower revision', status: 'INVALID' };
    }
    multiplier *= lowerCount.coefficient;
    expected = item;
    current = item.lower.revision;
  }
};
