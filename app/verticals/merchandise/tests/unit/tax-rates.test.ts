// How Merchandise reads a company's VAT from its book of Tax rules: the rate of a classification at an instant, the
// non-payer and undeclared regimes, the failures that make goods unsellable, the staff view of the rates, the
// 60-second reuse of Tax's answer, and the shared rule other modules apply to the staff records response.
import { randomUUID } from 'node:crypto';

import type { OperationalScope } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { vatRateAt } from '@app/shared-contracts/cz-vat-classifications';
import { DateTime, Effect, Ref, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { TaxRuleRevisionIdSchema } from '../../shared/domain/merchandise-model.ts';
import { grossPriceOf } from '../../src/services/stock-levels.ts';
import {
  TaxRateSource,
  cachedTaxRateBook,
  freshTaxRateBook,
  resolveVatRate,
  sellableRatesAt,
  taxRateViews,
} from '../../src/services/tax-rates.ts';
import type { TaxRateBook, TaxRatePeriod } from '../../src/services/tax-rates.ts';
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
