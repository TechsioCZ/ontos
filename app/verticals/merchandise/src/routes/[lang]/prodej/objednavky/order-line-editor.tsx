import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { NumericInput } from '@techsio/ui-kit/atoms/numeric-input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormNumericInput } from '@techsio/ui-kit/molecules/form-numeric-input';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { formatMoney, formatNumber, surfaceTileClassName } from '@app/admin-ui';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import type { VariantId, VariantRecord } from '../../../../../shared/domain/merchandise-model.ts';
import { WHOLE_NUMBER_FORMAT } from '../../../../form-number.ts';
import { loadProductRecord } from '../../provoz/produkty/product-reads.ts';
import type { ProductRecordState } from '../../provoz/produkty/product-reads.ts';
import { ProductSearchCombobox } from '../../provoz/produkty/product-search.tsx';

export interface DraftLine {
  readonly key: string;
  /** The picked list row; its full record arrives in `record`. */
  readonly picked: Pick<ProductRecord, 'id' | 'name' | 'sku'> | null;
  /** Full record of the picked product (variants, prices), read on pick. */
  readonly record: ProductRecordState;
  readonly quantity: number;
  /** The quantity input's text, kept as typed so "2,5" reaches validation instead of becoming 25. */
  readonly quantityText: string;
  /** Chosen variant of a product with sellable variants. */
  readonly variantId: VariantId | null;
}

export type DraftLinePatch = Partial<Pick<DraftLine, 'picked' | 'quantity' | 'quantityText' | 'record' | 'variantId'>>;

/** The full record of a line's product once it has loaded. */
export const lineProduct = (line: DraftLine): ProductRecord | null =>
  line.record.status === 'ready' ? line.record.product : null;

/** Active variants of a product; a product without them is sold as itself. */
export const activeVariants = (product: ProductRecord | null): readonly VariantRecord[] =>
  (product?.variantRecords ?? []).filter((variant) => variant.active);

const key = (path: string) => `merchandise.pages.orders.${path}`;

interface OrderLineEditorProps {
  readonly canRemove: boolean;
  readonly error: string | undefined;
  readonly line: DraftLine;
  readonly onChange: (patch: DraftLinePatch) => void;
  /** The picked product's record arrived; the caller keeps it only while that product is still picked. */
  readonly onRecord: (productId: ProductRecord['id'], record: ProductRecordState) => void;
  readonly onRemove: () => void;
}

/**
 * One order line: product search (active products), variant when the product has some, its current price and
 * stock, quantity, remove. The full product record is read once the product is picked.
 */
export const OrderLineEditor = ({ canRemove, error, line, onChange, onRecord, onRemove }: OrderLineEditorProps) => {
  const { t } = useModernI18n();
  const product = lineProduct(line);
  const variants = activeVariants(product);
  const variant = variants.find((entry) => entry.id === line.variantId);
  return (
    <div className={`${surfaceTileClassName} flex flex-col gap-100 p-150`}>
      <div className="grid grid-cols-[minmax(0,1fr)_7rem_auto] items-end gap-150">
        <div className="min-w-0">
          <ProductSearchCombobox
            activeOnly
            errorMessage={t(key('create.productsFailed'))}
            {...(error === undefined ? {} : { helpText: error })}
            id={`orders-create-product-${line.key}`}
            label={t(key('create.product'))}
            loadingMessage={t('merchandise.loading')}
            noResultsMessage={t(key('create.noMatch'))}
            onSelect={(picked) => {
              onChange({ picked, record: { status: picked === null ? 'idle' : 'loading' }, variantId: null });
              if (picked !== null) {
                loadProductRecord(picked.id, (record) => onRecord(picked.id, record));
              }
            }}
            placeholder={t(key('create.product'))}
            retryLabel={t(key('states.retry'))}
            selected={line.picked}
            validateStatus={error === undefined ? 'default' : 'error'}
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
      {variants.length > 0 && (
        <SelectTemplate
          items={variants.map((entry) => ({ label: `${entry.name} (${entry.sku})`, value: entry.id }))}
          label={t(key('create.variant'))}
          name={`variant-${line.key}`}
          onValueChange={(details) => {
            const [next] = details.value;
            onChange({ variantId: variants.find((entry) => entry.id === next)?.id ?? null });
          }}
          placeholder={t(key('create.variantPlaceholder'))}
          size="sm"
          value={line.variantId === null ? [] : [line.variantId]}
        />
      )}
      {line.record.status === 'error' && (
        <StatusText showIcon status="error">
          {t(key('create.productFailed'))}
        </StatusText>
      )}
      {product !== null && (
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
