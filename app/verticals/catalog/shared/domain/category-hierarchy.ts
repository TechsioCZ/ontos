import { Schema } from 'effect';

/** Pure checks over one authoritative snapshot of Catalog's category tree. */
export type CategoryIdentity = Readonly<{ resourceId: string; tenantId: string }>;

export type CategoryNode = Readonly<{
  categoryRef: CategoryIdentity;
  lifecycle: 'ACTIVE' | 'RETIRED';
  parentRef?: CategoryIdentity;
}>;

const CategoryHierarchyFailureSchema = Schema.TaggedStruct('CategoryHierarchyFailure', {
  reason: Schema.Literals([
    'CATEGORY_NOT_FOUND',
    'CATEGORY_RETIRED',
    'PARENT_NOT_FOUND',
    'PARENT_RETIRED',
    'CROSS_TENANT_PARENT',
    'SELF_PARENT',
    'CYCLE',
    'INCONSISTENT_HIERARCHY',
    'DIRECT_CHILDREN_REMAIN',
    'DIRECT_ASSIGNMENTS_REMAIN',
  ]),
});
type CategoryHierarchyFailure = typeof CategoryHierarchyFailureSchema.Type;
export const CategoryValidSchema = Schema.TaggedStruct('Valid', {});
export type CategoryCheck = typeof CategoryHierarchyFailureSchema.Type | typeof CategoryValidSchema.Type;

const valid: CategoryCheck = { _tag: 'Valid' };
const failure = (reason: CategoryHierarchyFailure['reason']): CategoryHierarchyFailure => ({
  _tag: 'CategoryHierarchyFailure',
  reason,
});

const sameRef = (left: CategoryIdentity, right: CategoryIdentity): boolean =>
  left.tenantId === right.tenantId && left.resourceId === right.resourceId;

const findNode = (nodes: readonly CategoryNode[], ref: CategoryIdentity): CategoryNode | undefined =>
  nodes.find(({ categoryRef }) => sameRef(categoryRef, ref));

export const categorySnapshotIsInconsistent = (nodes: readonly CategoryNode[], tenantId: string): boolean => {
  const tenantNodes = nodes.filter(({ categoryRef }) => categoryRef.tenantId === tenantId);
  const ids = new Set<string>();
  for (const node of tenantNodes) {
    if (ids.has(node.categoryRef.resourceId)) {
      return true;
    }
    ids.add(node.categoryRef.resourceId);
  }
  for (const node of tenantNodes) {
    const visited = new Set<string>();
    let cursor: CategoryNode | undefined = node;
    while (cursor !== undefined) {
      if (visited.has(cursor.categoryRef.resourceId)) {
        return true;
      }
      visited.add(cursor.categoryRef.resourceId);
      if (cursor.parentRef === undefined) {
        break;
      }
      if (cursor.parentRef.tenantId !== tenantId) {
        return true;
      }
      cursor = findNode(tenantNodes, cursor.parentRef);
      if (cursor === undefined) {
        return true;
      }
    }
  }
  return false;
};

/** A root has no parent. The caller must recheck within the serialized write transaction. */
export const validateCategoryMove = (
  nodes: readonly CategoryNode[],
  categoryRef: CategoryIdentity,
  parentRef?: CategoryIdentity,
): CategoryCheck => {
  const category = findNode(nodes, categoryRef);
  if (category === undefined) {
    return failure('CATEGORY_NOT_FOUND');
  }
  if (category.lifecycle !== 'ACTIVE') {
    return failure('CATEGORY_RETIRED');
  }
  if (categorySnapshotIsInconsistent(nodes, categoryRef.tenantId)) {
    return failure('INCONSISTENT_HIERARCHY');
  }
  if (parentRef === undefined) {
    return valid;
  }
  if (parentRef.tenantId !== categoryRef.tenantId) {
    return failure('CROSS_TENANT_PARENT');
  }
  if (sameRef(parentRef, categoryRef)) {
    return failure('SELF_PARENT');
  }

  const parent = findNode(nodes, parentRef);
  if (parent === undefined) {
    return failure('PARENT_NOT_FOUND');
  }
  if (parent.lifecycle !== 'ACTIVE') {
    return failure('PARENT_RETIRED');
  }

  const seen = new Set<string>();
  let ancestor: CategoryNode | undefined = parent;
  while (ancestor !== undefined) {
    const key = `${ancestor.categoryRef.tenantId}:${ancestor.categoryRef.resourceId}`;
    if (seen.has(key)) {
      return failure('INCONSISTENT_HIERARCHY');
    }
    seen.add(key);
    if (sameRef(ancestor.categoryRef, categoryRef)) {
      return failure('CYCLE');
    }
    if (ancestor.parentRef === undefined) {
      break;
    }
    if (ancestor.parentRef.tenantId !== categoryRef.tenantId) {
      return failure('INCONSISTENT_HIERARCHY');
    }
    ancestor = findNode(nodes, ancestor.parentRef);
    if (ancestor === undefined) {
      return failure('INCONSISTENT_HIERARCHY');
    }
  }
  return valid;
};

/** Direct dependencies must be resolved by explicit committed writes before retirement. */
export const validateCategoryRetirement = (
  nodes: readonly CategoryNode[],
  categoryRef: CategoryIdentity,
  directProductAssignmentCount: number,
): CategoryCheck => {
  const category = findNode(nodes, categoryRef);
  if (category === undefined) {
    return failure('CATEGORY_NOT_FOUND');
  }
  if (category.lifecycle !== 'ACTIVE') {
    return failure('CATEGORY_RETIRED');
  }
  if (nodes.some(({ parentRef }) => parentRef !== undefined && sameRef(parentRef, categoryRef))) {
    return failure('DIRECT_CHILDREN_REMAIN');
  }
  if (directProductAssignmentCount > 0) {
    return failure('DIRECT_ASSIGNMENTS_REMAIN');
  }
  return valid;
};
