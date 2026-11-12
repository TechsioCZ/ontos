// A product's VAT classification as staff see it: which rate Tax gives each classification of the selected company
// now, which one it has scheduled next, and how the forms name them. Tax owns the rates; Merchandise never keeps one.
import { formatNumber } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { CZ_VAT_STANDARD, czVatClassificationCodes } from '@app/shared-contracts/cz-vat-classifications';
import type { CzVatClassificationCode, TaxRateView } from '@app/shared-contracts/cz-vat-classifications';
import { DateTime, Duration, Schema } from 'effect';
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
/** Why a classification has no usable rate, by the rules Merchandise sells by (the same the server applies). */
export const RateProblemSchema = Schema.Literals(['NOT_INTEGER', 'NO_RULE', 'RULE_CONFLICT']);
export type RateProblem = typeof RateProblemSchema.Type;

/**
 * Whether the classification has a usable rate at `at`: exactly one period in force, at a whole percent (the server
 * refuses a fractional rate and overlapping periods). A company that is not a VAT payer always has one (0 %).
 */
export const rateProblemAt = (
  vat: CompanyVat,
  code: CzVatClassificationCode,
  at: DateTime.Utc,
): RateProblem | undefined => {
  if (vat.regime === 'NON_PAYER') {
    return undefined;
  }
  const inForce = vat.rates.filter((rate) => rate.code === code && covers(rate, at));
  if (inForce.length === 0) {
    return 'NO_RULE';
  }
  if (inForce.length > 1) {
    return 'RULE_CONFLICT';
  }
  return inForce.every((rate) => Number.isInteger(rate.ratePercent)) ? undefined : 'NOT_INTEGER';
};

export const rateAt = (
  vat: CompanyVat,
  code: CzVatClassificationCode | undefined,
  at: DateTime.Utc,
): TaxRateView | undefined => {
  if (code === undefined || rateProblemAt(vat, code, at) !== undefined) {
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
  /** Why there is no usable rate now, when there is none. */
  readonly problem: RateProblem | undefined;
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
  problem: rateProblemAt(vat, code, now),
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

/** How old the company's rates may be before the staff screens say when Tax last confirmed them. */
const CONFIRMATION_SHOWN_AFTER = Duration.minutes(30);

/** A date (and time) in the screen's language, in Prague time. */
const dateFormatOf = (language: string, withTime: boolean) => {
  const options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeZone: 'Europe/Prague' };
  if (withTime) {
    options.timeStyle = 'short';
  }
  return new Intl.DateTimeFormat(language === 'en' ? 'en-GB' : 'cs-CZ', options);
};

/** Words for the classifications and their rates. Pure, so the forms and their tests read the same text. */
export const taxLabelsOf = (t: Translate, language = 'cs') => {
  const dateTime = dateFormatOf(language, true);
  const date = dateFormatOf(language, false);
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
          date: date.format(DateTime.toEpochMillis(next.effectiveFrom)),
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
  const rateMissing = (code: CzVatClassificationCode, problem: RateProblem | undefined = 'NO_RULE') => {
    const values = { name: name(code) };
    if (problem === 'RULE_CONFLICT') {
      return t(`${KEY_PREFIX}.rateConflict`, values);
    }
    return problem === 'NOT_INTEGER' ? t(`${KEY_PREFIX}.rateNotWhole`, values) : t(`${KEY_PREFIX}.rateMissing`, values);
  };

  /**
   * When the company's rates are not current: not yet confirmed by Tax (taken over from the stored prices), or last
   * confirmed long enough ago to say when. Nothing while they are recent or unknown.
   */
  const confirmation = (vat: CompanyVat, now: DateTime.Utc) => {
    if (vat.confirmedAt === null) {
      return t(`${KEY_PREFIX}.unconfirmed`);
    }
    return vat.confirmedAt === undefined ||
      Duration.isLessThan(DateTime.distance(vat.confirmedAt, now), CONFIRMATION_SHOWN_AFTER)
      ? undefined
      : t(`${KEY_PREFIX}.confirmedAt`, { at: dateTime.format(DateTime.toEpochMillis(vat.confirmedAt)) });
  };
  return {
    choice,
    confirmation,
    line,
    name,
    noRates: t(`${KEY_PREFIX}.noRates`),
    /** Why a product that names no VAT classification cannot go on an order line. */
    noClassification: t(`${KEY_PREFIX}.noClassification`),
    /** Under the VAT select of a company that is not a VAT payer. */
    nonPayerHint: t(`${KEY_PREFIX}.nonPayerHint`),
    /** Why a new product cannot be created: the company has no VAT rate in force for any classification. */
    noRateToCreate: t(`${KEY_PREFIX}.noRateToCreate`),
    /** Why a new product cannot take this classification: it has no rate in force for the company yet. */
    notSet,
    rateMissing,
    rateNotInForce: (code: CzVatClassificationCode) => t(`${KEY_PREFIX}.rateNotInForce`, { name: name(code) }),
    scheduled,
  };
};
export type TaxLabels = ReturnType<typeof taxLabelsOf>;

export const useTaxLabels = (): TaxLabels => {
  const { language, t } = useModernI18n();
  return taxLabelsOf(t, language);
};
