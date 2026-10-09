import { Schema } from 'effect';

import type { CatalogResourceRef, CatalogRevisionInstant } from './catalog-revision-reference.ts';
import type { CatalogSelection } from './catalog-selection-evidence.ts';
import { CatalogSelectionSchema } from './catalog-selection-evidence.ts';
import type { SetComponent, SetCompositionRevision } from './set-composition.ts';

/** Owner-issued Current facts for one exact component, including indirect selection dependencies. */
export interface SetComponentCurrentProof {
  readonly assessedAt: CatalogRevisionInstant;
  readonly attestationId: string;
  readonly componentId: string;
  readonly divisible: boolean;
  readonly packageLifecycle?: 'ACTIVE' | 'DRAFT' | 'RETIRED';
  /** The Product actually owning the selected Package Option, when present. */
  readonly packageProductRef?: CatalogResourceRef;
  /** A Set Product is forbidden, including one reached through a Package Option. */
  readonly productKind: 'ATOMIC' | 'SET';
  readonly productLifecycle: 'ACTIVE' | 'DRAFT' | 'RETIRED';
  readonly quantityStep: string;
  readonly quantityUnitRef: CatalogResourceRef;
  readonly reason?: string;
  readonly selection: CatalogSelection;
  readonly source: 'CATALOG_OWNER_CURRENT_READ';
  readonly status: 'VALID' | 'INVALID' | 'INDETERMINATE';
  readonly variantLifecycle: 'ACTIVE' | 'WORK_IN_PROGRESS' | 'RETIRED';
  /** The Product actually owning the selected Variant. */
  readonly variantProductRef: CatalogResourceRef;
}

export type SetComponentValidation =
  | { readonly assessedAt: CatalogRevisionInstant; readonly componentIds: readonly string[]; readonly status: 'VALID' }
  | { readonly code: string; readonly componentId?: string; readonly status: 'INVALID' | 'INDETERMINATE' };

const sameRef = (left: CatalogResourceRef, right: CatalogResourceRef): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceType === right.resourceType &&
  left.resourceId === right.resourceId &&
  left.tenantId === right.tenantId;

const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const positive = (value: string): { readonly coefficient: bigint; readonly scale: number } | null => {
  if (!decimalPattern.test(value)) {
    return null;
  }
  const [whole = '', fraction = ''] = value.split('.');
  const coefficient = BigInt(`${whole}${fraction}`);
  return coefficient > 0n ? { coefficient, scale: fraction.length } : null;
};

const validQuantity = (component: SetComponent, proof: SetComponentCurrentProof): boolean => {
  const amount = positive(component.quantity.amount);
  const step = positive(proof.quantityStep);
  if (amount === null || step === null || !sameRef(component.quantity.unitRef, proof.quantityUnitRef)) {
    return false;
  }
  const scale = Math.max(amount.scale, step.scale);
  const quantity = amount.coefficient * 10n ** BigInt(scale - amount.scale);
  const increment = step.coefficient * 10n ** BigInt(scale - step.scale);
  return quantity % increment === 0n && (proof.divisible || quantity % 10n ** BigInt(scale) === 0n);
};

