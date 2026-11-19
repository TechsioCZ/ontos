import { Option, Result, Schema } from 'effect';
import type { SupportedLanguage } from './vocabulary.ts';

/**
 * Owner-published business values as the generic template path accepts them (L-06). The union is closed on purpose: a
 * secret-bearing value (OTP, reset token, claim URL) has no member here, so it cannot enter the generic path by type,
 * and a decoded object with any other `kind` is refused. Values are carried exactly as the owner published them;
 * formatting is a presentation of the same value and never a computation on it.
 */
export const GenericValueSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('text'), value: Schema.String }),
  /** An exact decimal amount as text, and the currency code of the owner: no number, no rounding, no conversion. */
  Schema.Struct({ amount: Schema.String, currency: Schema.String, kind: Schema.Literal('money') }),
  /** A calendar date `YYYY-MM-DD`, shown as that same date in no time zone. */
  Schema.Struct({ kind: Schema.Literal('date'), value: Schema.String }),
  /** A link checked against the owner's link policy before it is shown. */
  Schema.Struct({ kind: Schema.Literal('link'), url: Schema.String }),
]);
export type GenericValue = typeof GenericValueSchema.Type;

export type ValueFailure = 'value_malformed';
const malformed = Result.fail<ValueFailure>('value_malformed');

const MAX_TEXT = 500;
// Controls (C0, DEL, C1), line and paragraph separators, and every invisible format character (Unicode category Cf):
// soft hyphen, zero-width space, joiners, bidirectional marks and isolates, word joiner and invisible operators, the
// byte-order mark. They spoof, hide or break a message. No exception is made for the zero-width joiner and non-joiner:
// Czech and English text never needs them, and an exception would reopen the invisible-character gap.
const forbiddenCharacter = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
// Braces are refused so no value can carry a placeholder token that a later owner step would complete.
const placeholderBrace = /\{\{|\}\}/u;

/** A single-line, well-formed Unicode text in canonical (NFC) form; empty, oversized or control-bearing text is refused. */
export const safeText = (value: string): Result.Result<string, ValueFailure> => {
  if (
    value.length === 0 ||
    value.length > MAX_TEXT ||
    !value.isWellFormed() ||
    forbiddenCharacter.test(value) ||
    placeholderBrace.test(value)
  ) {
    return malformed;
  }
  const normal = value.normalize('NFC');
  return normal.trim() === normal ? Result.succeed(normal) : malformed;
};

const decimal = /^(?<sign>-?)(?<integer>0|[1-9][0-9]{0,14})(?:\.(?<fraction>[0-9]{1,6}))?$/u;
const currencyCode = /^[A-Z]{3}$/u;
const NO_BREAK_SPACE = '\u00A0';

const groupDigits = (digits: string, separator: string) => digits.replaceAll(/\B(?=(?:[0-9]{3})+$)/gu, separator);

/**
 * Presentation of an exact amount: only separators and the position of the currency code differ by language. Every
 * digit, the sign and the currency code are the owner's; none is added, dropped, rounded or converted.
 */
export const formatMoney = (
  amount: string,
  currency: string,
  language: SupportedLanguage,
): Result.Result<string, ValueFailure> => {
  const parts = decimal.exec(amount)?.groups;
  if (parts === undefined || !currencyCode.test(currency)) {
    return malformed;
  }
  const { fraction, integer = '', sign = '' } = parts;
  const [thousands, point] = language === 'cs' ? [NO_BREAK_SPACE, ','] : [',', '.'];
  const decimals = fraction === undefined ? '' : point + fraction;
  return Result.succeed(`${sign}${groupDigits(integer, thousands)}${decimals}${NO_BREAK_SPACE}${currency}`);
};

const englishMonths = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;
const isoDate = /^(?<year>[0-9]{4})-(?<month>[0-9]{2})-(?<day>[0-9]{2})$/u;

const isLeapYear = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
const daysInMonth = (year: number, month: number) => {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

/** A real calendar date shown in the local order; no time zone and no `today` is ever involved. */
export const formatDate = (value: string, language: SupportedLanguage): Result.Result<string, ValueFailure> => {
  const parts = isoDate.exec(value)?.groups;
  if (parts === undefined) {
    return malformed;
  }
  const year = Number(parts['year']);
  const month = Number(parts['month']);
  const day = Number(parts['day']);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return malformed;
  }
  const monthName = englishMonths[month - 1] ?? '';
  return Result.succeed(language === 'cs' ? `${day}. ${month}. ${year}` : `${day} ${monthName} ${year}`);
};

const shownAmount = /^(?<number>-?[0-9][0-9\u00A0,.]*)\u00A0[A-Z]{3}$/u;
/** The digits and sign of an amount as shown, used to prove that formatting changed no digit. */
export const amountDigits = (shown: string): Option.Option<string> =>
  Option.fromNullishOr(shownAmount.exec(shown)?.groups?.['number']).pipe(
    Option.map((number) => number.replaceAll(/[\u00A0,.]/gu, '')),
  );
