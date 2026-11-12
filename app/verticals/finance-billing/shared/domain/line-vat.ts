import { CZ_VAT_REDUCED, CZ_VAT_STANDARD } from '@app/shared-contracts/cz-vat-classifications';
import type { CzVatClassificationCode } from '@app/shared-contracts/cz-vat-classifications';
import { DateTime, Option, Schema } from 'effect';
import type { InvoiceDirectionSchema, InvoiceLine, LineVatTreatment } from '../apis/records.ts';
import type { VatChoices, VatClassificationRate } from '../apis/vat-choices.ts';

/** The explicit line treatments in display order. */
export const lineVatTreatments: readonly LineVatTreatment[] = ['EXEMPT', 'REVERSE_CHARGE', 'NON_PAYER'];

/** Locale key of a classification's name (`finance-billing.vat.classification.<key>`). */
export const classificationLabelKey = (code: CzVatClassificationCode): string =>
  `finance-billing.vat.classification.${code === CZ_VAT_STANDARD ? 'standard' : 'reduced'}`;

/** Locale key of a treatment's name (`finance-billing.vat.treatment.<key>`). */
export const treatmentLabelKey = (treatment: LineVatTreatment): string =>
  `finance-billing.vat.treatment.${
    {
      EXEMPT: 'exempt',
      NON_PAYER: 'nonPayer',
      REVERSE_CHARGE: 'reverseCharge',
    }[treatment]
  }`;

/**
 * The instant a calendar day starts in Europe/Prague, as Tax receives it. Tax revisions start at a Prague midnight, so
 * the rate at the start of an issue day is the rate of the whole day. Undefined for a date that does not parse.
 */
export const pragueDayStart = (isoDate: string): DateTime.Utc | undefined => {
  const [year, month, day] = isoDate.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    return undefined;
  }
  return Option.getOrUndefined(
    DateTime.makeZoned(
      { day, hour: 0, millisecond: 0, minute: 0, month, second: 0, year },
      { adjustForTimeZone: true, timeZone: 'Europe/Prague' },
    ).pipe(Option.map(DateTime.toUtc)),
  );
};

/** The rate Tax publishes for `code` in these choices, if any. */
export const rateOf = (choices: VatChoices, code: CzVatClassificationCode): VatClassificationRate | undefined =>
  choices.rates.find((rate) => rate.code === code);

/** The line's VAT as the form offers it: a classification, a treatment, or an older stored rate. */
export type LineVatChoice =
  | { readonly code: CzVatClassificationCode; readonly kind: 'classification' }
  | { readonly kind: 'treatment'; readonly treatment: LineVatTreatment }
  | { readonly kind: 'stored'; readonly rate: number };

type LineVat = Pick<InvoiceLine, 'taxRuleRevisionRef' | 'vatClassification' | 'vatRate' | 'vatTreatment'>;

export const lineVatChoice = (line: LineVat): LineVatChoice => {
  if (line.vatClassification !== undefined) {
    return { code: line.vatClassification, kind: 'classification' };
  }
  if (line.vatTreatment !== undefined) {
    return { kind: 'treatment', treatment: line.vatTreatment };
  }
  return { kind: 'stored', rate: line.vatRate };
};

/** The stored VAT fields of a choice, with the rate and revision Tax publishes; undefined when Tax has none. */
export const lineVatOf = (choice: LineVatChoice, choices: VatChoices | undefined): LineVat | undefined => {
  if (choice.kind === 'treatment') {
    return { vatRate: 0, vatTreatment: choice.treatment };
  }
  if (choice.kind === 'stored') {
    return { vatRate: choice.rate };
  }
  const rate = choices === undefined ? undefined : rateOf(choices, choice.code);
  return rate === undefined
    ? undefined
    : { taxRuleRevisionRef: rate.taxRuleRevisionRef, vatClassification: rate.code, vatRate: rate.ratePercent };
};

export type InvoiceDirection = typeof InvoiceDirectionSchema.Type;

/**
 * Which treatments a line may use. A supplier's own invoice may carry any of them. A company that is not a VAT payer
 * issues only non-payer lines; a payer (or a company with no declared regime yet) never does.
 */
