import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import {
  CategoryValidSchema,
  validateCategoryMove,
  validateCategoryRetirement,
} from '../../shared/domain/category-hierarchy.ts';
import type { CategoryIdentity, CategoryNode } from '../../shared/domain/category-hierarchy.ts';

const ref = (resourceId: string, tenantId = 'tenant-a'): CategoryIdentity => ({ resourceId, tenantId });
const node = (
  resourceId: string,
  parentRef?: CategoryIdentity,
  lifecycle: CategoryNode['lifecycle'] = 'ACTIVE',
): CategoryNode =>
  parentRef === undefined
    ? { categoryRef: ref(resourceId), lifecycle }
    : { categoryRef: ref(resourceId), lifecycle, parentRef };

describe('Catalog category hierarchy', () => {
  const tree = [node('home'), node('shelves', ref('home')), node('wall', ref('shelves')), node('workshop')] as const;

  it('allows a root and moving a subtree without changing its identity or direct descendants', () => {
    expect(Schema.is(CategoryValidSchema)(validateCategoryMove(tree, ref('shelves')))).toBe(true);
    expect(Schema.is(CategoryValidSchema)(validateCategoryMove(tree, ref('shelves'), ref('workshop')))).toBe(true);
    expect(tree[1]?.parentRef).toEqual(ref('home'));
    expect(tree[2]?.parentRef).toEqual(ref('shelves'));
  });

  it('rejects self, descendant, cross-tenant, retired, and absent parents', () => {
    expect(validateCategoryMove(tree, ref('shelves'), ref('shelves'))).toMatchObject({ reason: 'SELF_PARENT' });
    expect(validateCategoryMove(tree, ref('home'), ref('wall'))).toMatchObject({ reason: 'CYCLE' });
    expect(validateCategoryMove(tree, ref('home'), ref('foreign', 'tenant-b'))).toMatchObject({
      reason: 'CROSS_TENANT_PARENT',
    });
    expect(validateCategoryMove(tree, ref('home'), ref('missing'))).toMatchObject({ reason: 'PARENT_NOT_FOUND' });
    expect(
      validateCategoryMove([...tree, node('retired', undefined, 'RETIRED')], ref('home'), ref('retired')),
    ).toMatchObject({ reason: 'PARENT_RETIRED' });
  });

  it('fails closed on a pre-existing cycle rather than looping', () => {
    expect(
      validateCategoryMove([node('a'), node('b', ref('c')), node('c', ref('b'))], ref('a'), ref('b')),
    ).toMatchObject({ reason: 'INCONSISTENT_HIERARCHY' });
    expect(validateCategoryMove([node('a'), node('b', ref('c')), node('c', ref('b'))], ref('a'))).toMatchObject({
      reason: 'INCONSISTENT_HIERARCHY',
    });
  });

  it('blocks retirement for current direct children or assignments, then permits it after explicit resolution', () => {
    expect(validateCategoryRetirement(tree, ref('home'), 0)).toMatchObject({ reason: 'DIRECT_CHILDREN_REMAIN' });
    expect(validateCategoryRetirement([node('home')], ref('home'), 1)).toMatchObject({
      reason: 'DIRECT_ASSIGNMENTS_REMAIN',
    });
    expect(Schema.is(CategoryValidSchema)(validateCategoryRetirement([node('home')], ref('home'), 0))).toBe(true);
  });
});
