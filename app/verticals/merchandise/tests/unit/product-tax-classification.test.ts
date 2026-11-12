// The VAT classification as staff see it: the rate in force now, the next scheduled one, a classification the company
// has no rule for, and a company Tax gives no rate at all. Labels come from the real Czech and English locales.
import { CZ_VAT_REDUCED, CZ_VAT_STANDARD, TaxRateViewSchema } from '@app/shared-contracts/cz-vat-classifications';
import { DateTime, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import {
  choiceAvailable,
  classificationChoice,
  classificationChoices,
  noTaxRates,
  rateAt,
  ratePercentText,
  scheduledRateAfter,
  taxLabelsOf,
} from '../../src/routes/[lang]/provoz/produkty/product-tax-classification.ts';
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

const cs = taxLabelsOf(translateIn('cs'));
const en = taxLabelsOf(translateIn('en'));

describe('rates of a classification', () => {
  it('picks the period in force: from its start up to, not including, its end', () => {
    const rates = [standardNow, standardNext];
    expect(rateAt(rates, CZ_VAT_STANDARD, now)?.ratePercent).toBe(21);
    expect(rateAt(rates, CZ_VAT_STANDARD, at('2026-12-31T23:59:59Z'))?.ratePercent).toBe(21);
    expect(rateAt(rates, CZ_VAT_STANDARD, at('2027-01-01T00:00:00Z'))?.ratePercent).toBe(23);
    expect(rateAt(rates, CZ_VAT_STANDARD, at('2023-12-31T23:59:59Z'))).toBeUndefined();
    expect(rateAt(rates, CZ_VAT_REDUCED, now)).toBeUndefined();
  });

  it('finds the earliest scheduled period after now', () => {
    const later = rate({ code: CZ_VAT_STANDARD, effectiveFrom: '2028-01-01T00:00:00Z', ratePercent: 25 });
    expect(scheduledRateAfter([later, standardNow, standardNext], CZ_VAT_STANDARD, now)?.ratePercent).toBe(23);
    expect(scheduledRateAfter([standardNow, reducedNow], CZ_VAT_STANDARD, now)).toBeUndefined();
  });

  it('offers both classifications in order, each with its current and next rate', () => {
    const choices = classificationChoices([reducedNow, standardNext, standardNow], now);
    expect(choices.map((choice) => choice.code)).toEqual([CZ_VAT_STANDARD, CZ_VAT_REDUCED]);
    expect(choices.map((choice) => choice.current?.ratePercent)).toEqual([21, 12]);
    expect(choices.map((choice) => choice.scheduled?.ratePercent)).toEqual([23, undefined]);
    expect(choices.every(choiceAvailable)).toBe(true);
  });

  it('a classification without a rule cannot be chosen; one with only a scheduled rule can', () => {
    expect(choiceAvailable(classificationChoice([standardNow], CZ_VAT_REDUCED, now))).toBe(false);
    const startsLater = classificationChoice([standardNext], CZ_VAT_STANDARD, now);
    expect(startsLater.current).toBeUndefined();
    expect(choiceAvailable(startsLater)).toBe(true);
  });

  it('a company Tax gives no rate at all (no VAT payer, or no rule yet) has none', () => {
    expect(noTaxRates([])).toBe(true);
    expect(noTaxRates([reducedNow])).toBe(false);
  });
});

describe('labels', () => {
  it('names a classification with its current rate, a non-breaking space before the sign', () => {
    expect(ratePercentText(21)).toBe('21\u00A0%');
    expect(ratePercentText(10.5)).toBe('10,5\u00A0%');
    const choices = classificationChoices([standardNow, reducedNow], now);
    expect(choices.map(cs.choice)).toEqual(['Základní (21\u00A0%)', 'Snížená (12\u00A0%)']);
    expect(choices.map(en.choice)).toEqual(['Standard (21\u00A0%)', 'Reduced (12\u00A0%)']);
  });

  it('says "není nastaveno" instead of a number when no rate is in force', () => {
    const missing = classificationChoice([standardNow], CZ_VAT_REDUCED, now);
    expect(cs.choice(missing)).toBe('Snížená (není nastaveno)');
    expect(en.choice(missing)).toBe('Reduced (not set)');
    expect(cs.noRates).toBe('Pro tuto firmu není nastavená žádná sazba DPH.');
    expect(cs.rateMissing(CZ_VAT_REDUCED)).toBe(
      'Sazba DPH „Snížená“ není pro tuto firmu nastavená, produkt nelze přidat.',
    );
  });

  it('hints a scheduled change with its date and rate', () => {
    const choice = classificationChoice([standardNow, standardNext], CZ_VAT_STANDARD, now);
    expect(cs.scheduled(choice)).toBe('Od 1. 1. 2027 23\u00A0%');
    expect(en.scheduled(choice)).toBe('From 1. 1. 2027 23\u00A0%');
    expect(cs.scheduled(classificationChoice([reducedNow], CZ_VAT_REDUCED, now))).toBeUndefined();
  });

  it("names an order line's VAT from its snapshot, whatever Tax says today", () => {
    expect(cs.line(CZ_VAT_REDUCED, 10)).toBe('Snížená (10\u00A0%)');
    expect(en.line(CZ_VAT_STANDARD, 21)).toBe('Standard (21\u00A0%)');
  });
});
