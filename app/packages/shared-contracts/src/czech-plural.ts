import { memoize } from 'effect/Function';

const locale = Object.freeze({ language: 'cs-CZ' });
// Importing contracts must not initialize ICU formatters in owners that never render day counts.
const createPluralRules = ({ language }: typeof locale) => new Intl.PluralRules(language);
const createNumberFormat = ({ language }: typeof locale) => new Intl.NumberFormat(language);
const plurals = memoize(createPluralRules);
const numbers = memoize(createNumberFormat);

/** Czech cardinal forms: 1 den, 2–4 dny, 0/5/21 dní; fractions use dne. */
export const czechPlural = (
  count: number,
  forms: { readonly few: string; readonly many: string; readonly one: string; readonly other: string },
): string => {
  const category = plurals(locale).select(count);
  return category === 'one' || category === 'few' || category === 'many' ? forms[category] : forms.other;
};

export const formatCzechDays = (count: number): string =>
  `${numbers(locale).format(count)} ${czechPlural(count, { few: 'dny', many: 'dne', one: 'den', other: 'dní' })}`;
