import { Schema } from 'effect';

import { sameCatalogRevisionReference } from './catalog-revision-reference.ts';
import type {
  CatalogSelection,
  CatalogSelectionEvidence,
  CatalogSelectionMembership,
  CatalogSelectionRevision,
} from './catalog-selection-evidence.ts';
import { CatalogSelectionSchema } from './catalog-selection-evidence.ts';

type Basis = CatalogSelectionEvidence['basis'];

/** Only an owner Current read may construct these facts; a historical projection is not Current proof. */
export type CatalogSelectionCurrentFacts = {
  readonly assessedAt: CatalogSelectionEvidence['assessedAt'];
  readonly basis: Basis;
  readonly purpose: string;
  readonly selection: CatalogSelection;
  readonly source: 'CATALOG_OWNER_CURRENT_READ';
} & (
  | { readonly reason: string; readonly status: 'INDETERMINATE' | 'INVALID' }
  | {
      /** Includes Product Type, required values, axes, inherited values, units, and all indirect dependencies. */
      readonly dependentFactsComplete: boolean;
      readonly membership: CatalogSelectionMembership;
      readonly productLifecycle: 'ACTIVE' | 'DRAFT' | 'RETIRED';
      readonly status: 'OBSERVED';
      readonly validUntil?: Extract<CatalogSelectionEvidence, { status: 'VALID' }>['validUntil'];
      readonly variantLifecycle: 'ACTIVE' | 'WORK_IN_PROGRESS' | 'RETIRED';
    }
);

export interface CatalogSelectionAssessmentInput {
  readonly assessedAt: CatalogSelectionEvidence['assessedAt'];
  readonly current: CatalogSelectionCurrentFacts;
  readonly purpose: string;
  readonly selection: CatalogSelection;
}

const sameSelection = Schema.toEquivalence(CatalogSelectionSchema);
const sameRef = (left: CatalogSelectionRevision['resourceRef'], right: CatalogSelectionRevision['resourceRef']) =>
  left.moduleId === right.moduleId &&
  left.tenantId === right.tenantId &&
  left.resourceType === right.resourceType &&
  left.resourceId === right.resourceId;

const matchingBasis = (basis: Basis, role: Basis[number]['role'], selected: CatalogSelectionRevision): boolean =>
  basis.some(
    (fact) => fact.subject === undefined && fact.role === role && sameCatalogRevisionReference(fact.source, selected),
  );

const hasRoleForRef = (
  basis: Basis,
  role: Basis[number]['role'],
  ref: CatalogSelectionRevision['resourceRef'],
): boolean =>
  basis.some((fact) => fact.subject === undefined && fact.role === role && sameRef(fact.source.resourceRef, ref));

const hasExclusiveTypeProof = (basis: Basis, selection: CatalogSelection): boolean => {
  const typed = basis.filter((fact) => fact.subject === undefined && fact.role === 'PRODUCT_TYPE').length;
  const untyped = basis.filter(
    (fact) =>
      fact.subject === undefined &&
      fact.role === 'PRODUCT_TYPE_UNTYPED_DECISION' &&
      fact.provenance === 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' &&
      sameRef(fact.source.resourceRef, selection.productRef),
  ).length;
  return typed + untyped === 1;
};

