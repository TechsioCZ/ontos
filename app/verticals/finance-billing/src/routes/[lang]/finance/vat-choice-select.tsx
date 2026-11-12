import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { Match } from 'effect';
import { czVatClassificationCodes } from '@app/shared-contracts/cz-vat-classifications';
import type { InvoiceLine, LineVatTreatment } from '../../../../shared/apis/records.ts';
import {
  allowedTreatments,
  classificationLabelKey,
  classificationsAllowed,
  rateOf,
  treatmentLabelKey,
} from '../../../../shared/domain/line-vat.ts';
import type { InvoiceDirection, LineVatChoice } from '../../../../shared/domain/line-vat.ts';
import { formLabelProps } from './invoice-view.ts';
import type { VatChoicesState } from './use-vat-choices.ts';

const STORED_VALUE = 'stored';

const choiceValue = (choice: LineVatChoice): string =>
  Match.value(choice).pipe(
    Match.discriminatorsExhaustive('kind')({
      classification: ({ code }) => `classification:${code}`,
      stored: () => STORED_VALUE,
      treatment: ({ treatment }) => `treatment:${treatment}`,
    }),
  );

interface VatChoiceSelectProps {
  readonly choice: LineVatChoice;
  readonly direction: InvoiceDirection;
  /** Shown under the select when the chosen VAT cannot be stored (the line's or the form's own check). */
  readonly invalid?: boolean;
  readonly name: string;
  readonly onChange: (next: LineVatChoice) => void;
  readonly vat: VatChoicesState;
}

/**
 * The VAT of one line or price-list item: the classifications with the rate Tax publishes for the company on the
 * issue date, and the explicit treatments (exempt, reverse charge, not a VAT payer) the direction and the company's
 * regime allow. An older stored rate stays visible as it is but is never offered for something new.
 */
export const VatChoiceSelect = ({ choice, direction, invalid = false, name, onChange, vat }: VatChoiceSelectProps) => {
  const { t } = useModernI18n();
  const choices = vat.state === 'ready' ? vat.choices : undefined;
  const regime = choices?.regime;
  const classificationItems = classificationsAllowed(direction, regime)
    ? czVatClassificationCodes.flatMap((code) => {
        const rate = choices === undefined ? undefined : rateOf(choices, code);
        const chosen = choice.kind === 'classification' && choice.code === code;
        if (rate === undefined && !chosen) {
          return [];
        }
        const title = t(classificationLabelKey(code));
        const label =
          rate === undefined
            ? t('finance-billing.vat.pickerRatePending', { name: title })
            : t('finance-billing.vat.pickerRate', { name: title, rate: rate.ratePercent });
        return [{ displayValue: label, label, value: `classification:${code}` }];
      })
    : [];
  const treatments: readonly LineVatTreatment[] = allowedTreatments(direction, regime);
  const shownTreatments =
    choice.kind === 'treatment' && !treatments.includes(choice.treatment)
      ? [...treatments, choice.treatment]
      : treatments;
  const treatmentItems = shownTreatments.map((treatment) => {
    const label = t(treatmentLabelKey(treatment));
    return { displayValue: label, label, value: `treatment:${treatment}` };
  });
  const storedLabel =
    choice.kind === 'stored' ? t('finance-billing.vat.pickerStored', { rate: choice.rate }) : undefined;
  const items = [
    ...classificationItems,
    ...treatmentItems,
    ...(storedLabel === undefined ? [] : [{ displayValue: storedLabel, label: storedLabel, value: STORED_VALUE }]),
  ];
  return (
    <div className="flex min-w-0 flex-col gap-50">
      <SelectTemplate
        items={items}
        label={t('finance-billing.vat.picker')}
        labelProps={formLabelProps}
        name={name}
        onValueChange={({ value }) => {
          const [picked] = value;
          const code = czVatClassificationCodes.find((entry) => picked === `classification:${entry}`);
          if (code !== undefined) {
            onChange({ code, kind: 'classification' });
            return;
          }
          const treatment = shownTreatments.find((entry) => picked === `treatment:${entry}`);
          if (treatment !== undefined) {
            onChange({ kind: 'treatment', treatment });
          }
        }}
        placeholder={t('finance-billing.selectPlaceholder')}
        value={[choiceValue(choice)]}
      />
      {vat.state === 'unavailable' && (
        <StatusText showIcon size="sm" status="warning">
          {t('finance-billing.vat.ratesUnavailable')}
        </StatusText>
      )}
      {vat.state !== 'unavailable' && invalid && (
        <StatusText showIcon size="sm" status="error">
          {t(
            regime === 'NON_PAYER' && direction === 'OUTGOING'
              ? 'finance-billing.vat.nonPayerOnly'
              : 'finance-billing.vat.chooseVat',
          )}
        </StatusText>
      )}
    </div>
  );
};

/**
 * A stored line's or item's VAT as people read it: the classification or treatment name with the stored rate, or only
 * the rate of an older line.
 */
export const VatLabel = ({
  line,
}: {
  readonly line: Pick<InvoiceLine, 'vatClassification' | 'vatRate' | 'vatTreatment'>;
}) => {
  const { t } = useModernI18n();
  if (line.vatTreatment !== undefined) {
    return <>{t(treatmentLabelKey(line.vatTreatment))}</>;
  }
  if (line.vatClassification !== undefined) {
    return (
      <>
        {t('finance-billing.vat.pickerRate', {
          name: t(classificationLabelKey(line.vatClassification)),
          rate: line.vatRate,
        })}
      </>
    );
  }
  return <>{t('finance-billing.vat.storedRate', { rate: line.vatRate })}</>;
};
