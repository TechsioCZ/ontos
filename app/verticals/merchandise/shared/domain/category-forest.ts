import { Data } from 'effect';

/** Structural contract shared by the owner and its storefront projections. */
export interface CategoryLink {
  readonly id: string;
  readonly parentId: string | null;
}

export type CategoryForestIssue =
  | { readonly categoryId: string; readonly kind: 'duplicate' }
  | { readonly categoryId: string; readonly kind: 'missing-parent' }
  | { readonly categoryId: string; readonly kind: 'cycle' };

/**
 * Validate once when a complete snapshot is published or a projection crosses a boundary.
 * A projection may omit ancestors; a complete snapshot may not. Neither may contain a cycle.
 * Iterative, linear traversal also accepts deep valid trees without overflowing the stack.
 */
export const categoryForestIssue = (
  links: readonly CategoryLink[],
  completeness: 'complete' | 'projection',
): CategoryForestIssue | undefined => {
  const byId = new Map<string, CategoryLink>();
  for (const link of links) {
    if (byId.has(link.id)) {
      return { categoryId: link.id, kind: 'duplicate' };
    }
    byId.set(link.id, link);
  }
  const completed = new Set<string>();
  for (const link of links) {
    if (completed.has(link.id)) {
      continue;
    }
    const path = new Set<string>();
    let current: CategoryLink | undefined = link;
    while (current !== undefined && !completed.has(current.id)) {
      if (path.has(current.id)) {
        return { categoryId: current.id, kind: 'cycle' };
      }
      path.add(current.id);
      if (current.parentId === null) {
        break;
      }
      const parent = byId.get(current.parentId);
      if (parent === undefined && completeness === 'complete') {
        return { categoryId: current.id, kind: 'missing-parent' };
      }
      current = parent;
    }
    for (const id of path) {
      completed.add(id);
    }
  }
  return undefined;
};

export class InvalidCategoryForest extends Data.TaggedError('InvalidCategoryForest')<{
  readonly code: 'invalid_category_forest';
  readonly issue: CategoryForestIssue;
  readonly message: string;
}> {
  constructor(issue: CategoryForestIssue) {
    super({ code: 'invalid_category_forest', issue, message: `Invalid category forest: ${issue.kind}` });
  }
}

export const assertCategoryForest = (links: readonly CategoryLink[], completeness: 'complete' | 'projection'): void => {
  const issue = categoryForestIssue(links, completeness);
  if (issue !== undefined) {
    throw new InvalidCategoryForest(issue);
  }
};
