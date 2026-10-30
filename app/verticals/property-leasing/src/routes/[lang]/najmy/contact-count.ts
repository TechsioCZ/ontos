const plurals = new Intl.PluralRules('cs-CZ');

export const contactCountLabel = (count: number): string => {
  const form = plurals.select(count);
  const labels = { few: 'kontaktní osoby', one: 'kontaktní osoba', other: 'kontaktních osob' };
  const label = form === 'one' || form === 'few' ? labels[form] : labels.other;
  return `${count} ${label}`;
};
