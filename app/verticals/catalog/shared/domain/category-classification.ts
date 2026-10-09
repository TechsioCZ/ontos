import { categorySnapshotIsInconsistent } from './category-hierarchy.ts';

/** Product category facts are independent of navigation, pricing, and saleability. */
export interface CategoryKey {
  readonly resourceId: string;
  readonly tenantId: string;
}

export interface DirectCategoryAssignment {
  readonly categoryRef: CategoryKey;
  readonly productRef: CategoryKey;
}

export interface CategoryParent {
  readonly categoryRef: CategoryKey;
  readonly lifecycle: 'ACTIVE' | 'RETIRED';
  readonly parentRef?: CategoryKey;
}

export interface ClassificationRevision {
  readonly assignments: number;
  readonly hierarchy: number;
}

interface AncestorClassification {
  readonly ancestorRef: CategoryKey;
  readonly viaDirectCategories: readonly CategoryKey[];
}

export type ClassificationResult =
  | {
      readonly ancestors: readonly AncestorClassification[];
      readonly directCategories: readonly CategoryKey[];
      readonly revision: ClassificationRevision;
      readonly status: 'AVAILABLE';
    }
  | { readonly status: 'UNAVAILABLE' };

export type AssignmentResult =
  | {
      readonly assignments: readonly DirectCategoryAssignment[];
      readonly status: 'ADDED' | 'UNCHANGED' | 'REMOVED';
    }
  | { readonly status: 'TENANT_MISMATCH' };

const keyOf = (ref: CategoryKey): string => `${ref.tenantId}:${ref.resourceId}`;
const sameRef = (left: CategoryKey, right: CategoryKey): boolean =>
  left.tenantId === right.tenantId && left.resourceId === right.resourceId;

const hierarchyIsCorrupt = (
  hierarchy: readonly CategoryParent[],
  parentByCategory: ReadonlyMap<string, CategoryParent>,
  tenantId: string,
): boolean =>
  hierarchy.some(
    ({ categoryRef, parentRef }) =>
      categoryRef.tenantId !== tenantId ||
      (parentRef !== undefined && (parentRef.tenantId !== tenantId || !parentByCategory.has(keyOf(parentRef)))),
  ) || categorySnapshotIsInconsistent(hierarchy, tenantId);

/** Adds one explicit link. Neither order nor a primary category is recorded. */
export const addDirectCategory = (
  assignments: readonly DirectCategoryAssignment[],
  productRef: CategoryKey,
  categoryRef: CategoryKey,
): AssignmentResult => {
  if (productRef.tenantId !== categoryRef.tenantId) {
    return { status: 'TENANT_MISMATCH' };
  }
  if (
    assignments.some(
      ({ categoryRef: category, productRef: owner }) => sameRef(owner, productRef) && sameRef(category, categoryRef),
    )
  ) {
    return { assignments, status: 'UNCHANGED' };
  }
  return { assignments: [...assignments, { categoryRef, productRef }], status: 'ADDED' };
};

/** Removes only the named link; a Product can remain unclassified. */
export const removeDirectCategory = (
  assignments: readonly DirectCategoryAssignment[],
  productRef: CategoryKey,
  categoryRef: CategoryKey,
): AssignmentResult => {
  if (productRef.tenantId !== categoryRef.tenantId) {
    return { status: 'TENANT_MISMATCH' };
  }
  const remaining = assignments.filter(
    ({ categoryRef: category, productRef: owner }) => !(sameRef(owner, productRef) && sameRef(category, categoryRef)),
  );
  return { assignments: remaining, status: remaining.length === assignments.length ? 'UNCHANGED' : 'REMOVED' };
};

/** Caller supplies one authoritative revision-paired snapshot; missing data is not an empty set. */
export const deriveClassification = (
  productRef: CategoryKey,
  assignments: readonly DirectCategoryAssignment[] | undefined,
  hierarchy: readonly CategoryParent[] | undefined,
  revision: ClassificationRevision | undefined,
): ClassificationResult => {
  if (assignments === undefined || hierarchy === undefined || revision === undefined) {
    return { status: 'UNAVAILABLE' };
  }
  const direct: CategoryKey[] = [];
  for (const assignment of assignments) {
    if (sameRef(assignment.productRef, productRef)) {
      direct.push(assignment.categoryRef);
    }
  }
  const parentByCategory = new Map<string, CategoryParent>();
  for (const node of hierarchy) {
    const key = keyOf(node.categoryRef);
    if (parentByCategory.has(key)) {
      return { status: 'UNAVAILABLE' };
    }
    parentByCategory.set(key, node);
  }
  const seenDirect = new Set<string>();
  for (const categoryRef of direct) {
    const key = keyOf(categoryRef);
    if (seenDirect.has(key)) {
      return { status: 'UNAVAILABLE' };
    }
    seenDirect.add(key);
  }
  if (
    direct.some(
      (categoryRef) =>
        categoryRef.tenantId !== productRef.tenantId ||
        parentByCategory.get(keyOf(categoryRef))?.lifecycle !== 'ACTIVE',
    ) ||
    hierarchyIsCorrupt(hierarchy, parentByCategory, productRef.tenantId)
  ) {
    return { status: 'UNAVAILABLE' };
  }
  const ancestors = new Map<string, { ancestorRef: CategoryKey; viaDirectCategories: CategoryKey[] }>();
  for (const source of direct) {
    const visited = new Set<string>([keyOf(source)]);
    let parent = parentByCategory.get(keyOf(source))?.parentRef;
    while (parent !== undefined) {
      const key = keyOf(parent);
      if (visited.has(key)) {
        return { status: 'UNAVAILABLE' };
      }
      const node = parentByCategory.get(key);
      if (node?.lifecycle !== 'ACTIVE') {
        return { status: 'UNAVAILABLE' };
      }
      visited.add(key);
      const classification = ancestors.get(key);
      if (classification === undefined) {
        ancestors.set(key, { ancestorRef: parent, viaDirectCategories: [source] });
      } else if (!classification.viaDirectCategories.some((existing) => sameRef(existing, source))) {
        classification.viaDirectCategories.push(source);
      }
      parent = node.parentRef;
    }
  }
  return { ancestors: [...ancestors.values()], directCategories: direct, revision, status: 'AVAILABLE' };
};

/** A direct rule does not accept merely derived ancestry; a subtree rule can. */
export const matchesCategory = (
  classification: ClassificationResult,
  categoryRef: CategoryKey,
  mode: 'DIRECT' | 'SUBTREE',
): boolean | undefined => {
  if (classification.status === 'UNAVAILABLE') {
    return undefined;
  }
  if (classification.directCategories.some((direct) => sameRef(direct, categoryRef))) {
    return true;
  }
  return mode === 'SUBTREE' && classification.ancestors.some(({ ancestorRef }) => sameRef(ancestorRef, categoryRef));
};
