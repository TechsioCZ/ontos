/**
 * ontos_capabilities {query} matching: case- and diacritics-insensitive, with a crude Czech stem so
 * "faktura" finds "faktury", "smlouva" finds "smlouvy" and "ukol" finds "Úkoly".
 */
export const foldText = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

/** Drops the Czech case ending of longer words: faktura -> faktu, pronajem -> pronaj, udrzba -> udrz. */
const stem = (word: string): string => (word.length >= 6 ? word.slice(0, word.length - 2) : word.length === 5 ? word.slice(0, 4) : word);

/** Search tokens of a query; empty when the query is blank. */
export const queryTokens = (query: string): readonly string[] =>
  foldText(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2)
    .map(stem);

/** Every token occurs in the (folded) haystack. An empty token list matches everything. */
export const matchesTokens = (tokens: readonly string[], haystack: string): boolean => {
  if (tokens.length === 0) {
    return true;
  }
  const folded = foldText(haystack);
  return tokens.every((token) => folded.includes(token));
};
