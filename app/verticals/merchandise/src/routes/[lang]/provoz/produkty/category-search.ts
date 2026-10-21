// Admin category picker search: by any part of the category path, case- and diacritics-insensitive.
import { foldSearchText } from '@app/admin-ui';
import type { CatalogCategory } from '../../../../../shared/domain/merchandise-model.ts';

export const CATEGORY_RESULT_LIMIT = 50;
const PATH_SEPARATORS = /[\s›>/]+/u;

const WORD_SEPARATORS = /[^\p{L}\p{N}]+/u;
const wordsOf = (text: string) => foldSearchText(text).split(WORD_SEPARATORS).filter((word) => word !== '');

/** Query words matched, in order, by the starts of the path's words (`din 912 a 2` in `DIN 912 › A 2`). */
const matchesInOrder = (query: readonly string[], path: readonly string[]): boolean => {
  let position = 0;
  for (const word of query) {
    while (position < path.length && !(path[position] ?? '').startsWith(word)) position += 1;
    if (position >= path.length) return false;
    position += 1;
  }
  return true;
};

/**
 * Finds categories by any part of their path (`din 912 a 2`, `šrouby › a2`), case- and diacritics-insensitive.
 * Every word must appear in the path or slug. Ranking prefers the category whose own name carries the last words
 * of the query (the leaf the user means), then a path that carries all words in order, then exact leaf names and
 * shallower paths, so an ambiguous leaf like „A 2“ is told apart by its parents.
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
  const scored: {
    readonly category: CatalogCategory;
    readonly depth: number;
    readonly score: number;
    readonly trail: string;
  }[] = [];
  for (const category of categories) {
    const trail = trails.get(category.id) ?? category.name;
    const haystack = `${foldSearchText(trail)} ${category.slug}`;
    if (!words.every((word) => haystack.includes(word))) {
      continue;
    }
    const nameWords = wordsOf(category.name);
    let suffix = 0;
    while (
      suffix < words.length &&
      nameWords.some((word) => word.startsWith(words[words.length - 1 - suffix] ?? ''))
    ) {
      suffix += 1;
    }
    const exactness = nameWords.length === 0 ? 0 : Math.min(suffix, nameWords.length) / nameWords.length;
    const ordered = matchesInOrder(words, wordsOf(trail)) ? 1 : 0;
    scored.push({ category, depth: trail.split(' › ').length, score: suffix * 2 + ordered + exactness, trail });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.depth - b.depth || a.trail.localeCompare(b.trail, 'cs'))
    .map((entry) => entry.category);
};