const checkCurrentProof = (
  component: SetComponent,
  proof: SetComponentCurrentProof,
): SetComponentValidation | SetComponentCurrentProof => {
  const { componentId, selection } = component;
  if (!Schema.toEquivalence(CatalogSelectionSchema)(selection, proof.selection)) {
    return { code: 'CURRENT_SELECTION_PROOF_MISMATCH', componentId, status: 'INDETERMINATE' };
  }
  if (proof.status === 'INDETERMINATE') {
    return { code: 'CURRENT_COMPONENT_UNVERIFIABLE', componentId, status: 'INDETERMINATE' };
  }
  if (proof.status === 'INVALID') {
    return { code: 'CURRENT_COMPONENT_INVALID', componentId, status: 'INVALID' };
  }
  if (proof.productKind === 'SET') {
    return { code: 'NESTED_SET', componentId, status: 'INVALID' };
  }
  if (!sameRef(selection.productRef, proof.variantProductRef)) {
    return { code: 'VARIANT_PRODUCT_MISMATCH', componentId, status: 'INVALID' };
  }
  if (
    selection.packageOption !== undefined &&
    (proof.packageProductRef === undefined || !sameRef(selection.productRef, proof.packageProductRef))
  ) {
    return { code: 'PACKAGE_PRODUCT_MISMATCH', componentId, status: 'INVALID' };
  }
  if (
    proof.productLifecycle !== 'ACTIVE' ||
    proof.variantLifecycle !== 'ACTIVE' ||
    (selection.packageOption !== undefined && proof.packageLifecycle !== 'ACTIVE')
  ) {
    return { code: 'COMPONENT_RETIRED_OR_INACTIVE', componentId, status: 'INVALID' };
  }
  if (!validQuantity(component, proof)) {
    return { code: 'COMPONENT_QUANTITY_RULE_VIOLATION', componentId, status: 'INVALID' };
  }
  return proof;
};

const checkComponent = (
  component: SetComponent,
  revision: SetCompositionRevision,
  proofs: readonly SetComponentCurrentProof[],
): SetComponentValidation | SetComponentCurrentProof => {
  const { componentId, selection } = component;
  if (
    selection.productRef.tenantId !== revision.productRef.tenantId ||
    component.quantity.unitRef.tenantId !== revision.productRef.tenantId
  ) {
    return { code: 'COMPONENT_TENANT_MISMATCH', componentId, status: 'INVALID' };
  }
  if (selection.setComposition !== undefined || sameRef(selection.productRef, revision.productRef)) {
    return { code: 'NESTED_SET', componentId, status: 'INVALID' };
  }
  if (positive(component.quantity.amount) === null) {
    return { code: 'INVALID_COMPONENT_QUANTITY', componentId, status: 'INVALID' };
  }
  const matching = proofs.filter((proof) => proof.componentId === componentId);
  if (matching.length !== 1) {
    return { code: 'CURRENT_COMPONENT_PROOF_MISSING', componentId, status: 'INDETERMINATE' };
  }
  const [proof] = matching;
  if (proof === undefined || proof.source !== 'CATALOG_OWNER_CURRENT_READ' || proof.attestationId.trim() === '') {
    return { code: 'CURRENT_COMPONENT_PROOF_MISSING', componentId, status: 'INDETERMINATE' };
  }
  return checkCurrentProof(component, proof);
};

/** Pure Current assessment. A previous snapshot, missing proof, or unknown dependency cannot establish validity. */
export const validateSetComponents = (
  revision: SetCompositionRevision,
  proofs: readonly SetComponentCurrentProof[],
): SetComponentValidation => {
  const { tenantId } = revision.productRef;
  if (revision.variantRef.tenantId !== tenantId || revision.reference.resourceRef.tenantId !== tenantId) {
    return { code: 'SET_TENANT_MISMATCH', status: 'INVALID' };
  }
  if (revision.components.length < 2) {
    return { code: 'SET_COMPONENTS_REQUIRED', status: 'INVALID' };
  }
  const seen = new Set<string>();
  let assessedAt: CatalogRevisionInstant | undefined;
  for (const component of revision.components) {
    const { componentId } = component;
    if (seen.has(componentId)) {
      return { code: 'DUPLICATE_COMPONENT_NEED', componentId, status: 'INVALID' };
    }
    seen.add(componentId);
    const outcome = checkComponent(component, revision, proofs);
    if ('code' in outcome) {
      return outcome;
    }
    const { assessedAt: proofAssessedAt } = outcome;
    assessedAt ??= proofAssessedAt;
    if (assessedAt !== proofAssessedAt) {
      return { code: 'CURRENT_PROOF_TIME_MISMATCH', componentId, status: 'INDETERMINATE' };
    }
  }
  return assessedAt === undefined
    ? { code: 'CURRENT_COMPONENT_PROOF_MISSING', status: 'INDETERMINATE' }
    : { assessedAt, componentIds: [...seen], status: 'VALID' };
};
