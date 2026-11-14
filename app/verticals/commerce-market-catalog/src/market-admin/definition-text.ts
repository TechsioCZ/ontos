// Texts of a market definition in the screen language: validity and territories, never raw keys.
import { DateTime } from 'effect';
import type { EffectivePeriod } from '../../shared/market-contracts.ts';

/** A calendar date in Prague time; `locale` is the screen's `dateLocale` resource. */
export const formatDay = (instant: DateTime.Utc, locale: string): string =>
  new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeZone: 'Europe/Prague',
  }).format(DateTime.toEpochMillis(instant));

type Text = (path: string, values?: Record<string, string | number>) => string;

/** "od 1. 11. 2026, bez omezení" / "od … do …". */
export const definitionPeriodText = (definition: { readonly effectivePeriod: EffectivePeriod }, text: Text): string => {
  const { endsAt, startsAt } = definition.effectivePeriod;
  const locale = text('dateLocale');
  const from = formatDay(startsAt, locale);
  return endsAt === undefined
    ? text('detail.periodOpen', { from })
    : text('detail.periodBounded', { from, to: formatDay(endsAt, locale) });
};
