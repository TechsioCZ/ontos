import type { ProductRecord } from '@app/merchandise/contracts/records';
import { formatMoney } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { NumericInput } from '@techsio/ui-kit/atoms/numeric-input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormNumericInput } from '@techsio/ui-kit/molecules/form-numeric-input';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import {
  czkToMinor,
  newDraftLine,
  VAT_RATE_CHOICES,
  withProductSnapshot,
} from '../../../../../shared/domain/invoice-draft.ts';
import type { DraftLine, DraftLineIssue } from '../../../../../shared/domain/invoice-draft.ts';

const ns = 'siampark-billing-finance.faktury';

interface InvoiceLineEditorProps {
  readonly canRemove: boolean;
  readonly issue: DraftLineIssue | undefined;
  readonly line: DraftLine;
  readonly onChange: (next: DraftLine) => void;
  readonly onRemove: () => void;
  /** Active products only; the caller filters them. */
  readonly products: readonly ProductRecord[];
}

/** One invoice line: a product (snapshot on pick) or free text, then quantity, and price and VAT for free text. */
export const InvoiceLineEditor = ({ canRemove, issue, line, onChange, onRemove, products }: InvoiceLineEditorProps) => {
  const { t } = useModernI18n();
  const product = products.find((item) => item.id === line.productId);
  const errorText = issue === undefined ? undefined : t(`${ns}.form.error.${issue}`);
  const kindItems = [
    { label: t(`${ns}.form.kindProduct`), value: 'product' },
    { label: t(`${ns}.form.kindFree`), value: 'free' },
  ];
  const vatItems = VAT_RATE_CHOICES.map((rate) => ({ label: `${rate} %`, value: String(rate) }));

  return (
    <div className="flex flex-col gap-100 rounded-md border border-border-primary p-150">
      <div className="flex items-end gap-150">
        <div className="w-36 shrink-0">
          <SelectTemplate
            items={kindItems}
            label={t(`${ns}.form.lineKind`)}
            name={`invoice-line-kind-${line.key}`}
            onValueChange={({ value }) => {
              const kind = value[0] === 'free' ? 'free' : 'product';
              if (kind !== line.kind) {
                onChange(newDraftLine(line.key, kind));
              }
            }}
            value={[line.kind]}
          />
        </div>
        <div className="min-w-0 flex-1">
          {line.kind === 'product' ? (
            <Combobox
              items={products.map((item) => ({ id: item.id, label: `${item.name} (${item.sku})`, value: item.id }))}
              label={t(`${ns}.form.product`)}
              noResultsMessage={t(`${ns}.form.noProducts`)}
              onChange={(values) => {
                const next = products.find((item) => item.id === values[0]);
                if (next !== undefined) {
                  onChange(withProductSnapshot(line, next));
                }
              }}
              placeholder={t(`${ns}.form.product`)}
              value={line.productId === null ? [] : [line.productId]}
            />
          ) : (
            <FormInput
              id={`invoice-line-description-${line.key}`}
              label={t(`${ns}.form.description`)}
              name="description"
              onChange={(event) => onChange({ ...line, description: event.target.value })}
              value={line.description}
            />
          )}
        </div>
        <div className="w-24 shrink-0">
          <FormNumericInput
            id={`invoice-line-quantity-${line.key}`}
            label={t(`${ns}.form.quantity`)}
            locale="cs-CZ"
            min={1}
            name="quantity"
            onChange={(value) => onChange({ ...line, quantity: value })}
            step={1}
            value={line.quantity}
          >
            <NumericInput.Control>
              <NumericInput.Input />
            </NumericInput.Control>
          </FormNumericInput>
        </div>
        <Button
          aria-label={t(`${ns}.form.removeLine`)}
          disabled={!canRemove}
          icon="icon-[mdi--delete-outline]"
          onClick={onRemove}
          size="sm"
          theme="borderless"
          variant="secondary"
        />
      </div>
      {line.kind === 'free' ? (
        <div className="flex items-end gap-150">
          <div className="w-40 shrink-0">
            <FormNumericInput
              id={`invoice-line-price-${line.key}`}
              label={t(`${ns}.form.unitPrice`)}
              locale="cs-CZ"
              min={0}
              name="unitPrice"
              onChange={(value) => onChange({ ...line, unitPriceMinor: czkToMinor(value) })}
              step={1}
              value={line.unitPriceMinor / 100}
            >
              <NumericInput.Control>
                <NumericInput.Input />
              </NumericInput.Control>
            </FormNumericInput>
          </div>
          <div className="w-28 shrink-0">
            <SelectTemplate
              items={vatItems}
              label={t(`${ns}.form.vat`)}
              name={`invoice-line-vat-${line.key}`}
              onValueChange={({ value }) => {
                const rate = VAT_RATE_CHOICES.find((item) => String(item) === value[0]);
                if (rate !== undefined) {
                  onChange({ ...line, vatRate: rate });
                }
              }}
              value={[String(line.vatRate)]}
            />
          </div>
        </div>
      ) : (
        product !== undefined && (
          <p className="text-fg-secondary text-xs">
            {t(`${ns}.form.productMeta`, {
              price: formatMoney(line.unitPriceMinor),
              vat: line.vatRate,
            })}
          </p>
        )
      )}
      {errorText !== undefined && (
        <StatusText showIcon status="error">
          {errorText}
        </StatusText>
      )}
    </div>
  );
};
