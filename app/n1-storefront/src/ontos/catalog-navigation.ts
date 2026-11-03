import type { CatalogModel } from "./catalog-model";
import type { TreeNode } from "@techsio/ui-kit/molecules/tree-view";
import { Schema } from "effect";

type Category = CatalogModel["categories"][number];
interface CategoryNode extends TreeNode {
  children: CategoryNode[];
  id: string;
  name: string;
}

/** URL state remains server paging, never a client slice of one owner page. */
export const catalogPage = (value: string | string[] | undefined): number => {
  const page = Schema.is(Schema.String)(value) ? Number(value) : 1;
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
};

/** Only real ancestors; malformed owner cycles terminate without guessed hierarchy. */
export const categoryTrail = (categories: readonly Category[], slug: string): Category[] => {
  const trail: Category[] = [];
  const seen = new Set<string>();
  const byId = new Map(categories.map((item) => [item.id, item]));
  let category = categories.find((item) => item.slug === slug);
  while (category && !seen.has(category.id)) {
    trail.unshift(category);
    seen.add(category.id);
    const { parentId } = category;
    category = parentId === null ? undefined : byId.get(parentId);
  }
  return trail;
};

export const categoryTree = (categories: readonly Category[]): CategoryNode[] => {
  const byParent = new Map<string | null, Category[]>();
  for (const item of categories) {
    const siblings = byParent.get(item.parentId) ?? [];
    siblings.push(item);
    byParent.set(item.parentId, siblings);
  }
  const childrenOf = (parentId: string | null, ancestors: ReadonlySet<string>): CategoryNode[] => {
    const result: CategoryNode[] = [];
    for (const item of byParent.get(parentId) ?? []) {
      if (!ancestors.has(item.id)) {
        result.push({
          children: childrenOf(item.id, new Set([...ancestors, item.id])),
          id: item.id,
          name: item.name,
        });
      }
    }
    return result;
  };
  return childrenOf(null, new Set());
};
