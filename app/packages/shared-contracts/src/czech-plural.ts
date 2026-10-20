const plurals = new Intl.PluralRules('cs-CZ');
const numbers = new Intl.NumberFormat('cs-CZ');

/** Czech cardinal forms: 1 den, 2–4 dny, 0/5/21 dní; fractions use dne. */
export const czechPlural = (
  count: number,
  forms: { readonly one: string; readonly few: string; readonly many: string; readonly other: string },
): string => {
  const category = plurals.select(count);
  return category === 'one' || category === 'few' || category === 'many' ? forms[category] : forms.other;
};

export const formatCzechDays = (count: number): string =>
  `${numbers.format(count)} ${czechPlural(count, { one: 'den', few: 'dny', many: 'dne', other: 'dní' })}`;
