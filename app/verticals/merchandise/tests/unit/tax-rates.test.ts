// How Merchandise reads a company's VAT from its book of Tax rules (and from the migrated state until Tax takes over): the rate of a classification at an instant, the
// non-payer and undeclared regimes, the failures that make goods unsellable, the staff view of the rates, the
// 60-second reuse of Tax's answer, and the shared rule other modules apply to the staff records response.
import { randomUUID } from 'node:crypto';

import type { OperationalScope } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { vatRateAt } from '@app/shared-contracts/cz-vat-classifications';
import { DateTime, Effect, Option, Ref, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { TaxRuleRevisionIdSchema } from '../../shared/domain/merchandise-model.ts';
import { grossPriceOf } from '../../src/services/stock-levels.ts';
import {
  TaxRateSource,
  cachedTaxRateBook,
  decideTaxRates,
  freshTaxRateBook,
  pricesCompany,
  resolveVatRate,
  sellableRatesAt,
  taxRateViews,
} from '../../src/services/tax-rates.ts';
import type { CompanyTaxRates, TaxRateBook, TaxRatePeriod } from '../../src/services/tax-rates.ts';
import { TEST_SINCE, TEST_TAX_BOOK, testTaxBook } from '../support/tax-fixtures.ts';

const at = (iso: string) => DateTime.makeUnsafe(iso);
const NOW = at('2026-11-12T10:00:00.000Z');
const revision = (id: string) => TaxRuleRevisionIdSchema.make(id);

/** The standard rate moving from 21 to 23 at UTC midnight of 2027-01-01, the reduced one unchanged. */
const RATE_CHANGE = at('2027-01-01T00:00:00.000Z');
const changingBook: TaxRateBook = {
  fingerprint: 'test:changing',
  periods: [
    {
      code: 'cz.vat.standard',
      effectiveFrom: TEST_SINCE,
      effectiveTo: RATE_CHANGE,
      ratePercent: '21',
      taxRuleRevisionId: revision('standard-21'),
    },
    {
      code: 'cz.vat.standard',
      effectiveFrom: RATE_CHANGE,
      ratePercent: '23',
      taxRuleRevisionId: revision('standard-23'),
    },
    { code: 'cz.vat.reduced', effectiveFrom: TEST_SINCE, ratePercent: '12', taxRuleRevisionId: revision('reduced-12') },
  ],
  regime: 'VAT_PAYER',
};

it('a VAT payer sells at the rate in force and names the rule revision it came from', () => {
  expect(resolveVatRate(TEST_TAX_BOOK, 'cz.vat.standard', NOW)).toEqual({
    _tag: 'Rate',
    ratePercent: 21,
    taxRuleRevisionId: revision('revision-standard'),
  });
  expect(resolveVatRate(TEST_TAX_BOOK, 'cz.vat.reduced', NOW)).toEqual({
    _tag: 'Rate',
    ratePercent: 12,
    taxRuleRevisionId: revision('revision-reduced'),
  });
});

it('periods are half-open and change at UTC midnight', () => {
  const lastMoment = at('2026-12-31T23:59:59.999Z');
  expect(resolveVatRate(changingBook, 'cz.vat.standard', lastMoment)).toMatchObject({ ratePercent: 21 });
  expect(resolveVatRate(changingBook, 'cz.vat.standard', RATE_CHANGE)).toMatchObject({
    ratePercent: 23,
    taxRuleRevisionId: revision('standard-23'),
  });
  // Midnight in Prague (UTC+1 in winter) is still the old year in UTC: the old rate applies.
  expect(resolveVatRate(changingBook, 'cz.vat.standard', at('2026-12-31T23:30:00.000Z'))).toMatchObject({
    ratePercent: 21,
  });
  expect(sellableRatesAt(changingBook, RATE_CHANGE)).toEqual({ 'cz.vat.reduced': 12, 'cz.vat.standard': 23 });
});

it('a non-payer sells every classification at 0 % without a rule revision', () => {
  const nonPayer = testTaxBook({}, 'NON_PAYER');
  expect(resolveVatRate(nonPayer, 'cz.vat.standard', NOW)).toEqual({ _tag: 'Rate', ratePercent: 0 });
  expect(resolveVatRate(nonPayer, 'cz.vat.reduced', NOW)).toEqual({ _tag: 'Rate', ratePercent: 0 });
  expect(sellableRatesAt(nonPayer, NOW)).toEqual({ 'cz.vat.reduced': 0, 'cz.vat.standard': 0 });
  expect(taxRateViews(nonPayer, NOW)).toEqual([]);
});

it('fails closed: no regime, a missing rule, two rules at once or a fractional rate sell nothing', () => {
  expect(resolveVatRate(testTaxBook(undefined, 'NOT_DECLARED'), 'cz.vat.standard', NOW)).toEqual({
    _tag: 'NotSellable',
    reason: 'REGIME_NOT_DECLARED',
  });
  const standardOnly = testTaxBook({ standard: '21' });
  expect(resolveVatRate(standardOnly, 'cz.vat.reduced', NOW)).toEqual({ _tag: 'NotSellable', reason: 'NO_RULE' });
  expect(sellableRatesAt(standardOnly, NOW)).toEqual({ 'cz.vat.standard': 21 });
  // Before the first rule took effect there is no rate either.
  expect(resolveVatRate(TEST_TAX_BOOK, 'cz.vat.standard', at('1999-12-31T23:59:59.999Z'))).toEqual({
    _tag: 'NotSellable',
    reason: 'NO_RULE',
  });
  const overlapping: TaxRatePeriod = {
    code: 'cz.vat.standard',
    effectiveFrom: at('2026-01-01T00:00:00.000Z'),
    ratePercent: '20',
    taxRuleRevisionId: revision('standard-20'),
  };
  expect(
    resolveVatRate({ ...TEST_TAX_BOOK, periods: [...TEST_TAX_BOOK.periods, overlapping] }, 'cz.vat.standard', NOW),
  ).toEqual({ _tag: 'NotSellable', reason: 'RULE_CONFLICT' });
  expect(resolveVatRate(testTaxBook({ standard: '21.5' }), 'cz.vat.standard', NOW)).toEqual({
    _tag: 'NotSellable',
    reason: 'NOT_INTEGER',
  });
});

it('staff see the current and scheduled rates of a payer, ended ones dropped, standard first', () => {
  expect(taxRateViews(changingBook, NOW)).toEqual([
    { code: 'cz.vat.standard', effectiveFrom: TEST_SINCE, effectiveTo: RATE_CHANGE, ratePercent: 21 },
    { code: 'cz.vat.standard', effectiveFrom: RATE_CHANGE, ratePercent: 23 },
    { code: 'cz.vat.reduced', effectiveFrom: TEST_SINCE, ratePercent: 12 },
  ]);
  expect(taxRateViews(changingBook, at('2027-03-01T00:00:00.000Z'))).toEqual([
    { code: 'cz.vat.standard', effectiveFrom: RATE_CHANGE, ratePercent: 23 },
    { code: 'cz.vat.reduced', effectiveFrom: TEST_SINCE, ratePercent: 12 },
  ]);
});

it('other modules apply the same rule to the staff response', () => {
  const views = taxRateViews(changingBook, NOW);
  const payer = { sellerVatRegime: 'VAT_PAYER' as const, taxRates: views };
  expect(vatRateAt(payer, 'cz.vat.standard', NOW)).toBe(21);
  expect(vatRateAt(payer, 'cz.vat.standard', RATE_CHANGE)).toBe(23);
  expect(vatRateAt(payer, 'cz.vat.reduced', NOW)).toBe(12);
  expect(vatRateAt(payer, undefined, NOW)).toBeUndefined();
  expect(vatRateAt({ sellerVatRegime: 'VAT_PAYER', taxRates: [] }, 'cz.vat.standard', NOW)).toBeUndefined();
  expect(vatRateAt({ sellerVatRegime: 'NON_PAYER', taxRates: [] }, 'cz.vat.reduced', NOW)).toBe(0);
  expect(vatRateAt({ sellerVatRegime: null, taxRates: views }, 'cz.vat.standard', NOW)).toBeUndefined();
  expect(vatRateAt({}, 'cz.vat.standard', NOW)).toBeUndefined();
});

it('a stored gross price is the price; it is derived from the net only when nothing is stored', () => {
  // As on stage: off by one, off by a lot, and 0 beside a net price. A rate never moves any of them.
  expect(grossPriceOf({ grossPriceMinor: 1211 }, 1000, 21)).toBe(1211);
  expect(grossPriceOf({ grossPriceMinor: 1_062_380 }, 1_878_000, 21)).toBe(1_062_380);
  expect(grossPriceOf({ grossPriceMinor: 0 }, 500, 21)).toBe(0);
  // The first tier wins over the stored gross; with nothing stored the net gets VAT at the rate given.
  expect(
    grossPriceOf(
      { grossPriceMinor: 999, priceTiers: [{ minimumQuantity: 1, priceExcludingVatMinor: 1000, priceMinor: 1210 }] },
      1000,
      21,
    ),
  ).toBe(1210);
  expect(grossPriceOf({}, 49_000, 12)).toBe(54_880);
  // A classification without a rule has no rate: nothing stored, no price, never one at 0 %.
  const noRule = sellableRatesAt(testTaxBook({}), NOW)['cz.vat.standard'];
  expect(grossPriceOf({}, 49_000, noRule)).toBeUndefined();
});

const scopeOf = (tenantId: string): OperationalScope => ({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: randomUUID(),
    authContextRef: 'session:tax-rate-cache',
    authMethod: 'session',
    legalEntityId: randomUUID(),
    principalId: randomUUID(),
    tenantId,
  }),
  correlationId: 'tax-rate-cache',
});

