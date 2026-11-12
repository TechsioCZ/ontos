// The VAT classification as staff see it: the rate in force now, the next scheduled one, a classification the company
// has no rule for, and a company Tax gives no rate at all. Labels come from the real Czech and English locales.
import { CZ_VAT_REDUCED, CZ_VAT_STANDARD, TaxRateViewSchema } from '@app/shared-contracts/cz-vat-classifications';
import type { TaxRateView } from '@app/shared-contracts/cz-vat-classifications';
import { DateTime, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import {
  choiceAvailable,
  classificationChoice,
  classificationChoices,
  companyVatOf,
  noTaxRates,
  rateAt,
  ratePercentText,
  scheduledRateAfter,
  taxLabelsOf,
} from '../../src/routes/[lang]/provoz/produkty/product-tax-classification.ts';
import type { CompanyVat } from '../../src/routes/[lang]/provoz/produkty/product-tax-classification.ts';
import { translateIn } from './merchandise-translate.ts';

const rate = Schema.decodeSync(TaxRateViewSchema);
const at = (iso: string) => DateTime.makeUnsafe(iso);
const now = at('2026-11-12T10:00:00Z');

const standardNow = rate({
  code: CZ_VAT_STANDARD,
  effectiveFrom: '2024-01-01T00:00:00Z',
  effectiveTo: '2027-01-01T00:00:00Z',
  ratePercent: 21,
});
const standardNext = rate({ code: CZ_VAT_STANDARD, effectiveFrom: '2027-01-01T00:00:00Z', ratePercent: 23 });
const reducedNow = rate({ code: CZ_VAT_REDUCED, effectiveFrom: '2024-01-01T00:00:00Z', ratePercent: 12 });

/** A VAT payer with these rates, as the staff records read gives them. */
const payerVat = (rates: readonly TaxRateView[]): CompanyVat => ({ rates, regime: 'VAT_PAYER' });
const nonPayerVat: CompanyVat = { rates: [], regime: 'NON_PAYER' };

const cs = taxLabelsOf(translateIn('cs'));
const en = taxLabelsOf(translateIn('en'));

describe('rates of a classification', () => {
  it('picks the period in force: from its start up to, not including, its end', () => {
    const rates = [standardNow, standardNext];
    expect(rateAt(payerVat(rates), CZ_VAT_STANDARD, now)?.ratePercent).toBe(21);
    expect(rateAt(payerVat(rates), CZ_VAT_STANDARD, at('2026-12-31T23:59:59Z'))?.ratePercent).toBe(21);
    expect(rateAt(payerVat(rates), CZ_VAT_STANDARD, at('2027-01-01T00:00:00Z'))?.ratePercent).toBe(23);
    expect(rateAt(payerVat(rates), CZ_VAT_STANDARD, at('2023-12-31T23:59:59Z'))).toBeUndefined();
    expect(rateAt(payerVat(rates), CZ_VAT_REDUCED, now)).toBeUndefined();
  });

  it('finds the earliest scheduled period after now', () => {
    const later = rate({ code: CZ_VAT_STANDARD, effectiveFrom: '2028-01-01T00:00:00Z', ratePercent: 25 });
    expect(scheduledRateAfter(payerVat([later, standardNow, standardNext]), CZ_VAT_STANDARD, now)?.ratePercent).toBe(
      23,
    );
    expect(scheduledRateAfter(payerVat([standardNow, reducedNow]), CZ_VAT_STANDARD, now)).toBeUndefined();
  });

  it('offers both classifications in order, each with its current and next rate', () => {
    const choices = classificationChoices(payerVat([reducedNow, standardNext, standardNow]), now);
    expect(choices.map((choice) => choice.code)).toEqual([CZ_VAT_STANDARD, CZ_VAT_REDUCED]);
    expect(choices.map((choice) => choice.current?.ratePercent)).toEqual([21, 12]);
    expect(choices.map((choice) => choice.scheduled?.ratePercent)).toEqual([23, undefined]);
    expect(choices.every(choiceAvailable)).toBe(true);
  });

  it('a classification without a rule cannot be chosen; one with only a scheduled rule can', () => {
    expect(choiceAvailable(classificationChoice(payerVat([standardNow]), CZ_VAT_REDUCED, now))).toBe(false);
    const startsLater = classificationChoice(payerVat([standardNext]), CZ_VAT_STANDARD, now);
    expect(startsLater.current).toBeUndefined();
    expect(choiceAvailable(startsLater)).toBe(true);
  });

  it('a company Tax gives no rate at all (no VAT payer, or no rule yet) has none', () => {
    expect(noTaxRates(payerVat([]))).toBe(true);
    expect(noTaxRates(payerVat([reducedNow]))).toBe(false);
  });
});

describe('labels', () => {
  it('names a classification with its current rate, a non-breaking space before the sign', () => {
    expect(ratePercentText(21)).toBe('21\u00A0%');
    expect(ratePercentText(10.5)).toBe('10,5\u00A0%');
    const choices = classificationChoices(payerVat([standardNow, reducedNow]), now);
    expect(choices.map(cs.choice)).toEqual(['Základní (21\u00A0%)', 'Snížená (12\u00A0%)']);
    expect(choices.map(en.choice)).toEqual(['Standard (21\u00A0%)', 'Reduced (12\u00A0%)']);
  });

  it('says "není nastaveno" instead of a number when no rate is in force', () => {
    const missing = classificationChoice(payerVat([standardNow]), CZ_VAT_REDUCED, now);
    expect(cs.choice(missing)).toBe('Snížená (není nastaveno)');
    expect(en.choice(missing)).toBe('Reduced (not set)');
    expect(cs.noRates).toBe('Pro tuto firmu není nastavená žádná sazba DPH.');
    expect(cs.rateMissing(CZ_VAT_REDUCED)).toBe(
      'Sazba DPH „Snížená“ není pro tuto firmu nastavená, produkt nelze přidat.',
    );
  });

  it('hints a scheduled change with its date and rate', () => {
    const choice = classificationChoice(payerVat([standardNow, standardNext]), CZ_VAT_STANDARD, now);
    expect(cs.scheduled(choice)).toBe('Od 1. 1. 2027 23\u00A0%');
    // Each screen language writes the date its own way.
    expect(en.scheduled(choice)).toBe('From 1 Jan 2027 23\u00A0%');
    expect(cs.scheduled(classificationChoice(payerVat([reducedNow]), CZ_VAT_REDUCED, now))).toBeUndefined();
  });

  it("names an order line's VAT from its snapshot, whatever Tax says today", () => {
    expect(cs.line(CZ_VAT_REDUCED, 10)).toBe('Snížená (10\u00A0%)');
    expect(en.line(CZ_VAT_STANDARD, 21)).toBe('Standard (21\u00A0%)');
  });
});

describe('a company that is not a VAT payer', () => {
  it('sells every classification at 0 %, offers both and says it is not a VAT payer', () => {
    expect(rateAt(nonPayerVat, CZ_VAT_REDUCED, now)?.ratePercent).toBe(0);
    expect(noTaxRates(nonPayerVat)).toBe(false);
    const choices = classificationChoices(nonPayerVat, now);
    expect(choices.map(choiceAvailable)).toEqual([true, true]);
    expect(choices.map((choice) => cs.choice(choice))).toEqual([
      'Základní (firma není plátce DPH)',
      'Snížená (firma není plátce DPH)',
    ]);
    expect(en.choice(choices[0] ?? classificationChoice(nonPayerVat, CZ_VAT_STANDARD, now))).toBe(
      'Standard (the company is not a VAT payer)',
    );
    expect(cs.scheduled(classificationChoice(nonPayerVat, CZ_VAT_STANDARD, now))).toBeUndefined();
  });
});

describe('how current the company rates are', () => {
  it('says when Tax has not confirmed them yet, and when it last did once that is long ago', () => {
    expect(cs.confirmation({ rates: [standardNow], regime: 'VAT_PAYER', source: 'MIGRATION' }, now)).toBe(
      'Sazby DPH zatím nepotvrdil modul Daně; platí sazby převzaté z dosud uložených cen.',
    );
    const recent = {
      confirmedAt: DateTime.subtract(now, { minutes: 5 }),
      rates: [standardNow],
      regime: 'VAT_PAYER' as const,
    };
    expect(cs.confirmation(recent, now)).toBeUndefined();
    expect(cs.confirmation({ rates: [standardNow], regime: 'VAT_PAYER' }, now)).toBeUndefined();
    const stale = { ...recent, confirmedAt: at('2026-11-12T07:30:00Z') };
    expect(cs.confirmation(stale, now)?.replaceAll(' ', ' ')).toBe(
      'Sazby DPH naposledy potvrdil modul Daně 12. 11. 2026 8:30; modul Daně teď neodpovídá.',
    );
    expect(taxLabelsOf(translateIn('en')).confirmation(stale, now)).toBe(
      'The tax module last confirmed the VAT rates on 12 Nov 2026, 08:30; it is not answering now.',
    );
  });

  it('tells the migrated rates from none at all, as the staff read states their source', () => {
    const migrated = companyVatOf({
      sellerVatRegime: 'VAT_PAYER',
      taxRates: [standardNow],
      taxRatesConfirmedAt: null,
      taxRatesSource: 'MIGRATION',
    });
    expect(cs.confirmation(migrated, now)).toBe(
      'Sazby DPH zatím nepotvrdil modul Daně; platí sazby převzaté z dosud uložených cen.',
    );
    // Nothing stored: no rates to call unconfirmed; the form says instead that the company has no rate.
    const none = companyVatOf({ sellerVatRegime: null, taxRates: [], taxRatesConfirmedAt: null, taxRatesSource: null });
    expect(cs.confirmation(none, now)).toBeUndefined();
  });
});

describe('rates the server would refuse', () => {
  it('two periods in force at once, or a fractional rate, give no rate and name the reason', () => {
    const overlapping = rate({ code: CZ_VAT_STANDARD, effectiveFrom: '2026-01-01T00:00:00Z', ratePercent: 20 });
    const conflicting = payerVat([standardNow, overlapping]);
    expect(rateAt(conflicting, CZ_VAT_STANDARD, now)).toBeUndefined();
    expect(classificationChoice(conflicting, CZ_VAT_STANDARD, now).problem).toBe('RULE_CONFLICT');
    expect(cs.rateMissing(CZ_VAT_STANDARD, 'RULE_CONFLICT')).toBe(
      'Pro sazbu DPH „Základní“ platí v modulu Daně více pravidel zároveň, produkt nelze přidat.',
    );
    const fractional = payerVat([
      rate({ code: CZ_VAT_REDUCED, effectiveFrom: '2024-01-01T00:00:00Z', ratePercent: 10.5 }),
    ]);
    expect(rateAt(fractional, CZ_VAT_REDUCED, now)).toBeUndefined();
    expect(classificationChoice(fractional, CZ_VAT_REDUCED, now).problem).toBe('NOT_INTEGER');
    expect(cs.rateMissing(CZ_VAT_REDUCED, 'NOT_INTEGER')).toBe(
      'Sazba DPH „Snížená“ není v modulu Daně celé procento, produkt nelze přidat.',
    );
    expect(classificationChoice(payerVat([standardNow]), CZ_VAT_STANDARD, now).problem).toBeUndefined();
  });
});
