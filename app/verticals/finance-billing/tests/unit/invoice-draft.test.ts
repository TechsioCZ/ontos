import { describe, expect, it } from 'effect-rstest';
import type { VatChoices } from '../../shared/apis/vat-choices.ts';
import {
  addCalendarDays,
  czkToMinor,
  draftTotals as draftTotalsOn,
  isPlausibleIssueDate,
  lineIssue as lineIssueOn,
  lineValueIssue,
  newDraftLine as newDraftLineWith,
  toInvoiceLine as toInvoiceLineOn,
  withProductSnapshot,
} from '../../shared/domain/invoice-draft.ts';
import type { DraftLine, DraftLineKind } from '../../shared/domain/invoice-draft.ts';
import { baselineVatChoices, standardLineVat, testTaxRuleRevisionRef } from '../support/finance-tax-rates.ts';

const TENANT = '00000000-0000-4000-8000-0000000000aa';
const baseline = baselineVatChoices(TENANT, '2026-10-05');
const standard = standardLineVat(TENANT);
// The form's standard-rate line, priced from the company's baseline Tax rates on the issue date.
const newDraftLine = (key: string, kind: DraftLineKind) =>
  newDraftLineWith(key, kind, { code: 'cz.vat.standard', kind: 'classification' });
const toInvoiceLine = (line: DraftLine) => toInvoiceLineOn(line, baseline);
const lineIssue = (line: DraftLine) => lineIssueOn(line, baseline, 'OUTGOING');
const draftTotals = (lines: readonly DraftLine[]) => draftTotalsOn(lines, baseline, 'OUTGOING');

