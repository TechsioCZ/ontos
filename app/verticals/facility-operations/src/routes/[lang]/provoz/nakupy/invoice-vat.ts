import { LineVatTreatmentSchema } from '@app/finance-billing/contracts/records';
import type { InvoiceLine } from '@app/finance-billing/contracts/records';
import { CZ_VAT_STANDARD } from '@app/shared-contracts/cz-vat-classifications';
import { Option } from 'effect';
import type { FinanceVatChoices } from '../../../../ui/finance-reads.ts';

export type InvoiceVat = Pick<InvoiceLine, 'taxRuleRevisionRef' | 'vatClassification' | 'vatRate' | 'vatTreatment'>;

export interface InvoiceVatOption {
  readonly key: string;
  readonly labelKey: string;
  readonly vat: InvoiceVat;
}

/** Incoming documents describe the supplier's VAT, independently of the receiving company's regime. */
export const incomingVatOptions = (choices: FinanceVatChoices): readonly InvoiceVatOption[] => [
  ...choices.rates.map((rate) => ({
    key: rate.code,
    labelKey: `facility-operations.ui.vat.${rate.code === CZ_VAT_STANDARD ? 'standard' : 'reduced'}`,
    vat: {
      taxRuleRevisionRef: rate.taxRuleRevisionRef,
      vatClassification: rate.code,
      vatRate: rate.ratePercent,
    },
  })),
  ...LineVatTreatmentSchema.literals.map((vatTreatment) => ({
    key: vatTreatment,
    labelKey: `facility-operations.ui.vat.${vatTreatment}`,
    vat: { vatRate: 0, vatTreatment },
  })),
];

/** Never guess a zero-rate treatment or reinterpret a historical rate as a different classification. */
export const salesLineVat = (input: {
  readonly choices: FinanceVatChoices;
  readonly issueDate: string;
  readonly vatRate: number;
}): Option.Option<InvoiceVat> => {
  if (input.choices.on !== input.issueDate || input.choices.regime !== 'VAT_PAYER' || input.vatRate === 0) {
    return Option.none();
  }
  const rates = input.choices.rates.filter((rate) => rate.ratePercent === input.vatRate);
  const [rate] = rates;
  return rate === undefined || rates.length !== 1
    ? Option.none()
    : Option.some({
        taxRuleRevisionRef: rate.taxRuleRevisionRef,
        vatClassification: rate.code,
        vatRate: rate.ratePercent,
      });
};