it.effect('reuses Tax answer for 60 seconds per company and asks again afterwards', () =>
  Effect.gen(function* cacheWindow() {
    const calls = yield* Ref.make(0);
    const source = { read: () => Ref.update(calls, (count) => count + 1).pipe(Effect.as(TEST_TAX_BOOK)) };
    const company = scopeOf(randomUUID());
    const other = scopeOf(randomUUID());
    const read = (scope: OperationalScope) =>
      cachedTaxRateBook(scope).pipe(Effect.provideService(TaxRateSource, source));
    expect(yield* read(company)).toEqual(TEST_TAX_BOOK);
    yield* TestClock.adjust('59 seconds');
    yield* read(company);
    expect(yield* Ref.get(calls)).toBe(1);
    // Another company has its own entry.
    yield* read(other);
    expect(yield* Ref.get(calls)).toBe(2);
    yield* TestClock.adjust('1 second');
    yield* read(company);
    expect(yield* Ref.get(calls)).toBe(3);
    // A placement always asks Tax and refreshes the entry the next cached read uses.
    yield* freshTaxRateBook(company).pipe(Effect.provideService(TaxRateSource, source));
    yield* read(company);
    expect(yield* Ref.get(calls)).toBe(4);
  }),
);

const MIGRATED: CompanyTaxRates = {
  book: {
    fingerprint: 'migration:cz.vat.standard=21;cz.vat.reduced=12',
    periods: [
      { code: 'cz.vat.standard', effectiveFrom: at('1970-01-01T00:00:00.000Z'), ratePercent: '21' },
      { code: 'cz.vat.reduced', effectiveFrom: at('1970-01-01T00:00:00.000Z'), ratePercent: '12' },
    ],
    regime: 'VAT_PAYER',
  },
  heldProductRates: { 'book-it': 10 },
  source: 'MIGRATION',
  syncedAt: at('2026-11-12T00:00:00.000Z'),
};
const CONFIRMED: CompanyTaxRates = { book: TEST_TAX_BOOK, source: 'TAX', syncedAt: NOW };