describe('Invoice create form lines', () => {
  it('snapshots the product name, price and VAT classification when the product is picked', () => {
    const product = {
      currentPriceMinor: 129_000,
      id: 'p-1',
      name: 'Konzultace',
      taxClassificationCode: 'cz.vat.standard' as const,
    };
    const line = withProductSnapshot({ ...newDraftLine('line-1', 'product'), quantity: 2 }, product);

    expect(toInvoiceLine(line)).toEqual({
      ...standard,
      description: 'Konzultace',
      productId: 'p-1',
      quantity: 2,
      unitPriceMinor: 129_000,
    });
    expect(lineIssue(newDraftLine('line-2', 'product'))).toBe('product');
  });

  it('validates free-text lines and totals only the complete ones', () => {
    const free = {
      ...newDraftLine('line-3', 'free'),
      description: '  Školení ',
      unitPriceMinor: czkToMinor(1000.5),
    };
    const incomplete = newDraftLine('line-4', 'product');
    const product = withProductSnapshot(
      { ...newDraftLine('line-5', 'product'), quantity: 2 },
      {
        currentPriceMinor: 129_000,
        id: 'p-1',
        name: 'Konzultace',
        taxClassificationCode: 'cz.vat.standard',
      },
    );

    expect(lineIssue(newDraftLine('line-6', 'free'))).toBe('description');
    expect(lineIssue({ ...free, quantity: 0 })).toBe('quantity');
    expect(lineIssue({ ...free, quantity: 2.25 })).toBe('quantity');
    expect(lineIssue({ ...free, quantity: 1_000_000 })).toBeUndefined();
    expect(lineIssue({ ...free, quantity: 999_999_999 })).toBe('quantity');
    expect(lineIssue({ ...free, unitPriceMinor: -1 })).toBe('price');
    expect(toInvoiceLine(free)).toEqual({
      ...standard,
      description: 'Školení',
      quantity: 1,
      unitPriceMinor: 100_050,
    });
    // Product 258 000 at 21 % → VAT 54 180; free 100 050 at 21 % → VAT 21 011; the incomplete line is skipped.
    expect(draftTotals([product, free, incomplete])).toEqual({
      subtotalMinor: 358_050,
      totalMinor: 433_241,
      vatMinor: 75_191,
    });
  });

  it('creates a descriptive rent line without a catalog identity and keeps an exempt supply at 0 %', () => {
    const rent: DraftLine = {
      ...newDraftLine('rent-line', 'free'),
      description: '  Nájem budovy Parková, jednotka A101, říjen 2026  ',
      unitPriceMinor: 1_800_000,
      vat: { kind: 'treatment', treatment: 'EXEMPT' },
    };

    expect(lineIssue(rent)).toBeUndefined();
    expect(toInvoiceLine(rent)).toEqual({
      description: 'Nájem budovy Parková, jednotka A101, říjen 2026',
      quantity: 1,
      unitPriceMinor: 1_800_000,
      vatRate: 0,
      vatTreatment: 'EXEMPT',
    });
    expect(draftTotals([rent])).toEqual({ subtotalMinor: 1_800_000, totalMinor: 1_800_000, vatMinor: 0 });
    expect(draftTotals([{ ...rent, vat: { code: 'cz.vat.standard', kind: 'classification' } }])).toEqual({
      subtotalMinor: 1_800_000,
      totalMinor: 2_178_000,
      vatMinor: 378_000,
    });
  });

  it('converts a decimal CZK price to haléře and reports a price that is not a number', () => {
    expect(czkToMinor(1234.5)).toBe(123_450);
    expect(Number.isNaN(czkToMinor(Number.NaN))).toBe(true);
    const free = { ...newDraftLine('line-7', 'free'), description: 'Oprava' };
    expect(lineIssue({ ...free, unitPriceMinor: czkToMinor(Number.NaN) })).toBe('price');
    expect(lineIssue({ ...free, unitPriceMinor: czkToMinor(Number.POSITIVE_INFINITY) })).toBe('price');
  });

  it('totals 3 × 1 234,50 Kč at 21 % VAT exactly as the backend stores it', () => {
    const free = {
      ...newDraftLine('line-8', 'free'),
      description: 'خدمة صيانة',
      quantity: 3,
      unitPriceMinor: czkToMinor(1234.5),
    };
    // Base 370 350; VAT 77 773,5 rounds half-up to 77 774.
    expect(draftTotals([free])).toEqual({ subtotalMinor: 370_350, totalMinor: 448_124, vatMinor: 77_774 });
  });

  it('flags a line amount or invoice sum past the money range instead of totalling it as 0 Kč', () => {
    // 1 000 000 × 10 000 000 Kč is a valid quantity and price, but the line base is far past 10 miliard Kč.
    const huge = {
      ...newDraftLine('line-9', 'free'),
      description: 'Stavba',
      quantity: 1_000_000,
      unitPriceMinor: czkToMinor(10_000_000),
    };
    expect(lineIssue(huge)).toBe('amount');
    expect(draftTotals([huge])).toEqual({ subtotalMinor: 0, totalMinor: 0, vatMinor: 0 });

    // 8 miliard Kč per line fits, but two such lines with VAT pass the range together.
    const large = { ...huge, quantity: 1, unitPriceMinor: czkToMinor(8_000_000_000) };
    expect(lineIssue(large)).toBeUndefined();
    expect(draftTotals([large])).toBeDefined();
    expect(draftTotals([large, { ...large, key: 'line-10' }])).toBeUndefined();
  });

  it('reports mistyped numbers on a fresh line, but not the missing product or description', () => {
    const fresh = newDraftLine('line-11', 'product');
    expect(lineIssue(fresh)).toBe('product');
    expect(lineValueIssue(fresh)).toBeUndefined();
    expect(lineValueIssue({ ...fresh, quantity: 2.25 })).toBe('quantity');
    expect(lineValueIssue({ ...fresh, quantity: Number.NaN })).toBe('quantity');
    expect(lineValueIssue({ ...newDraftLine('line-12', 'free'), unitPriceMinor: Number.NaN })).toBe('price');
  });

  it('adds payment terms to the issue date like the backend does', () => {
    expect(addCalendarDays('2026-10-05', 14)).toBe('2026-10-19');
    expect(addCalendarDays('2026-10-05', 30)).toBe('2026-11-04');
  });

  it('returns no due date for a half-typed issue date instead of throwing during render', () => {
    // A native date input passes through a 5-digit year while the user types it.
    expect(addCalendarDays('10000-10-05', 14)).toBeUndefined();
    expect(addCalendarDays('20261-10-05', 14)).toBeUndefined();
  });

  it('accepts only real issue dates in the business years, so a mistyped year is rejected', () => {
    expect(isPlausibleIssueDate('2026-10-05')).toBe(true);
    expect(isPlausibleIssueDate('0001-01-15')).toBe(false);
    expect(isPlausibleIssueDate('2101-01-01')).toBe(false);
    expect(isPlausibleIssueDate('')).toBe(false);
  });

  it('takes the classification rate and revision from Tax and holds the line back while Tax has no rate', () => {
    const reduced: DraftLine = {
      ...newDraftLine('line-13', 'free'),
      description: 'Ubytování',
      unitPriceMinor: 100_000,
      vat: { code: 'cz.vat.reduced', kind: 'classification' },
    };
    expect(toInvoiceLine(reduced)).toMatchObject({
      taxRuleRevisionRef: testTaxRuleRevisionRef(TENANT, 'cz.vat.reduced'),
      vatClassification: 'cz.vat.reduced',
      vatRate: 12,
    });
    // A revision Tax scheduled for the issue date wins over the baseline.
    const raised: VatChoices = {
      ...baseline,
      rates: baseline.rates.map((rate) => (rate.code === 'cz.vat.reduced' ? { ...rate, ratePercent: 15 } : rate)),
    };
    expect(toInvoiceLineOn(reduced, raised)?.vatRate).toBe(15);
    expect(toInvoiceLineOn(reduced, { ...baseline, rates: [] })).toBeUndefined();
    expect(lineIssueOn(reduced, undefined, 'OUTGOING')).toBe('vat');
    expect(lineIssueOn(reduced, { ...baseline, rates: [] }, 'OUTGOING')).toBe('vat');
  });

  it('lets a company that is not a VAT payer issue only non-payer lines, and its suppliers anything', () => {
    const nonPayer: VatChoices = { ...baseline, regime: 'NON_PAYER' };
    const classified: DraftLine = { ...newDraftLine('line-14', 'free'), description: 'Služba', unitPriceMinor: 100 };
    const withoutVat: DraftLine = { ...classified, vat: { kind: 'treatment', treatment: 'NON_PAYER' } };
    expect(lineIssueOn(classified, nonPayer, 'OUTGOING')).toBe('vat');
    expect(lineIssueOn(withoutVat, nonPayer, 'OUTGOING')).toBeUndefined();
    expect(lineIssueOn(withoutVat, baseline, 'OUTGOING')).toBe('vat');
    expect(lineIssueOn(withoutVat, baseline, 'INCOMING')).toBeUndefined();
    expect(lineIssueOn(classified, nonPayer, 'INCOMING')).toBeUndefined();
  });

  it('takes the product classification, whose rate Tax gives at the issue date', () => {
    // BOOK-IT was entered at 10 %; Merchandise classifies it reduced, so the invoice line takes Tax's reduced rate.
    const reduced = withProductSnapshot(newDraftLine('line-15', 'product'), {
      currentPriceMinor: 49_000,
      id: 'book-it',
      name: 'Příručka IT bezpečnosti',
      taxClassificationCode: 'cz.vat.reduced',
    });
    expect(reduced.vat).toEqual({ code: 'cz.vat.reduced', kind: 'classification' });
    expect(toInvoiceLine(reduced)).toMatchObject({
      unitPriceMinor: 49_000,
      vatClassification: 'cz.vat.reduced',
      vatRate: 12,
    });
    // A product without a classification (never on a staff read) keeps the VAT the line already had.
    const unclassified = withProductSnapshot(newDraftLine('line-16', 'product'), {
      currentPriceMinor: 10_000,
      id: 'p-3',
      name: 'Kniha',
    });
    expect(unclassified.vat).toEqual({ code: 'cz.vat.standard', kind: 'classification' });
  });
});
