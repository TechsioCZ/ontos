// A company's own VAT lines need a declared VAT regime: without one the company is not ready (never assumed to be a
// payer) and new VAT lines are refused; stored lines and supplier invoices are untouched. And the Czech calendar day
// Finance asks Tax about starts at Prague midnight, in winter and across a DST change, exactly as Merchandise reads
// a rule that starts that day.
import { DateTime, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  allowedTreatments,
  classificationsAllowed,
  lineVatIssue,
  pragueDayStart,
  regimeReady,
} from '../../shared/domain/line-vat.ts';
import { InvoiceLineSchema } from '../../shared/apis/records.ts';
import { baselineVatChoices, standardLineVat } from '../support/finance-tax-rates.ts';

const TENANT = '20000000-0000-4000-8000-000000000001';
const undeclared = baselineVatChoices(TENANT, '2026-11-12', 'NOT_DECLARED');
const payer = baselineVatChoices(TENANT, '2026-11-12');
/** Invoice lines as Finance stores them: a standard-rate line, and lines with an explicit treatment. */
const lineOf = (
  vat: ReturnType<typeof standardLineVat> | { readonly vatRate: number; readonly vatTreatment: 'EXEMPT' | 'NON_PAYER' },
) =>
  Schema.decodeUnknownSync(InvoiceLineSchema)({
    description: 'Konzultace',
    quantity: 1,
    unitPriceMinor: 100_000,
    ...vat,
  });
const standardLine = lineOf(standardLineVat(TENANT));
const treatmentLine = (vatTreatment: 'EXEMPT' | 'NON_PAYER') => lineOf({ vatRate: 0, vatTreatment });

it('refuses new VAT lines of a company without a declared VAT regime and offers it nothing', () => {
  expect(regimeReady('OUTGOING', 'NOT_DECLARED')).toBe(false);
  expect(classificationsAllowed('OUTGOING', 'NOT_DECLARED')).toBe(false);
  expect(allowedTreatments('OUTGOING', 'NOT_DECLARED')).toEqual([]);
  expect(lineVatIssue(standardLine, undeclared, 'OUTGOING')).toBe('vat_regime_not_declared');
  expect(lineVatIssue(treatmentLine('EXEMPT'), undeclared, 'OUTGOING')).toBe('vat_regime_not_declared');
  // The same line is fine for a declared payer.
  expect(lineVatIssue(standardLine, payer, 'OUTGOING')).toBeUndefined();
});

it('leaves stored lines and supplier invoices alone', () => {
  expect(lineVatIssue(standardLine, undeclared, 'OUTGOING', true)).toBeUndefined();
  expect(lineVatIssue(standardLine, undeclared, 'INCOMING')).toBeUndefined();
  expect(classificationsAllowed('INCOMING', 'NOT_DECLARED')).toBe(true);
});

it('keeps the non-payer rule: a non-payer issues lines without VAT only', () => {
  const nonPayer = baselineVatChoices(TENANT, '2026-11-12', 'NON_PAYER');
  expect(allowedTreatments('OUTGOING', 'NON_PAYER')).toEqual(['NON_PAYER']);
  expect(lineVatIssue(treatmentLine('NON_PAYER'), nonPayer, 'OUTGOING')).toBeUndefined();
  expect(lineVatIssue(standardLine, nonPayer, 'OUTGOING')).toBe('vat_not_payer');
});

it('asks Tax about a Czech day at its Prague midnight, in winter and across a DST change', () => {
  // The same instants Merchandise's rate test resolves a rule starting that day at.
  expect(DateTime.formatIso(pragueDayStart('2027-01-01') ?? DateTime.makeUnsafe(0))).toBe('2026-12-31T23:00:00.000Z');
  expect(DateTime.formatIso(pragueDayStart('2027-03-29') ?? DateTime.makeUnsafe(0))).toBe('2027-03-28T22:00:00.000Z');
  // The DST day itself still starts at 23:00 UTC (CET) and lasts 23 hours.
  expect(DateTime.formatIso(pragueDayStart('2027-03-28') ?? DateTime.makeUnsafe(0))).toBe('2027-03-27T23:00:00.000Z');
  // The baseline seed's 1 January 2024 is Prague midnight.
  expect(DateTime.formatIso(pragueDayStart('2024-01-01') ?? DateTime.makeUnsafe(0))).toBe('2023-12-31T23:00:00.000Z');
});
