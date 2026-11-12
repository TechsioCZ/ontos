import { SelectTemplate } from '@app/admin-ui/select-template';
import type { CzVatClassificationCode } from '@app/shared-contracts/cz-vat-classifications';
import { DateTime } from 'effect';
import { selectItem } from '../../../../ui/select-item.ts';
import { useProductLabel } from './product-form-labels.ts';
import { choiceAvailable, classificationChoices, noTaxRates, useTaxLabels } from './product-tax-classification.ts';
import type { CompanyVat } from './product-tax-classification.ts';

interface TaxClassificationSelectProps {
  readonly disabled?: boolean;
  readonly onChange: (code: CzVatClassificationCode) => void;
  readonly value: CzVatClassificationCode;
  /** The selected company's rates from the staff records read (current and scheduled periods). */
  readonly vat: CompanyVat;
}

/**
 * The product's VAT: one of the two classifications, named with the rate Tax gives it now. A classification the
 * company has no rule for is offered disabled and says so; a scheduled change shows under the select. A company Tax
 * gives no rate at all keeps the select closed and says that no VAT is set.
 */
export const TaxClassificationSelect = ({ disabled = false, onChange, value, vat }: TaxClassificationSelectProps) => {
  const k = useProductLabel();
  const labels = useTaxLabels();
  const choices = classificationChoices(vat, DateTime.nowUnsafe());
  const selected = choices.find((choice) => choice.code === value);
  const none = noTaxRates(vat);
  const scheduledHint = selected === undefined ? undefined : labels.scheduled(selected);
  const regimeHint = vat.regime === 'NON_PAYER' ? labels.nonPayerHint : scheduledHint;
  const confirmation = labels.confirmation(vat, DateTime.nowUnsafe());
  const shown = none ? labels.noRates : regimeHint;
  const hint = [shown, confirmation].filter((part) => part !== undefined).join(' ') || undefined;
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
