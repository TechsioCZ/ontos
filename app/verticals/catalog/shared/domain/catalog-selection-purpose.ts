import { Match, Schema } from 'effect';

import type {
  CatalogSelection,
  CatalogSelectionBasis,
  CatalogSelectionBasisRole,
  CatalogSelectionRevision,
} from './catalog-selection-evidence.ts';

/**
 * Closed purpose taxonomy. Every purpose decides which Catalog facts are the smallest complete
 * basis; an unlisted use cannot silently widen the evidence it receives.
 */
export const CatalogSelectionPurposeSchema = Schema.Literals([
  'PURCHASE_ACCEPTANCE',
  'CART_VALIDATION',
  'PRICING',
  'ASSORTMENT',
  'AVAILABILITY_ELIGIBILITY',
  'ORDER_HISTORY',
]);
export type CatalogSelectionPurpose = typeof CatalogSelectionPurposeSchema.Type;

interface RefIdentity {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}

const sameRef = (left: RefIdentity, right: RefIdentity): boolean =>
  left.moduleId === right.moduleId &&
  left.tenantId === right.tenantId &&
  left.resourceType === right.resourceType &&
  left.resourceId === right.resourceId;

const sameRevision = (left: CatalogSelectionRevision, right: CatalogSelectionRevision): boolean =>
  sameRef(left.resourceRef, right.resourceRef) &&
  left.revision === right.revision &&
  left.revisionId === right.revisionId;

/** A selected revision is pinned by the immutable Catalog Selection itself, not by a purpose. */
interface PinnedRequirement {
  readonly revision: CatalogSelectionRevision;
  readonly role: CatalogSelectionBasisRole;
}

const pinnedRequirements = (selection: CatalogSelection): readonly PinnedRequirement[] => [
  ...(selection.packageOption === undefined
    ? []
    : [{ revision: selection.packageOption.contentRevision, role: 'PACKAGE_CONTENT' as const }]),
  ...(selection.setComposition === undefined
    ? []
    : [{ revision: selection.setComposition, role: 'SET_COMPOSITION' as const }]),
  ...(selection.configuration === undefined
    ? []
    : [
        { revision: selection.configuration.definition, role: 'CONFIGURATION_DEFINITION' as const },
        ...selection.configuration.choices.flatMap((choice) => [
          ...(choice.attributeDefinition === undefined
            ? []
            : [{ revision: choice.attributeDefinition, role: 'ATTRIBUTE_DEFINITION' as const }]),
          ...(choice.unit === undefined ? [] : [{ revision: choice.unit, role: 'UNIT' as const }]),
        ]),
      ]),
];

/** Purpose-specific deciding facts beyond the selection identity and its pinned revisions. */
const purposeExtraRoles = (purpose: CatalogSelectionPurpose): readonly CatalogSelectionBasisRole[] =>
  Match.value(purpose).pipe(
    Match.whenOr('ASSORTMENT', 'PRICING', () => ['CATEGORY'] as const),
    Match.when(
      'PURCHASE_ACCEPTANCE',
      () => ['PRODUCT_TYPE', 'VARIANT_AXIS', 'UNIT_RULE', 'UNIT_TARGET_DIVISIBILITY'] as const,
    ),
    Match.orElse(() => []),
  );

/** Whether a purpose requires the exact Category (and ancestor) classification basis. */
export const catalogSelectionPurposeRequiresCategory = (purpose: string): boolean =>
  Schema.is(CatalogSelectionPurposeSchema)(purpose) && purposeExtraRoles(purpose).includes('CATEGORY');

/**
 * Every purpose always preserves Product/Variant identity and every pinned selected revision.
 * The remaining deciding roles are added by the purpose; Pricing and Assortment additionally
 * require Category (including ancestors, modelled as repeated `CATEGORY` facts).
 */
export const requiredCatalogSelectionRoles = (
  purpose: CatalogSelectionPurpose,
  selection: CatalogSelection,
): readonly CatalogSelectionBasisRole[] => [
  ...new Set<CatalogSelectionBasisRole>([
    'PRODUCT',
    'VARIANT',
    'PRODUCT_TYPE',
    ...pinnedRequirements(selection).map(({ role }) => role),
    ...purposeExtraRoles(purpose),
  ]),
];

export type CatalogSelectionBasisMinimalisation =
  | { readonly basis: readonly CatalogSelectionBasis[]; readonly status: 'COMPLETE' }
  | { readonly missingRoles: readonly CatalogSelectionBasisRole[]; readonly status: 'INCOMPLETE' };

