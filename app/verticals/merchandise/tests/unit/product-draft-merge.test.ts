// The three-way merge that rebases a refused product draft on the version someone else saved.
import { describe, expect, it } from 'effect-rstest';
import { mergeDraft, mergeKeyedDrafts } from '../../src/routes/[lang]/provoz/produkty/product-draft-merge.ts';

const variant = (key: string, attributes: string, priceText = '100') => ({
  attributes,
  flags: { isNew: false },
  key,
  priceText,
});

describe('product draft merge', () => {
  it('keeps the fields only the operator changed and takes every other field from the fresh version', () => {
    const base = { brand: '', seo: { title: '' }, weight: '' };
    expect(
      mergeDraft(base, { ...base, seo: { title: 'Šroub M8' } }, { ...base, brand: 'Akros', weight: '7' }),
    ).toEqual({ merged: { brand: 'Akros', seo: { title: 'Šroub M8' }, weight: '7' }, overlap: false });
  });

  it('reports the same field changed on both sides and keeps the operator value there', () => {
    const base = { brand: '', weight: '' };
    expect(mergeDraft(base, { brand: '', weight: '10' }, { brand: 'Akros', weight: '9' })).toEqual({
      merged: { brand: 'Akros', weight: '10' },
      overlap: true,
    });
  });

  it('merges identified variants one by one, keeps added ones and drops an untouched one removed elsewhere', () => {
    const base = [variant('a', ''), variant('b', ''), variant('c', '')];
    const mine = [variant('a', ''), variant('b', 'modrá'), variant('c', ''), variant('new-0', 'nová')];
    const theirs = [variant('a', 'červená'), variant('b', '', '120')];
    expect(mergeKeyedDrafts(base, mine, theirs)).toEqual({
      merged: [variant('a', 'červená'), variant('b', 'modrá', '120'), variant('new-0', 'nová')],
      overlap: false,
    });
  });

  it('keeps a variant the operator changed that someone else removed, as an overlap', () => {
    const base = [variant('a', ''), variant('b', '')];
    expect(mergeKeyedDrafts(base, [variant('a', ''), variant('b', 'modrá')], [variant('a', '')])).toEqual({
      merged: [variant('a', ''), variant('b', 'modrá')],
      overlap: true,
    });
  });
});
