// Category search by any part of the category path, case- and diacritics-insensitive. The server ranks the
// candidates PostgreSQL pre-filtered (see `searchCategoryCandidates`), so a picker never loads the whole tree.

/** Stainless grades have one owner spelling in imports, navigation and staff lists. */
export const normalizeCategoryName = (value: string): string =>
  value.replaceAll(/\bA\s+(?<grade>[245])\b/giu, 'A$<grade>');

/** Most matches one category search returns. */
export const CATEGORY_RESULT_LIMIT = 50;

/** What a category search ranks: one category with its root-first path label (`Šrouby › DIN 912 › A 2`). */
export interface CategoryCandidate {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly trail: string;
}

const PATH_SEPARATORS = /[\s›>/]+/u;
const WORD_SEPARATORS = /[^\p{L}\p{N}]+/u;

/** Lower case without diacritics (`Šrouby` -> `srouby`). */
export const foldCategoryText = (text: string): string =>
  text.normalize('NFD').replaceAll(/\p{M}/gu, '').toLocaleLowerCase('cs-CZ');

/** The query's words as the search matches them (path separators split words too). */
export const categoryQueryWords = (query: string): readonly string[] =>
  foldCategoryText(query.trim())
    .split(PATH_SEPARATORS)
    .filter((word) => word !== '');

const wordsOf = (text: string) =>
  foldCategoryText(text)
    .split(WORD_SEPARATORS)
    .filter((word) => word !== '');

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
export const rankCategories = <Candidate extends CategoryCandidate>(
  candidates: readonly Candidate[],
  query: string,
): readonly Candidate[] => {
  const words = categoryQueryWords(query);
  if (words.length === 0) {
    return [];
  }
  const scored: {
    readonly candidate: Candidate;
    readonly depth: number;
    readonly score: number;
  }[] = [];
  for (const candidate of candidates) {
    const haystack = `${foldCategoryText(candidate.trail)} ${candidate.slug}`;
    if (!words.every((word) => haystack.includes(word))) {
      continue;
    }
    const nameWords = wordsOf(candidate.name);
    let suffix = 0;
    while (suffix < words.length && nameWords.some((word) => word.startsWith(words[words.length - 1 - suffix] ?? ''))) {
      suffix += 1;
    }
    const exactness = nameWords.length === 0 ? 0 : Math.min(suffix, nameWords.length) / nameWords.length;
    const ordered = matchesInOrder(words, wordsOf(candidate.trail)) ? 1 : 0;
    scored.push({ candidate, depth: candidate.trail.split(' › ').length, score: suffix * 2 + ordered + exactness });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.depth - b.depth || a.candidate.trail.localeCompare(b.candidate.trail, 'cs'))
    .map((entry) => entry.candidate);
};
