const plurals = new Intl.PluralRules('cs-CZ');

export const contactCountLabel = (count: number): string => {
  const form = plurals.select(count);
  const label = form === 'one' ? 'kontaktní osoba' : form === 'few' ? 'kontaktní osoby' : 'kontaktních osob';
  return `${count} ${label}`;
};
