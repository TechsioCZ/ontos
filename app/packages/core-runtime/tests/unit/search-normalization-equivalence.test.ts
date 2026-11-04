import { expect, it } from 'effect-rstest';

import {
  createCoreSearchValueMatcher,
  matchesCoreSearchValues,
  normalizeCoreSearchText,
} from '../../src/search/search-contract.ts';

// The reference is the pre-optimization definition: locale-aware lowercasing and a full value map before matching.
const referenceNormalize = (value: string): string =>
  value
    .normalize('NFKD')
    .replaceAll(/\p{M}+/gu, '')
    .normalize('NFKC')
    .toLocaleLowerCase('und');
const referenceMatches = (values: readonly string[], tokens: readonly string[]): boolean => {
  if (tokens.length === 0) {
    return false;
  }
  const normalized = values.map(referenceNormalize);
  return tokens.every((token) => normalized.some((value) => value.includes(token)));
};

const samples = [
  'Příliš žluťoučký kůň úpěl ďábelské ódy',
  'ΟΔΟΣ ΑΣ ΣΑΣ Σ',
  'İstanbul I ı i̇ ǅ ǈ ß ẞ ﬁnal ＡＢＣ',
  'Ceník ÚČTŮ: 12 345,67 Kč (DPH 21 %) — Novák s.r.o.',
  '',
  'Task number 42',
];

it('normalizes search text exactly as the locale-aware reference does', () => {
  for (const sample of samples) {
    expect(normalizeCoreSearchText(sample), sample).toBe(referenceNormalize(sample));
  }
});

it('matches values exactly as the reference matcher does', () => {
  const tokenSets = [[], ['task'], ['zákazník', 'novák'], ['42', 'nope'], ['ο', 'σ'], ['dph', '21']];
  const valueSets = [[], samples, [samples[0] ?? '', samples[3] ?? ''], [''], ['Úkol', 'schůzka se zákazníkem']];
  for (const tokens of tokenSets) {
    const matcher = createCoreSearchValueMatcher(tokens);
    for (const values of valueSets) {
      const expected = referenceMatches(values, tokens);
      expect(matcher(values), JSON.stringify({ tokens, values })).toBe(expected);
      expect(matcher(values), 'memoized second call').toBe(expected);
      expect(matchesCoreSearchValues(values, tokens), JSON.stringify({ tokens, values })).toBe(expected);
    }
  }
});
