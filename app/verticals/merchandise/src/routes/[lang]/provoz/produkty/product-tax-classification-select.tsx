import { SelectTemplate } from '@app/admin-ui/select-template';
import type { CzVatClassificationCode, TaxRateView } from '@app/shared-contracts/cz-vat-classifications';
import { DateTime } from 'effect';
import { selectItem } from '../../../../ui/select-item.ts';
import { useProductLabel } from './product-form-labels.ts';
import { choiceAvailable, classificationChoices, noTaxRates, useTaxLabels } from './product-tax-classification.ts';

interface TaxClassificationSelectProps {
  readonly disabled?: boolean;
  readonly onChange: (code: CzVatClassificationCode) => void;
  /** The selected company's rates from the staff records read (current and scheduled periods). */
  readonly taxRates: readonly TaxRateView[];
  readonly value: CzVatClassificationCode;
}

/**
 * The product's VAT: one of the two classifications, named with the rate Tax gives it now. A classification the
 * company has no rule for is offered disabled and says so; a scheduled change shows under the select. A company Tax
 * gives no rate at all keeps the select closed and says that no VAT is set.
 */
export const TaxClassificationSelect = ({
  disabled = false,
  onChange,
  taxRates,
  value,
}: TaxClassificationSelectProps) => {
  const k = useProductLabel();
  const labels = useTaxLabels();
  const choices = classificationChoices(taxRates, DateTime.nowUnsafe());
  const selected = choices.find((choice) => choice.code === value);
  const none = noTaxRates(taxRates);
  const scheduledHint = selected === undefined ? undefined : labels.scheduled(selected);
  const hint = none ? labels.noRates : scheduledHint;
  return (
    <SelectTemplate
      disabled={disabled || none}
      {...(hint === undefined ? {} : { helpText: hint })}
      items={choices.map((choice) => ({
        ...selectItem(choice.code, labels.choice(choice)),
        disabled: !choiceAvailable(choice),
      }))}
      label={k('fields.vat')}
      name="taxClassification"
      onValueChange={(details) => {
        const [next] = details.value;
        const picked = choices.find((choice) => choice.code === next && choiceAvailable(choice));
        if (picked !== undefined) {
          onChange(picked.code);
        }
      }}
      placeholder={k('selectPlaceholder')}
      value={[value]}
    />
  );
};