const matchesPinned = (fact: CatalogSelectionBasis, requirement: PinnedRequirement): boolean =>
  fact.subject === undefined && fact.role === requirement.role && sameRevision(fact.source, requirement.revision);

const subjectBelongsToSelection = (fact: CatalogSelectionBasis, selection: CatalogSelection): boolean =>
  fact.subject !== undefined &&
  selection.setComposition !== undefined &&
  sameRevision(fact.subject.composition, selection.setComposition);

/**
 * Pure minimalisation of an owner basis. `COMPLETE` returns only deciding facts; `INCOMPLETE`
 * names the missing deciding roles and never estimates them. Product/Variant identity and every
 * pinned selected revision is always kept. Optional value facts are kept when present for a
 * validity purpose because they participated in the owner decision, but absence of inheritance
 * is valid and never creates a missing-role failure.
 */
export const selectSmallestCompleteCatalogSelectionBasis = (input: {
  readonly basis: readonly CatalogSelectionBasis[];
  readonly purpose: CatalogSelectionPurpose;
  readonly selection: CatalogSelection;
}): CatalogSelectionBasisMinimalisation => {
  const { basis, purpose, selection } = input;
  const pinned = pinnedRequirements(selection);
  const roleOnly = new Set<CatalogSelectionBasisRole>([
    'PRODUCT',
    'VARIANT',
    'PRODUCT_TYPE',
    ...purposeExtraRoles(purpose),
  ]);
  const optionalWhenPresent = new Set<CatalogSelectionBasisRole>([
    'UNIT_CONVERSION',
    ...(purpose === 'PURCHASE_ACCEPTANCE' || purpose === 'CART_VALIDATION'
      ? (['ATTRIBUTE_DEFINITION', 'INHERITED_VALUE', 'OTHER_CATALOG_FACT'] as const)
      : []),
  ]);
  const hasConfirmedUntypedProof = basis.some(
    (fact) =>
      fact.subject === undefined &&
      fact.role === 'PRODUCT_TYPE_UNTYPED_DECISION' &&
      sameRef(fact.source.resourceRef, selection.productRef),
  );
  const present = (role: CatalogSelectionBasisRole): boolean => {
    if (role === 'PRODUCT_TYPE') {
      return (
        basis.filter(
          (fact) =>
            fact.subject === undefined &&
            (fact.role === 'PRODUCT_TYPE' ||
              (fact.role === 'PRODUCT_TYPE_UNTYPED_DECISION' &&
                sameRef(fact.source.resourceRef, selection.productRef))),
        ).length === 1
      );
    }
    if (role === 'VARIANT_AXIS' && hasConfirmedUntypedProof) {
      return true;
    }
    return basis.some((fact) => fact.subject === undefined && fact.role === role);
  };

  const missing: CatalogSelectionBasisRole[] = [];
  if (
    !basis.some(
      (fact) =>
        fact.subject === undefined && fact.role === 'PRODUCT' && sameRef(fact.source.resourceRef, selection.productRef),
    )
  ) {
    missing.push('PRODUCT');
  }
  if (
    !basis.some(
      (fact) =>
        fact.subject === undefined && fact.role === 'VARIANT' && sameRef(fact.source.resourceRef, selection.variantRef),
    )
  ) {
    missing.push('VARIANT');
  }
  for (const role of roleOnly) {
    if (role !== 'PRODUCT' && role !== 'VARIANT' && !present(role)) {
      missing.push(role);
    }
  }
  for (const requirement of pinned) {
    if (!basis.some((fact) => matchesPinned(fact, requirement))) {
      missing.push(requirement.role);
    }
  }
  if (missing.length > 0) {
    return { missingRoles: [...new Set(missing)], status: 'INCOMPLETE' };
  }

  const minimal = basis.filter((fact) => {
    if (fact.subject !== undefined) {
      return subjectBelongsToSelection(fact, selection);
    }
    if (fact.role === 'PRODUCT') {
      return sameRef(fact.source.resourceRef, selection.productRef);
    }
    if (fact.role === 'VARIANT') {
      return sameRef(fact.source.resourceRef, selection.variantRef);
    }
    if (
      roleOnly.has(fact.role) ||
      optionalWhenPresent.has(fact.role) ||
      (fact.role === 'PRODUCT_TYPE_UNTYPED_DECISION' && roleOnly.has('PRODUCT_TYPE'))
    ) {
      return true;
    }
    return pinned.some((requirement) => matchesPinned(fact, requirement));
  });
  return { basis: minimal, status: 'COMPLETE' };
};