export const allowedTreatments = (
  direction: InvoiceDirection,
  regime: VatChoices['regime'] | undefined,
): readonly LineVatTreatment[] => {
  if (direction === 'INCOMING') {
    return lineVatTreatments;
  }
  return regime === 'NON_PAYER' ? ['NON_PAYER'] : ['EXEMPT', 'REVERSE_CHARGE'];
};

/** Whether a company's own invoice may use the VAT classifications: never for a company that is not a VAT payer. */
export const classificationsAllowed = (
  direction: InvoiceDirection,
  regime: VatChoices['regime'] | undefined,
): boolean => direction === 'INCOMING' || regime !== 'NON_PAYER';

/** The default VAT of a new line: the standard rate, or the non-payer treatment for a company without VAT. */
export const defaultLineVatChoice = (direction: InvoiceDirection, regime?: VatChoices['regime']): LineVatChoice =>
  classificationsAllowed(direction, regime)
    ? { code: CZ_VAT_STANDARD, kind: 'classification' }
    : { kind: 'treatment', treatment: 'NON_PAYER' };

/**
 * A company that is not a VAT payer invoices without VAT: a line still on a classification is shown and sent with the
 * non-payer treatment instead, since the form offers it nothing else.
 */
export const forSellerRegime = <Line extends { readonly vat: LineVatChoice }>(
  line: Line,
  regime: VatChoices['regime'] | undefined,
): Line =>
  regime === 'NON_PAYER' && line.vat.kind === 'classification'
    ? { ...line, vat: { kind: 'treatment', treatment: 'NON_PAYER' } }
    : line;

/** Why a line's VAT cannot be stored; the stable codes the server rejects with and the forms explain. */
export const LineVatIssueSchema = Schema.Literals([
  'vat_classification_required',
  'vat_not_payer',
  'vat_rate_changed',
  'vat_treatment',
]);
export type LineVatIssue = typeof LineVatIssueSchema.Type;

const sameRevision = (left: LineVat['taxRuleRevisionRef'], right: VatClassificationRate['taxRuleRevisionRef']) =>
  left !== undefined && left.resourceId === right.resourceId && left.tenantId === right.tenantId;

/**
 * Checks one new line against what Tax publishes for the company at the issue date. A classified line must copy
 * exactly the current rate and revision; a treatment must suit the direction and the company's VAT regime. A line
 * that `kept` says is unchanged from what the record already stored is history and is never re-judged.
 */
export const lineVatIssue = (
  line: LineVat,
  choices: VatChoices,
  direction: InvoiceDirection,
  kept = false,
): LineVatIssue | undefined => {
  if (kept) {
    return undefined;
  }
  if (line.vatTreatment !== undefined) {
    return allowedTreatments(direction, choices.regime).includes(line.vatTreatment) ? undefined : 'vat_treatment';
  }
  if (line.vatClassification === undefined) {
    return 'vat_classification_required';
  }
  if (!classificationsAllowed(direction, choices.regime)) {
    return 'vat_not_payer';
  }
  const rate = rateOf(choices, line.vatClassification);
  return rate !== undefined &&
    rate.ratePercent === line.vatRate &&
    sameRevision(line.taxRuleRevisionRef, rate.taxRuleRevisionRef)
    ? undefined
    : 'vat_rate_changed';
};

/**
 * The line re-priced to Tax's rate at the issue date (a recurring invoice generated from a template). Treatment lines
 * and older rate-only lines keep what they store. Undefined when Tax publishes no rate for the classification.
 */
export const withCurrentTaxRate = <Line extends LineVat>(line: Line, choices: VatChoices): Line | undefined => {
  if (line.vatClassification === undefined) {
    return line;
  }
  const rate = rateOf(choices, line.vatClassification);
  return rate === undefined
    ? undefined
    : { ...line, taxRuleRevisionRef: rate.taxRuleRevisionRef, vatRate: rate.ratePercent };
};

/** Mapping of the stored rates before classifications existed: 21 % is the standard and 12 % the reduced rate. */
export const classificationOfStoredRate = (rate: number): CzVatClassificationCode | undefined => {
  if (rate === 21) {
    return CZ_VAT_STANDARD;
  }
  return rate === 12 ? CZ_VAT_REDUCED : undefined;
};
