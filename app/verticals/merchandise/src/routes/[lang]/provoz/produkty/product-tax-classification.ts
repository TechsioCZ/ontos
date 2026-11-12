// A product's VAT classification as staff see it: which rate Tax gives each classification of the selected company
// now, which one it has scheduled next, and how the forms name them. Tax owns the rates; Merchandise never keeps one.
import { formatDate, formatNumber } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { CZ_VAT_STANDARD, czVatClassificationCodes } from '@app/shared-contracts/cz-vat-classifications';
import type { CzVatClassificationCode, TaxRateView } from '@app/shared-contracts/cz-vat-classifications';
import { DateTime } from 'effect';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';

const KEY_PREFIX = 'merchandise.tax';

/** The classification a new product starts with. */
export const DEFAULT_TAX_CLASSIFICATION: CzVatClassificationCode = CZ_VAT_STANDARD;

/**
 * The selected company's VAT as the staff records read gives it: its rates from Tax, its declared regime (null: none),
 * and when Tax last confirmed them (null: not yet, they are the rates taken over from the stored prices).
 */
export interface CompanyVat {
  readonly confirmedAt?: DateTime.Utc | null;
  readonly rates: readonly TaxRateView[];
  readonly regime: 'NON_PAYER' | 'VAT_PAYER' | null;
}

export const NO_COMPANY_VAT: CompanyVat = { rates: [], regime: null };

/** The company's VAT from a staff records response. */
export const companyVatOf = (
  response: Pick<RecordsResponse, 'sellerVatRegime' | 'taxRates' | 'taxRatesConfirmedAt'> | undefined,
): CompanyVat => {
  const vat: CompanyVat = { rates: response?.taxRates ?? [], regime: response?.sellerVatRegime ?? null };
  const confirmedAt = response?.taxRatesConfirmedAt;
  return confirmedAt === undefined ? vat : { ...vat, confirmedAt };
};

/** A company that is not a VAT payer sells every classification at 0 %, from always. */
const nonPayerRate = (code: CzVatClassificationCode): TaxRateView => ({
  code,
  effectiveFrom: DateTime.makeUnsafe(0),
  ratePercent: 0,
});

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

/**
 * The rate of `code` in force at `at`: the period from `effectiveFrom` up to, not including, `effectiveTo`; 0 % for a
 * company that is not a VAT payer. Without a classification (an order line from before classifications) there is none.
 */
export const rateAt = (
  vat: CompanyVat,
  code: CzVatClassificationCode | undefined,
  at: DateTime.Utc,
): TaxRateView | undefined => {
  if (code === undefined) {
    return undefined;
  }
  return vat.regime === 'NON_PAYER'
    ? nonPayerRate(code)
    : vat.rates.find((rate) => rate.code === code && covers(rate, at));
};

/** The earliest rate of `code` that starts after `at`. */
export const scheduledRateAfter = (
  vat: CompanyVat,
  code: CzVatClassificationCode,
  at: DateTime.Utc,
): TaxRateView | undefined =>
  vat.rates
    .filter((rate) => rate.code === code && DateTime.toEpochMillis(rate.effectiveFrom) > DateTime.toEpochMillis(at))
    .toSorted((left, right) => DateTime.toEpochMillis(left.effectiveFrom) - DateTime.toEpochMillis(right.effectiveFrom))
    .at(0);

/** One classification as the VAT select offers it. */
export interface ClassificationChoice {
  readonly code: CzVatClassificationCode;
  /** The rate in force now; undefined when the company has no current rule for it. */
  readonly current: TaxRateView | undefined;
  /** The company is not a VAT payer: every classification sells without VAT. */
  readonly nonPayer: boolean;
  /** The next rate Tax has scheduled, if any. */
  readonly scheduled: TaxRateView | undefined;
}

/** One classification with the company's rate in force at `now` and the next one scheduled after it. */
export const classificationChoice = (
  vat: CompanyVat,
  code: CzVatClassificationCode,
  now: DateTime.Utc,
): ClassificationChoice => ({
  code,
  current: rateAt(vat, code, now),
  nonPayer: vat.regime === 'NON_PAYER',
  scheduled: vat.regime === 'NON_PAYER' ? undefined : scheduledRateAfter(vat, code, now),
});

/** Every classification in display order, with the company's current and next rate. */
export const classificationChoices = (vat: CompanyVat, now: DateTime.Utc): readonly ClassificationChoice[] =>
  czVatClassificationCodes.map((code) => classificationChoice(vat, code, now));

/** A classification may be chosen once the company has a rule for it, in force now or scheduled. */
export const choiceAvailable = (choice: ClassificationChoice): boolean =>
  choice.current !== undefined || choice.scheduled !== undefined;

/** Tax gives the company no rate at all: no regime declared, or a payer without any rule yet (a non-payer sells at 0 %). */
export const noTaxRates = (vat: CompanyVat): boolean => vat.regime !== 'NON_PAYER' && vat.rates.length === 0;

/** `21 %`, `10,5 %`: Czech digits with a non-breaking space before the sign. */
export const ratePercentText = (ratePercent: number): string => `${formatNumber(ratePercent)}\u00A0%`;

type Translate = (key: string, values?: Record<string, number | string>) => string;

/** Words for the classifications and their rates. Pure, so the forms and their tests read the same text. */
export const taxLabelsOf = (t: Translate) => {
  const name = (code: CzVatClassificationCode) => t(`${KEY_PREFIX}.classification.${nameKeys[code]}`);
  const notSet = t(`${KEY_PREFIX}.notSet`);
  const nonPayer = t(`${KEY_PREFIX}.nonPayer`);
  const rateText = ({ current, nonPayer: withoutVat }: ClassificationChoice) => {
    if (withoutVat) {
      return nonPayer;
    }
    return current === undefined ? notSet : ratePercentText(current.ratePercent);
  };
  /**
   * `Základní (21 %)`; a classification without a rate in force says `Snížená (není nastaveno)`, and every
   * classification of a company that is not a VAT payer says `Základní (firma není plátce DPH)`.
   */
  const choice = (picked: ClassificationChoice) =>
    t(`${KEY_PREFIX}.option`, { name: name(picked.code), rate: rateText(picked) });
  /** `Od 1. 1. 2027 23 %` under the select when Tax has a later rate scheduled. */
  const scheduled = ({ scheduled: next }: ClassificationChoice) =>
    next === undefined
      ? undefined
      : t(`${KEY_PREFIX}.scheduled`, {
          date: formatDate(DateTime.formatIso(next.effectiveFrom)),
          rate: ratePercentText(next.ratePercent),
        });
  /**
   * An order line's VAT as it was snapshotted: `Základní (21 %)`; a line from before classifications (10 % or 0 %
   * history) shows its rate alone.
   */
  const line = (code: CzVatClassificationCode | undefined, ratePercent: number) =>
    code === undefined
      ? ratePercentText(ratePercent)
      : t(`${KEY_PREFIX}.option`, { name: name(code), rate: ratePercentText(ratePercent) });
  /** Why a product cannot go on an order line: its classification has no rate in force for the company. */
  const rateMissing = (code: CzVatClassificationCode | undefined) =>
    t(`${KEY_PREFIX}.rateMissing`, { name: code === undefined ? notSet : name(code) });
  return {
    choice,
    line,
    name,
    noRates: t(`${KEY_PREFIX}.noRates`),
    /** Under the VAT select of a company that is not a VAT payer. */
    nonPayerHint: t(`${KEY_PREFIX}.nonPayerHint`),
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
