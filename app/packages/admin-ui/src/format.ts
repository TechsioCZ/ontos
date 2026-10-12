/**
 * cs-CZ formatters for the Akros admin screens. Money arrives in minor units
 * (haléře for CZK). Whole amounts drop the decimals, others keep two. Missing
 * or invalid dates render as an em dash, and dates display in Prague time.
 */
import { DateTime, Option } from 'effect';

const locale = 'cs-CZ';
const timeZone = 'Europe/Prague';
const missing = '—';

const minorUnitDigits = (currency: string): number =>
  new Intl.NumberFormat('en', { currency, style: 'currency' }).resolvedOptions().maximumFractionDigits ?? 2;

/** Formats an amount stored in minor units: `123400` → `1 234 Kč`, `123450` → `1 234,50 Kč`. */
export const formatMoney = (minor: number, currency = 'CZK'): string => {
  const digits = minorUnitDigits(currency);
  const scale = 10 ** digits;
  const isWhole = minor % scale === 0;
  return new Intl.NumberFormat(locale, {
    currency,
    maximumFractionDigits: digits,
    minimumFractionDigits: isWhole ? 0 : digits,
    style: 'currency',
  }).format(minor / scale);
};

/** Epoch milliseconds for an ISO string, or null when it is missing or unparseable. */
const parseEpochMs = (iso: string | null | undefined): number | null => {
  if (iso === undefined || iso === null) {
    return null;
  }
  return Option.match(DateTime.make(iso), {
    onNone: () => null,
    onSome: DateTime.toEpochMillis,
  });
};

const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone });
const dateTimeFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone });

/** `2026-10-13` → `13. 10. 2026`. */
export const formatDate = (iso?: string | null): string => {
  const epochMs = parseEpochMs(iso);
  return epochMs === null ? missing : dateFormat.format(epochMs);
};

/** `2026-10-13T12:05:00Z` → `13. 10. 2026 14:05`. */
export const formatDateTime = (iso?: string | null): string => {
  const epochMs = parseEpochMs(iso);
  return epochMs === null ? missing : dateTimeFormat.format(epochMs);
};

const numberFormat = new Intl.NumberFormat(locale);

/** `1234567.5` → `1 234 567,5`. */
export const formatNumber = (value: number): string => numberFormat.format(value);

const percentFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 1, style: 'percent' });

/** Takes a ratio: `0.256` → `25,6 %`. */
export const formatPercent = (ratio: number): string => percentFormat.format(ratio);
