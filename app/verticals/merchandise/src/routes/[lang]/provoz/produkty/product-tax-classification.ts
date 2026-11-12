// A product's VAT classification as staff see it: which rate Tax gives each classification of the selected company
// now, which one it has scheduled next, and how the forms name them. Tax owns the rates; Merchandise never keeps one.
import { formatDate, formatNumber } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { CZ_VAT_STANDARD, czVatClassificationCodes } from '@app/shared-contracts/cz-vat-classifications';
import type { CzVatClassificationCode, TaxRateView } from '@app/shared-contracts/cz-vat-classifications';
import { DateTime } from 'effect';

const KEY_PREFIX = 'merchandise.tax';

/** The classification a new product starts with. */
export const DEFAULT_TAX_CLASSIFICATION: CzVatClassificationCode = CZ_VAT_STANDARD;

const nameKeys = {
  'cz.vat.reduced': 'reduced',
  'cz.vat.standard': 'standard',
} as const satisfies Record<CzVatClassificationCode, string>;

const covers = (rate: TaxRateView, at: DateTime.Utc): boolean => {
  const instant = DateTime.toEpochMillis(at);
  return (
    DateTime.toEpochMillis(rate.effectiveFrom) <= instant &&
    (rate.effectiveTo === undefined || instant < DateTime.toEpochMillis(rate.effectiveTo))
  );
};

/** The rate of `code` in force at `at`: the period from `effectiveFrom` up to, not including, `effectiveTo`. */
export const rateAt = (
  taxRates: readonly TaxRateView[],
  code: CzVatClassificationCode,
  at: DateTime.Utc,
): TaxRateView | undefined => taxRates.find((rate) => rate.code === code && covers(rate, at));

/** The earliest rate of `code` that starts after `at`. */
export const scheduledRateAfter = (
  taxRates: readonly TaxRateView[],
  code: CzVatClassificationCode,
  at: DateTime.Utc,
): TaxRateView | undefined =>
  taxRates
    .filter((rate) => rate.code === code && DateTime.toEpochMillis(rate.effectiveFrom) > DateTime.toEpochMillis(at))
    .toSorted((left, right) => DateTime.toEpochMillis(left.effectiveFrom) - DateTime.toEpochMillis(right.effectiveFrom))
    .at(0);

/** One classification as the VAT select offers it. */
export interface ClassificationChoice {
  readonly code: CzVatClassificationCode;
  /** The rate in force now; undefined when the company has no current rule for it. */
  readonly current: TaxRateView | undefined;
  /** The next rate Tax has scheduled, if any. */
  readonly scheduled: TaxRateView | undefined;
}

/** One classification with the company's rate in force at `now` and the next one scheduled after it. */
export const classificationChoice = (
  taxRates: readonly TaxRateView[],
  code: CzVatClassificationCode,
  now: DateTime.Utc,
): ClassificationChoice => ({
  code,
  current: rateAt(taxRates, code, now),
  scheduled: scheduledRateAfter(taxRates, code, now),
});

/** Every classification in display order, with the company's current and next rate. */
export const classificationChoices = (
  taxRates: readonly TaxRateView[],
  now: DateTime.Utc,
): readonly ClassificationChoice[] => czVatClassificationCodes.map((code) => classificationChoice(taxRates, code, now));

/** A classification may be chosen once the company has a rule for it, in force now or scheduled. */
export const choiceAvailable = (choice: ClassificationChoice): boolean =>
  choice.current !== undefined || choice.scheduled !== undefined;

/**
 * Tax gives the company no rate at all: it is not a VAT payer, or it has no rule yet. The read cannot tell these two
 * apart, so both show as "not set".
 */
export const noTaxRates = (taxRates: readonly TaxRateView[]): boolean => taxRates.length === 0;

/** `21 %`, `10,5 %`: Czech digits with a non-breaking space before the sign. */
export const ratePercentText = (ratePercent: number): string => `${formatNumber(ratePercent)}\u00A0%`;

type Translate = (key: string, values?: Record<string, number | string>) => string;

/** Words for the classifications and their rates. Pure, so the forms and their tests read the same text. */
export const taxLabelsOf = (t: Translate) => {
  const name = (code: CzVatClassificationCode) => t(`${KEY_PREFIX}.classification.${nameKeys[code]}`);
  const notSet = t(`${KEY_PREFIX}.notSet`);
  /** `Základní (21 %)`; a classification without a rate in force says `Snížená (není nastaveno)`. */
  const choice = ({ code, current }: ClassificationChoice) =>
    t(`${KEY_PREFIX}.option`, {
      name: name(code),
      rate: current === undefined ? notSet : ratePercentText(current.ratePercent),
    });
  /** `Od 1. 1. 2027 23 %` under the select when Tax has a later rate scheduled. */
  const scheduled = ({ scheduled: next }: ClassificationChoice) =>
    next === undefined
      ? undefined
      : t(`${KEY_PREFIX}.scheduled`, {
          date: formatDate(DateTime.formatIso(next.effectiveFrom)),
          rate: ratePercentText(next.ratePercent),
        });
  /** An order line's VAT as it was snapshotted: `Základní (21 %)`. */
  const line = (code: CzVatClassificationCode, ratePercent: number) =>
    t(`${KEY_PREFIX}.option`, { name: name(code), rate: ratePercentText(ratePercent) });
  /** Why a product cannot go on an order line: its classification has no rate in force for the company. */
  const rateMissing = (code: CzVatClassificationCode) => t(`${KEY_PREFIX}.rateMissing`, { name: name(code) });
  return {
    choice,
    line,
    name,
    noRates: t(`${KEY_PREFIX}.noRates`),
    notSet,
    rateMissing,
    scheduled,
  };
};
export type TaxLabels = ReturnType<typeof taxLabelsOf>;

export const useTaxLabels = (): TaxLabels => {
  const { t } = useModernI18n();
  return taxLabelsOf(t);
};
