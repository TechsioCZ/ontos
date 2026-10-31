import { describe, expect, it } from 'effect-rstest';
import { foldSearchText, matchesSearch } from '../../src/search-text.ts';

describe('Picker and list search', () => {
  it('folds diacritics and case', () => {
    expect(foldSearchText('Zálohování')).toBe('zalohovani');
    expect(foldSearchText('Příležitost ŘEŠENÍ')).toBe('prilezitost reseni');
  });

  it('matches without diacritics and case', () => {
    expect(matchesSearch('Šumper s.r.o. · IČO 12345678', 'sumper')).toBe(true);
    expect(matchesSearch('Šumper s.r.o. · IČO 12345678', 'ŠUMPER')).toBe(true);
    expect(matchesSearch('Kancelářský balík', 'kancelarsky')).toBe(true);
    expect(matchesSearch('Velká zakázka', 'velka')).toBe(true);
    expect(matchesSearch('Šumper s.r.o.', 'nemesis')).toBe(false);
  });

  it('treats a blank query as matching everything', () => {
    expect(matchesSearch('Šumper s.r.o.', '  ')).toBe(true);
  });
});
