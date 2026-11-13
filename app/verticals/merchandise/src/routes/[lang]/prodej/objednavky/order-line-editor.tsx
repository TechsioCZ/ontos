import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { NumericInput } from '@techsio/ui-kit/atoms/numeric-input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormNumericInput } from '@techsio/ui-kit/molecules/form-numeric-input';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { selectItem } from '../../../../ui/select-item.ts';
import { formatMoney, formatNumber, surfaceTileClassName } from '@app/admin-ui';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import { WHOLE_NUMBER_FORMAT } from '../../../../form-number.ts';
import { loadProductRecord } from '../../provoz/produkty/product-reads.ts';
import type { ProductRecordState } from '../../provoz/produkty/product-reads.ts';
import { ProductSearchCombobox } from '../../provoz/produkty/product-search.tsx';
import { activeVariants, lineClassification, lineProduct } from './order-line-draft.ts';
import { useTaxLabels } from '../../provoz/produkty/product-tax-classification.ts';
import type { CompanyVat } from '../../provoz/produkty/product-tax-classification.ts';
import { DateTime } from 'effect';
import type { DraftLine, DraftLinePatch } from './order-line-draft.ts';

const key = (path: string) => `merchandise.pages.orders.${path}`;

interface OrderLineEditorProps {
  readonly canRemove: boolean;
  readonly error: string | undefined;
  readonly line: DraftLine;
  readonly onChange: (patch: DraftLinePatch) => void;
  /** The picked product's record arrived; the caller keeps it only while that product is still picked. */
  readonly onRecord: (productId: ProductRecord['id'], record: ProductRecordState) => void;
  readonly onRemove: () => void;
  /** The company's VAT rates from the staff records read; the line's VAT comes from its product's classification. */
  readonly vat: CompanyVat;
}

/**
 * One order line: product search (active products), variant when the product has some, its current price, stock and
 * VAT, quantity, remove. The full product record is read once the product is picked.
 */
export const OrderLineEditor = ({
  canRemove,
  error,
  line,
  onChange,
  onRecord,
  onRemove,
  vat,
}: OrderLineEditorProps) => {
  const { t } = useModernI18n();
  const taxLabels = useTaxLabels();
  const product = lineProduct(line);
  const classification = lineClassification(product, vat, DateTime.nowUnsafe());
  const variants = activeVariants(product);
  const variant = variants.find((entry) => entry.id === line.variantId);
  return (
    <div className={`${surfaceTileClassName} flex flex-col gap-100 p-150`}>
      {/* On a phone the product search takes its own row; quantity and removal sit below it. */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-150 sm:grid-cols-[minmax(0,1fr)_9rem_auto]">
        <div className="col-span-2 min-w-0 sm:col-span-1">
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
          items={variants.map((entry) => selectItem(entry.id, `${entry.name} (${entry.sku})`))}
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
      {product !== null && classification === null && (
        <StatusText showIcon size="sm" status="error">
          {taxLabels.noClassification}
        </StatusText>
      )}
      {product !== null && classification !== null && classification.current === undefined && (
        <StatusText showIcon size="sm" status="error">
          {taxLabels.rateMissing(classification.code, classification.problem)}
        </StatusText>
      )}
      {product !== null && classification !== null && (
        <p className="text-fg-secondary text-xs">
          {t(key('create.productMeta'), {
            price: formatMoney(variant?.priceMinor ?? product.currentPriceMinor),
            stock: formatNumber(variant?.stockOnHand ?? product.stockOnHand),
            vat: taxLabels.choice(classification),
          })}
        </p>
      )}
    </div>
  );
};
