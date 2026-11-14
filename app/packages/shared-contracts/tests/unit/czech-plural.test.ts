import { Effect } from 'effect';
import { expect, it, rstest } from 'effect-rstest';
import { formatCzechDays } from '../../src/czech-plural.ts';

it.effect('constructs each formatter only on its first use, never while importing contracts', () =>
  Effect.gen(function* lazyCzechFormatters() {
    rstest.resetModules();
    const OriginalPluralRules = Intl.PluralRules;
    const OriginalNumberFormat = Intl.NumberFormat;
    const pluralRules = rstest
      .spyOn(Intl, 'PluralRules')
      .mockImplementation((locales, options) => new OriginalPluralRules(locales, options));
    const numberFormat = rstest
      .spyOn(Intl, 'NumberFormat')
      .mockImplementation((locales, options) => new OriginalNumberFormat(locales, options));
    const formatting = yield* Effect.promise(() => import('../../src/czech-plural.ts'));
    expect(pluralRules).not.toHaveBeenCalled();
    expect(numberFormat).not.toHaveBeenCalled();
    expect(formatting.czechPlural(2, { few: 'few', many: 'many', one: 'one', other: 'other' })).toBe('few');
    expect(pluralRules).toHaveBeenCalledTimes(1);
    expect(numberFormat).not.toHaveBeenCalled();
    expect(formatting.formatCzechDays(1)).toBe('1 den');
    expect(formatting.formatCzechDays(2)).toBe('2 dny');
    expect(pluralRules).toHaveBeenCalledTimes(1);
    expect(numberFormat).toHaveBeenCalledTimes(1);
  }).pipe(Effect.ensuring(Effect.sync(() => rstest.restoreAllMocks()))),
);

it('formats Czech day counts using cardinal rules, not the final digit', () => {
  for (const [count, expected] of [
    [0, '0 dní'],
    [1, '1 den'],
    [2, '2 dny'],
    [3, '3 dny'],
    [4, '4 dny'],
    [5, '5 dní'],
    [11, '11 dní'],
    [14, '14 dní'],
    [21, '21 dní'],
    [22, '22 dní'],
    [101, '101 dní'],
    [-1, '-1 den'],
    [1.5, '1,5 dne'],
  ] as const) {
    expect(formatCzechDays(count)).toBe(expected);
  }
});