it('the migrated state keeps selling until Tax prices the company, and holds BOOK-IT at its stored 10 %', () => {
  // Tax not installed, unreachable, or installed without a regime or without every rule yet: the stored rates serve.
  for (const answer of [undefined, testTaxBook(undefined, 'NOT_DECLARED'), testTaxBook({ standard: '21' })]) {
    expect(decideTaxRates(MIGRATED, answer, false, NOW)).toEqual({ book: MIGRATED.book, held: { 'book-it': 10 } });
  }
  expect(decideTaxRates(MIGRATED, undefined, true, NOW)).toEqual({ book: MIGRATED.book, held: { 'book-it': 10 } });
  // The migrated periods name no Tax rule: lines sell at 21 / 12 % without a rule revision.
  expect(resolveVatRate(MIGRATED.book, 'cz.vat.reduced', NOW)).toEqual({ _tag: 'Rate', ratePercent: 12 });
  // Tax's first answer that prices the company replaces it, held rates included.
  expect(decideTaxRates(MIGRATED, TEST_TAX_BOOK, false, NOW)).toEqual({
    book: TEST_TAX_BOOK,
    held: {},
    materialise: { book: TEST_TAX_BOOK, source: 'TAX', syncedAt: NOW },
  });
  const nonPayer = testTaxBook({}, 'NON_PAYER');
  expect(decideTaxRates(MIGRATED, nonPayer, false, NOW).materialise?.book).toBe(nonPayer);
});

