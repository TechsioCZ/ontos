import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { NumericInput } from '@techsio/ui-kit/atoms/numeric-input';
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import { FormNumericInput } from '@techsio/ui-kit/molecules/form-numeric-input';
import { formatMoney, formatNumber, comboboxTranslations } from '@app/admin-ui';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import type { ProductId, VariantId } from '../../../../../shared/domain/merchandise-model.ts';
import { WHOLE_NUMBER_FORMAT } from '../../../../form-number.ts';

export interface DraftLine {
  readonly key: string;
  readonly productId: ProductId | null;
  readonly quantity: number;
  /** The quantity input's text, kept as typed so "2,5" reaches validation instead of becoming 25. */
  readonly quantityText: string;
  /** Chosen variant of a product with sellable variants. */
  readonly variantId?: VariantId | null;
}

export type DraftLinePatch = Partial<Pick<DraftLine, 'productId' | 'quantity' | 'quantityText' | 'variantId'>>;

/** One pickable unit: a product without variants, or one active variant of a product. */
export const pickItems = (products: readonly ProductRecord[]) =>
  products.flatMap((item) => {
    const variants = (item.variantRecords ?? []).filter((variant) => variant.active);
    return variants.length === 0
      ? [{ id: item.id, label: `${item.name} (${item.sku})`, value: item.id }]
      : variants.map((variant) => ({
          id: `${item.id}|${variant.id}`,
          label: `${item.name} — ${variant.name} (${variant.sku})`,
          value: `${item.id}|${variant.id}`,
        }));
  });

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
  const variant = product?.variantRecords?.find((entry) => entry.id === line.variantId);
  const selected =
    line.productId === null ? [] : [line.variantId === undefined || line.variantId === null ? line.productId : `${line.productId}|${line.variantId}`];

  return (
    <div className="flex flex-col gap-100 rounded-md border border-border-primary p-150">
      <div className="grid grid-cols-[minmax(0,1fr)_7rem_auto] items-end gap-150">
        <div className="min-w-0">
          {/* Not clearable: ui-kit names the clear control "Clear value" in English; picking another product replaces it. */}
          <Combobox
            clearable={false}
            translations={comboboxTranslations}
            {...(error === undefined ? {} : { helpText: error })}
            items={pickItems(products)}
            label={t(key('create.product'))}
            noResultsMessage={t(key('create.noMatch'))}
            onChange={(values) => {
              const [productPart, variantPart] = (firstValue(values) ?? '').split('|');
              const picked = products.find((item) => item.id === productPart);
              const pickedVariant = picked?.variantRecords?.find((entry) => entry.id === variantPart);
              onChange({ productId: picked?.id ?? null, variantId: pickedVariant?.id ?? null });
            }}
            placeholder={t(key('create.product'))}
            validateStatus={error === undefined ? 'default' : 'error'}
            value={selected}
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
            onValueChange={(details) => onChange({ quantity: details.valueAsNumber, quantityText: details.value })}
            step={1}
            value={line.quantityText}
          >
            <NumericInput.Control>
              <NumericInput.Input aria-valuemax={undefined} />
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
            price: formatMoney(variant?.priceMinor ?? product.currentPriceMinor),
            stock: formatNumber(variant?.stockOnHand ?? product.stockOnHand),
          })}
        </p>
      )}
    </div>
  );
};
