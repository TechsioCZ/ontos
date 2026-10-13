import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { NumericInput } from '@techsio/ui-kit/atoms/numeric-input';
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import { FormNumericInput } from '@techsio/ui-kit/molecules/form-numeric-input';
import { formatMoney, formatNumber, comboboxTranslations } from '@app/admin-ui';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import type { ProductId } from '../../../../../shared/domain/merchandise-model.ts';
import { NO_ARIA_MAX, WHOLE_NUMBER_FORMAT } from '../../../../form-number.ts';

export interface DraftLine {
  readonly key: string;
  readonly productId: ProductId | null;
  readonly quantity: number;
}

export type DraftLinePatch = Partial<Pick<DraftLine, 'productId' | 'quantity'>>;

const key = (path: string) => `merchandise.pages.orders.${path}`;

const firstValue = (value: string | string[]) => (Array.isArray(value) ? value[0] : value);

interface OrderLineEditorProps {
  readonly canRemove: boolean;
  readonly error: string | undefined;
  readonly line: DraftLine;
  readonly onChange: (patch: DraftLinePatch) => void;
  readonly onRemove: () => void;
  /** Active products only; the caller filters them. */
  readonly products: readonly ProductRecord[];
}

/** One order line: product pick with its current price and stock, quantity, remove. */
export const OrderLineEditor = ({ canRemove, error, line, onChange, onRemove, products }: OrderLineEditorProps) => {
  const { t } = useModernI18n();
  const product = products.find((item) => item.id === line.productId);

  return (
    <div className="flex flex-col gap-100 rounded-md border border-border-primary p-150">
      <div className="grid grid-cols-[minmax(0,1fr)_7rem_auto] items-end gap-150">
        <div className="min-w-0">
          {/* Not clearable: ui-kit names the clear control "Clear value" in English; picking another product replaces it. */}
          <Combobox
            clearable={false}
            translations={comboboxTranslations}
            {...(error === undefined ? {} : { helpText: error })}
            items={products.map((item) => ({ id: item.id, label: `${item.name} (${item.sku})`, value: item.id }))}
            label={t(key('create.product'))}
            noResultsMessage={t(key('create.noMatch'))}
            onChange={(values) => {
              const next = firstValue(values);
              onChange({ productId: products.find((item) => item.id === next)?.id ?? null });
            }}
            placeholder={t(key('create.product'))}
            validateStatus={error === undefined ? 'default' : 'error'}
            value={line.productId === null ? [] : [line.productId]}
          />
        </div>
        <div className="min-w-0">
          <FormNumericInput
            formatOptions={WHOLE_NUMBER_FORMAT}
            id={`orders-create-qty-${line.key}`}
            label={t(key('create.quantity'))}
            locale="cs-CZ"
            min={1}
            name="quantity"
            onChange={(value) => onChange({ quantity: value })}
            step={1}
            value={line.quantity}
          >
            <NumericInput.Control>
              <NumericInput.Input {...NO_ARIA_MAX} />
            </NumericInput.Control>
          </FormNumericInput>
        </div>
        <Button
          aria-label={t(key('create.removeLine'))}
          disabled={!canRemove}
          icon="icon-[mdi--delete-outline]"
          onClick={onRemove}
          size="sm"
          theme="borderless"
          variant="secondary"
        />
      </div>
      {product !== undefined && (
        <p className="text-fg-secondary text-xs">
          {t(key('create.productMeta'), {
            price: formatMoney(product.currentPriceMinor),
            stock: formatNumber(product.stockOnHand),
          })}
        </p>
      )}
    </div>
  );
};
