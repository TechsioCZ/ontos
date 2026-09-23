/** Catalog-owned Brand facts. Persistence and owner-issued ResourceRefs are separate contracts. */
export interface BrandIdentity {
  readonly resourceId: string;
  readonly tenantId: string;
}

interface BrandNameRecord {
  readonly name: string;
  readonly reason: string;
}

export interface BrandFact {
  readonly brandRef: BrandIdentity;
  readonly lifecycle: 'ACTIVE' | 'RETIRED';
  readonly names: readonly BrandNameRecord[];
}

/** Unknown is not evidence that the Product is unbranded. */
export type ProductBrandClaim =
  | { readonly kind: 'UNKNOWN' }
  | { readonly evidenceRef: string; readonly kind: 'CONFIRMED_UNBRANDED' }
  | { readonly brandRef: BrandIdentity; readonly evidenceRef: string; readonly kind: 'BRANDED' };

export interface ProductBrandRecord {
  readonly claim: ProductBrandClaim;
  readonly productRef: BrandIdentity;
  readonly reason: string;
}

export type BrandChangeResult =
  | { readonly brand: BrandFact; readonly status: 'CHANGED' | 'UNCHANGED' }
  | { readonly status: 'EVIDENCE_REQUIRED' | 'INVALID_NAME' | 'INVALID_STATE' };

const hasEvidence = (value: string): boolean => value.trim().length > 0;

/** A rename preserves Brand identity and prior names, including equal names on unrelated Brands. */
export const renameBrand = (brand: BrandFact, name: string, reason: string): BrandChangeResult => {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { status: 'INVALID_NAME' };
  }
  if (!hasEvidence(reason)) {
    return { status: 'EVIDENCE_REQUIRED' };
  }
  if (brand.names.at(-1)?.name === trimmed) {
    return { brand, status: 'UNCHANGED' };
  }
  return {
    brand: { ...brand, names: [...brand.names, { name: trimmed, reason: reason.trim() }] },
    status: 'CHANGED',
  };
};

/** Retirement and confirmed reactivation keep the same identity and historical links. */
export const transitionBrand = (
  brand: BrandFact,
  lifecycle: BrandFact['lifecycle'],
  reason: string,
): BrandChangeResult => {
  if (!hasEvidence(reason)) {
    return { status: 'EVIDENCE_REQUIRED' };
  }
  if (brand.lifecycle === lifecycle) {
    return { brand, status: 'UNCHANGED' };
  }
  return { brand: { ...brand, lifecycle }, status: 'CHANGED' };
};

export type BrandAssignmentResult =
  | { readonly history: readonly ProductBrandRecord[]; readonly status: 'CHANGED' | 'UNCHANGED' }
  | { readonly status: 'EVIDENCE_REQUIRED' | 'TENANT_MISMATCH' | 'BRAND_NOT_ASSIGNABLE' };

/** Records a Product-level claim; Variants inherit it and never carry an independent override. */
export const recordProductBrand = (
  history: readonly ProductBrandRecord[],
  productRef: BrandIdentity,
  claim: ProductBrandClaim,
  brand: BrandFact | undefined,
  reason: string,
): BrandAssignmentResult => {
  if (!hasEvidence(reason) || (claim.kind !== 'UNKNOWN' && !hasEvidence(claim.evidenceRef))) {
    return { status: 'EVIDENCE_REQUIRED' };
  }
  if (claim.kind === 'BRANDED') {
    if (claim.brandRef.tenantId !== productRef.tenantId || brand?.brandRef.tenantId !== productRef.tenantId) {
      return { status: 'TENANT_MISMATCH' };
    }
    if (brand.brandRef.resourceId !== claim.brandRef.resourceId || brand.lifecycle !== 'ACTIVE') {
      return { status: 'BRAND_NOT_ASSIGNABLE' };
    }
  }
  const previous = history.at(-1)?.claim;
  if (
    previous?.kind === claim.kind &&
    (claim.kind !== 'BRANDED' ||
      (previous.kind === 'BRANDED' && previous.brandRef.resourceId === claim.brandRef.resourceId))
  ) {
    return { history, status: 'UNCHANGED' };
  }
  return { history: [...history, { claim, productRef, reason: reason.trim() }], status: 'CHANGED' };
};