it('once Tax is in charge its answer rules: a gap fails closed, an outage keeps Tax last answer', () => {
  expect(decideTaxRates(CONFIRMED, TEST_TAX_BOOK, false, NOW)).toEqual({ book: TEST_TAX_BOOK, held: {} });
  const standardOnly = testTaxBook({ standard: '21' });
  const gap = decideTaxRates(CONFIRMED, standardOnly, false, NOW);
  expect(gap.book).toBe(standardOnly);
  expect(gap.materialise?.source).toBe('TAX');
  expect(resolveVatRate(standardOnly, 'cz.vat.reduced', NOW)).toEqual({ _tag: 'NotSellable', reason: 'NO_RULE' });
  // Tax unreachable: its last answer (dated periods, scheduled changes included) keeps serving.
  expect(decideTaxRates(CONFIRMED, undefined, false, NOW)).toEqual({ book: TEST_TAX_BOOK, held: {} });
  // Tax refusing a company it was in charge of: nothing is sellable.
  expect(decideTaxRates(CONFIRMED, undefined, true, NOW)).toEqual({ held: {} });
  // A company that never had rates takes whatever Tax answers.
  expect(decideTaxRates(undefined, standardOnly, false, NOW).materialise?.book).toBe(standardOnly);
  expect(decideTaxRates(undefined, undefined, true, NOW)).toEqual({ held: {} });
});

it('prices the company only with a non-payer regime or a usable rate for every classification', () => {
  expect(pricesCompany(TEST_TAX_BOOK, NOW)).toBe(true);
  expect(pricesCompany(testTaxBook({}, 'NON_PAYER'), NOW)).toBe(true);
  expect(pricesCompany(testTaxBook({ standard: '21' }), NOW)).toBe(false);
  expect(pricesCompany(testTaxBook(undefined, 'NOT_DECLARED'), NOW)).toBe(false);
});

/** The instant a Czech calendar day starts (Prague midnight), as Finance turns an issue date into Tax's instant. */
const pragueMidnight = (year: number, month: number, day: number) =>
  Option.getOrThrow(
    DateTime.makeZoned(
      { day, hour: 0, millisecond: 0, minute: 0, month, second: 0, year },
      { adjustForTimeZone: true, timeZone: 'Europe/Prague' },
    ).pipe(Option.map(DateTime.toUtc)),
  );
const ruleFrom = (start: DateTime.Utc, ratePercent: string): TaxRateBook => ({
  fingerprint: `test:from-${DateTime.formatIso(start)}`,
  periods: [
    {
      code: 'cz.vat.standard',
      effectiveFrom: TEST_SINCE,
      effectiveTo: start,
      ratePercent: '21',
      taxRuleRevisionId: revision('standard-21'),
    },
    { code: 'cz.vat.standard', effectiveFrom: start, ratePercent, taxRuleRevisionId: revision('standard-new') },
  ],
  regime: 'VAT_PAYER',
});

it('a rule starting at Prague midnight applies from that Czech day, in winter and across a DST change', () => {
  // 1 January 2027 (CET, UTC+1): the day starts at 23:00 UTC the evening before.
  const newYear = pragueMidnight(2027, 1, 1);
  expect(DateTime.formatIso(newYear)).toBe('2026-12-31T23:00:00.000Z');
  const winter = ruleFrom(newYear, '23');
  expect(resolveVatRate(winter, 'cz.vat.standard', DateTime.subtract(newYear, { milliseconds: 1 }))).toMatchObject({
    ratePercent: 21,
  });
  expect(resolveVatRate(winter, 'cz.vat.standard', newYear)).toMatchObject({ ratePercent: 23 });
  // 29 March 2027, the day after clocks go forward (CEST, UTC+2): the day starts at 22:00 UTC.
  const afterSwitch = pragueMidnight(2027, 3, 29);
  expect(DateTime.formatIso(afterSwitch)).toBe('2027-03-28T22:00:00.000Z');
  const summer = ruleFrom(afterSwitch, '23');
  // 23:30 UTC on 28 March is already 29 March in Prague: the new rate; an hour earlier it is still 28 March.
  expect(resolveVatRate(summer, 'cz.vat.standard', at('2027-03-28T23:30:00.000Z'))).toMatchObject({ ratePercent: 23 });
  expect(resolveVatRate(summer, 'cz.vat.standard', at('2027-03-28T21:30:00.000Z'))).toMatchObject({ ratePercent: 21 });
  // A whole Czech day of 23 hours (28 March) keeps the old rate up to its last millisecond.
  expect(resolveVatRate(summer, 'cz.vat.standard', DateTime.subtract(afterSwitch, { milliseconds: 1 }))).toMatchObject({
    ratePercent: 21,
  });
});
