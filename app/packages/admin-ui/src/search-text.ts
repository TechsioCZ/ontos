/** Lowercase text without diacritics, so a search for `sumper` or `zalohovani` finds `Šumper` or `Zálohování`. */
export const foldSearchText = (text: string): string =>
  text.normalize('NFD').replaceAll(/\p{M}/gu, '').toLocaleLowerCase('cs-CZ');

/** Diacritics- and case-insensitive substring match. A blank query matches everything. */
export const matchesSearch = (value: string, query: string): boolean =>
  foldSearchText(value).includes(foldSearchText(query.trim()));
