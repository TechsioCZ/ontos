// Admin category picker search: by any part of the category path, case- and diacritics-insensitive.
import { foldSearchText } from '@app/admin-ui';
import type { CatalogCategory } from '../../../../../shared/domain/merchandise-model.ts';

export const CATEGORY_RESULT_LIMIT = 50;
const PATH_SEPARATORS = /[\s›>/]+/u;

/**
 * Finds categories by any part of their path (`din 912 a 2`, `šrouby › a2`), case- and diacritics-insensitive.
 * Every word must appear in the path or slug. Categories whose own name carries the words rank first, then the
 * shorter (less nested) paths, so an ambiguous leaf like „A 2“ is told apart by its parents.
 */
export const searchCategories = (
  categories: readonly CatalogCategory[],
  trails: ReadonlyMap<string, string>,
  query: string,
): readonly CatalogCategory[] => {
  const words = foldSearchText(query.trim())
    .split(PATH_SEPARATORS)
    .filter((word) => word !== '');
  if (words.length === 0) {
    return [];
  }
  const scored: { readonly category: CatalogCategory; readonly depth: number; readonly score: number; readonly trail: string }[] =
    [];
  for (const category of categories) {
    const trail = trails.get(category.id) ?? category.name;
    const haystack = `${foldSearchText(trail)} ${category.slug}`;
    if (!words.every((word) => haystack.includes(word))) {
      continue;
    }
    const name = foldSearchText(category.name);
    const score =
      (name === words.join(' ') ? 4 : 0) + words.filter((word) => name.includes(word)).length / words.length;
    scored.push({ category, depth: trail.split(' › ').length, score, trail });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.depth - b.depth || a.trail.localeCompare(b.trail, 'cs'))
    .map((entry) => entry.category);
};

