import { describe, expect, it } from 'effect-rstest';

import {
  addDirectCategory,
  deriveClassification,
  matchesCategory,
  removeDirectCategory,
} from '../../shared/domain/category-classification.ts';

const tenantId = 'tenant-a';
const ref = (resourceId: string) => ({ resourceId, tenantId });
const otherTenant = { resourceId: 'foreign', tenantId: 'tenant-b' };
const productRef = ref('product');
const parent = ref('shelves');
const child = ref('wall-shelves');
const second = ref('spares');
const hierarchy = [
  { categoryRef: parent, lifecycle: 'ACTIVE' as const },
  { categoryRef: child, lifecycle: 'ACTIVE' as const, parentRef: parent },
  { categoryRef: second, lifecycle: 'ACTIVE' as const },
];
const revision = { assignments: 3, hierarchy: 7 };

describe('Product category classification', () => {
  it('permits zero or many independent direct assignments without a primary category', () => {
    const empty = deriveClassification(productRef, [], hierarchy, revision);
    expect(empty).toEqual({ ancestors: [], directCategories: [], revision, status: 'AVAILABLE' });

    const first = addDirectCategory([], productRef, child);
    expect(first.status).toBe('ADDED');
    if (!('assignments' in first)) {
      return;
    }
    const again = addDirectCategory(first.assignments, productRef, child);
    expect(again).toEqual({ assignments: first.assignments, status: 'UNCHANGED' });
    const two = addDirectCategory(first.assignments, productRef, second);
    expect(two.status).toBe('ADDED');
    if (!('assignments' in two)) {
      return;
    }
    expect(two.assignments).toHaveLength(2);
    expect(Object.keys(two.assignments[0] ?? {})).toEqual(['categoryRef', 'productRef']);
  });

  it('derives explainable ancestors but never adds inferred direct links', () => {
    const assignments = [{ categoryRef: child, productRef }];
    const result = deriveClassification(productRef, assignments, hierarchy, revision);
    expect(result).toEqual({
      ancestors: [{ ancestorRef: parent, viaDirectCategories: [child] }],
      directCategories: [child],
      revision,
      status: 'AVAILABLE',
    });
    expect(matchesCategory(result, parent, 'DIRECT')).toBe(false);
    expect(matchesCategory(result, parent, 'SUBTREE')).toBe(true);
  });

  it('preserves independent and explicit ancestor links on single-link removal', () => {
    const assignments = [
      { categoryRef: child, productRef },
      { categoryRef: parent, productRef },
      { categoryRef: second, productRef },
    ];
    const removed = removeDirectCategory(assignments, productRef, child);
    expect(removed.status).toBe('REMOVED');
    if (!('assignments' in removed)) {
      return;
    }
    expect(removed.assignments.map(({ categoryRef }) => categoryRef)).toEqual([parent, second]);
    const result = deriveClassification(productRef, removed.assignments, hierarchy, revision);
    expect(matchesCategory(result, parent, 'DIRECT')).toBe(true);
    expect(matchesCategory(result, child, 'DIRECT')).toBe(false);
  });

  it('retains an ancestor supported by another direct assignment', () => {
    const sibling = ref('floor-shelves');
    const expandedHierarchy = [...hierarchy, { categoryRef: sibling, lifecycle: 'ACTIVE' as const, parentRef: parent }];
    const assignments = [
      { categoryRef: child, productRef },
      { categoryRef: sibling, productRef },
      { categoryRef: child, productRef: ref('other-product') },
    ];
    const before = deriveClassification(productRef, assignments, expandedHierarchy, revision);
    if (before.status !== 'AVAILABLE') {
      throw new Error('Expected complete classification snapshot');
    }
    expect(before.ancestors).toEqual([{ ancestorRef: parent, viaDirectCategories: [child, sibling] }]);
    const removed = removeDirectCategory(assignments, productRef, child);
    if (!('assignments' in removed)) {
      throw new Error('Expected same-Tenant removal');
    }
    const after = deriveClassification(productRef, removed.assignments, expandedHierarchy, revision);
    if (after.status !== 'AVAILABLE') {
      throw new Error('Expected complete classification snapshot');
    }
    expect(after.directCategories).toEqual([sibling]);
    expect(after.ancestors).toEqual([{ ancestorRef: parent, viaDirectCategories: [sibling] }]);
    expect(removed.assignments).toContainEqual({ categoryRef: child, productRef: ref('other-product') });
  });

  it('recomputes ancestors after a move while retaining the same direct assignment', () => {
    const assignments = [{ categoryRef: child, productRef }];
    const moved = deriveClassification(
      productRef,
      assignments,
      [
        { categoryRef: parent, lifecycle: 'ACTIVE' },
        { categoryRef: child, lifecycle: 'ACTIVE', parentRef: second },
        { categoryRef: second, lifecycle: 'ACTIVE' },
      ],
      { assignments: 3, hierarchy: 8 },
    );
    expect(moved.status).toBe('AVAILABLE');
    expect(matchesCategory(moved, parent, 'SUBTREE')).toBe(false);
    expect(matchesCategory(moved, second, 'SUBTREE')).toBe(true);
    if (moved.status === 'AVAILABLE') {
      expect(moved.directCategories).toEqual([child]);
    }
  });

  it('keeps unavailable classification distinct from a known empty assignment', () => {
    const unavailable = deriveClassification(productRef, undefined, hierarchy, revision);
    expect(unavailable).toEqual({ status: 'UNAVAILABLE' });
    expect(matchesCategory(unavailable, parent, 'SUBTREE')).toBeUndefined();
  });

  it('fails closed on incomplete or cyclic hierarchy data', () => {
    const assignments = [{ categoryRef: child, productRef }];
    expect(deriveClassification(productRef, assignments, [], revision)).toEqual({ status: 'UNAVAILABLE' });
    expect(
      deriveClassification(
        productRef,
        assignments,
        [
          { categoryRef: child, lifecycle: 'ACTIVE', parentRef: parent },
          { categoryRef: parent, lifecycle: 'ACTIVE', parentRef: child },
        ],
        revision,
      ),
    ).toEqual({ status: 'UNAVAILABLE' });
  });

  it('fails closed when an unrelated branch cycles in the same authoritative tenant snapshot', () => {
    const unrelatedA = ref('unrelated-a');
    const unrelatedB = ref('unrelated-b');
    const corruptHierarchy = [
      ...hierarchy,
      { categoryRef: unrelatedA, lifecycle: 'ACTIVE' as const, parentRef: unrelatedB },
      { categoryRef: unrelatedB, lifecycle: 'ACTIVE' as const, parentRef: unrelatedA },
    ];
    expect(deriveClassification(productRef, [{ categoryRef: child, productRef }], corruptHierarchy, revision)).toEqual({
      status: 'UNAVAILABLE',
    });
    expect(deriveClassification(productRef, [], corruptHierarchy, revision)).toEqual({ status: 'UNAVAILABLE' });
  });

  it('fails closed on duplicate direct links, duplicate hierarchy nodes, and retired ancestry', () => {
    const assignment = { categoryRef: child, productRef };
    expect(deriveClassification(productRef, [assignment, assignment], hierarchy, revision)).toEqual({
      status: 'UNAVAILABLE',
    });
    expect(
      deriveClassification(
        productRef,
        [assignment],
        [...hierarchy, { categoryRef: child, lifecycle: 'ACTIVE' }],
        revision,
      ),
    ).toEqual({ status: 'UNAVAILABLE' });
    expect(
      deriveClassification(
        productRef,
        [assignment],
        [
          { categoryRef: parent, lifecycle: 'RETIRED' },
          { categoryRef: child, lifecycle: 'ACTIVE', parentRef: parent },
        ],
        revision,
      ),
    ).toEqual({ status: 'UNAVAILABLE' });
    expect(
      deriveClassification(productRef, [assignment], [{ categoryRef: child, lifecycle: 'RETIRED' }], revision),
    ).toEqual({ status: 'UNAVAILABLE' });
  });

  it('rejects cross-Tenant links', () => {
    expect(addDirectCategory([], productRef, otherTenant)).toEqual({ status: 'TENANT_MISMATCH' });
    expect(removeDirectCategory([], productRef, otherTenant)).toEqual({ status: 'TENANT_MISMATCH' });
  });
});