const assessPinnedRevisions = (
  selection: CatalogSelection,
  basis: Basis,
): { readonly reason: string; readonly status: 'INVALID' | 'INDETERMINATE' } | undefined => {
  const pinned: readonly (readonly [Basis[number]['role'], CatalogSelectionRevision])[] = [
    ...(selection.packageOption === undefined
      ? []
      : [['PACKAGE_CONTENT', selection.packageOption.contentRevision] as const]),
    ...(selection.setComposition === undefined ? [] : [['SET_COMPOSITION', selection.setComposition] as const]),
    ...(selection.configuration === undefined
      ? []
      : [
          ['CONFIGURATION_DEFINITION', selection.configuration.definition] as const,
          ...selection.configuration.choices.flatMap((choice) => [
            ...(choice.attributeDefinition === undefined
              ? []
              : [['ATTRIBUTE_DEFINITION', choice.attributeDefinition] as const]),
            ...(choice.unit === undefined ? [] : [['UNIT', choice.unit] as const]),
          ]),
        ]),
  ];
  for (const [role, revision] of pinned) {
    if (matchingBasis(basis, role, revision)) {
      continue;
    }
    if (hasRoleForRef(basis, role, revision.resourceRef)) {
      return { reason: `Pinned ${role} revision is not Current; explicit reselection is required`, status: 'INVALID' };
    }
    return { reason: `Exact ${role} Current revision is unverified`, status: 'INDETERMINATE' };
  }
  return undefined;
};

const matchesObservation = (input: CatalogSelectionAssessmentInput): boolean =>
  input.current.source === 'CATALOG_OWNER_CURRENT_READ' &&
  input.current.assessedAt === input.assessedAt &&
  input.current.purpose === input.purpose &&
  sameSelection(input.current.selection, input.selection);

const matchesMembership = (
  membership: CatalogSelectionMembership,
  selection: CatalogSelection,
  basis: Basis,
  assessedAt: CatalogSelectionEvidence['assessedAt'],
): boolean =>
  membership.source === 'CATALOG_OWNER_CURRENT_READ' &&
  membership.observedAt === assessedAt &&
  sameRef(membership.productRef, selection.productRef) &&
  sameRef(membership.variant.resourceRef, selection.variantRef) &&
  matchingBasis(basis, 'VARIANT', membership.variant);

/** Pure decision over owner-supplied Current facts; never discovers, upgrades, or substitutes a selection. */
export const assessCatalogSelection = (input: CatalogSelectionAssessmentInput): CatalogSelectionEvidence => {
  const { assessedAt, current, purpose, selection } = input;
  const base = { assessedAt, basis: current.basis, purpose, selection };
  const indeterminate = (reason: string): CatalogSelectionEvidence => ({ ...base, reason, status: 'INDETERMINATE' });
  const invalid = (reason: string): CatalogSelectionEvidence => ({ ...base, reason, status: 'INVALID' });

  if (!matchesObservation(input)) {
    return indeterminate('Current read does not attest this exact selection, purpose, and assessment time');
  }
  if (current.status !== 'OBSERVED') {
    return current.status === 'INVALID' ? invalid(current.reason) : indeterminate(current.reason);
  }

  const { basis, membership } = current;
  if (!matchesMembership(membership, selection, basis, assessedAt)) {
    return indeterminate('Exact Product–Variant membership is not owner-attested at this assessment time');
  }
  if (!hasRoleForRef(basis, 'PRODUCT', selection.productRef)) {
    return indeterminate('Current Product revision is missing');
  }
  if (!hasExclusiveTypeProof(basis, selection) || !current.dependentFactsComplete) {
    return indeterminate('Required direct or indirect Catalog facts are not completely attested');
  }
  if (basis.some((fact) => fact.source.resourceRef.tenantId !== selection.productRef.tenantId)) {
    return indeterminate('Catalog basis contains a different Tenant');
  }
  if (current.validUntil !== undefined && current.validUntil <= assessedAt) {
    return indeterminate('Current assessment validity has expired');
  }
  if (current.productLifecycle !== 'ACTIVE' || current.variantLifecycle !== 'ACTIVE') {
    return invalid('Product or Variant is not active for a new selection');
  }

  const pinnedDecision = assessPinnedRevisions(selection, basis);
  if (pinnedDecision !== undefined) {
    return pinnedDecision.status === 'INVALID' ? invalid(pinnedDecision.reason) : indeterminate(pinnedDecision.reason);
  }
  if (current.validUntil !== undefined) {
    return { ...base, membership, status: 'VALID', validUntil: current.validUntil };
  }
  return { ...base, membership, status: 'VALID' };
};
