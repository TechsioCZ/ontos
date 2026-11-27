import { SelectTemplateField } from '@app/core-runtime/ui/form';
import type { FormReact } from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Match, Schema } from 'effect';
import { createElement } from 'react';
import { CzVatClassificationCodeSchema, czVatClassificationCodes } from '@app/shared-contracts/cz-vat-classifications';
import { LineVatTreatmentSchema } from '../../../../shared/apis/records.ts';
import type { InvoiceLine, LineVatTreatment } from '../../../../shared/apis/records.ts';
import {
  allowedTreatments,
  classificationLabelKey,
  classificationsAllowed,
  rateOf,
  regimeReady,
  treatmentLabelKey,
} from '../../../../shared/domain/line-vat.ts';
import type { InvoiceDirection, LineVatChoice } from '../../../../shared/domain/line-vat.ts';
import { fieldPart } from './field-lens.ts';
import { formLabelProps } from './invoice-view.ts';
import type { VatChoicesState } from './use-vat-choices.ts';

/** A line's or item's VAT choice as a form field holds it. */
export const LineVatChoiceSchema = Schema.Union([
  Schema.Struct({ code: CzVatClassificationCodeSchema, kind: Schema.Literal('classification') }),
  Schema.Struct({ kind: Schema.Literal('treatment'), treatment: LineVatTreatmentSchema }),
  Schema.Struct({ kind: Schema.Literal('stored'), rate: Schema.Number }),
]);

const STORED_VALUE = 'stored';

const choiceValue = (choice: LineVatChoice): string =>
  Match.value(choice).pipe(
    Match.discriminatorsExhaustive('kind')({
      classification: ({ code }) => `classification:${code}`,
      stored: () => STORED_VALUE,
      treatment: ({ treatment }) => `treatment:${treatment}`,
    }),
  );

interface VatChoiceProps {
  readonly direction: InvoiceDirection;
  /** Shown under the select when the chosen VAT cannot be stored (the line's or the form's own check). */
  readonly invalid?: boolean;
  readonly name: string;
  readonly vat: VatChoicesState;
}

/**
 * The VAT of one line or price-list item: the classifications with the rate Tax publishes for the company on the
 * issue date, and the explicit treatments (exempt, reverse charge, not a VAT payer) the direction and the company's
 * regime allow. An older stored rate stays visible as it is but is never offered for something new.
 */
export const VatChoiceField: FormReact.FieldComponent<LineVatChoice, VatChoiceProps> = ({ field, props }) => {
  const { direction, invalid = false, name, vat } = props;
  const choice = field.value;
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
      {createElement(SelectTemplateField, {
        field: fieldPart(field, 'choice', choiceValue(choice), (picked) => {
          const code = czVatClassificationCodes.find((entry) => picked === `classification:${entry}`);
          if (code !== undefined) {
            field.onChange({ code, kind: 'classification' });
            return;
          }
          const treatment = shownTreatments.find((entry) => picked === `treatment:${entry}`);
          if (treatment !== undefined) {
            field.onChange({ kind: 'treatment', treatment });
          }
        }),
        props: {
          items,
          label: t('finance-billing.vat.picker'),
          labelProps: formLabelProps,
          name,
          placeholder: t('finance-billing.selectPlaceholder'),
        },
      })}
      {vat.state === 'unavailable' && (
        <StatusText showIcon size="sm" status="warning">
          {t('finance-billing.vat.ratesUnavailable')}
        </StatusText>
      )}
      {choices !== undefined && !regimeReady(direction, regime) && (
        <StatusText showIcon size="sm" status="error">
          {t('finance-billing.vat.regimeNotDeclared')}
        </StatusText>
      )}
      {vat.state !== 'unavailable' && regimeReady(direction, regime) && invalid && (
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
