/** URL-safe ASCII slug: „Etiopie Yirgacheffe – 250 g“ → „etiopie-yirgacheffe-250-g“. */
export const slugify = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 90) || 'produkt';

const fold = (value: string): string => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/** Artwork key of a category name (coffee, tea, gear). */
export const categoryArtKey = (name: string): string => {
  const text = fold(name);
  if (/darkov|dark|sada|box/u.test(text)) return 'kategorie-darky';
  if (/caj|tea|matcha|bylin/u.test(text)) return 'kategorie-caj';
  if (/mlet/u.test(text) && /kav/u.test(text)) return 'kategorie-mleta';
  if (/kav|coffee|espresso|zrn/u.test(text) && !/prisl|priprav|nacin|vybav|pomuck/u.test(text)) return 'kategorie-kava';
  return 'kategorie-vybaveni';
};

const czk = new Intl.NumberFormat('cs-CZ', { currency: 'CZK', maximumFractionDigits: 2, minimumFractionDigits: 2, style: 'currency' });
const czkWhole = new Intl.NumberFormat('cs-CZ', { currency: 'CZK', maximumFractionDigits: 0, style: 'currency' });

/** Exact owner amount in CZK; whole crowns without decimals only when the amount has no haléře. */
export const formatCzk = (minor: number): string => (minor % 100 === 0 ? czkWhole.format(minor / 100) : czk.format(minor / 100));

export const formatDateTime = (iso: string): string =>
  new Intl.DateTimeFormat('cs-CZ', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(iso));

/** Czech plural: 1 položka, 2–4 položky, 5+ položek. */
export const plural = (count: number, one: string, few: string, many: string): string =>
  count === 1 ? one : count >= 2 && count <= 4 ? few : many;
