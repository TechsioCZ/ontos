import { formatMoney, formatNumber } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { NumericInput } from '@techsio/ui-kit/atoms/numeric-input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { Option, Schema } from 'effect';
import { FormNumericInput } from '@techsio/ui-kit/molecules/form-numeric-input';
import { useRef, useState } from 'react';
import {
  OpportunityLineSchema,
  VatRateSchema,
  opportunityAmountMinor,
} from '../../../../../shared/model/opportunity.ts';
import type { OpportunityLine } from '../../../../../shared/model/opportunity.ts';
import { PickerCombobox } from './pipeline-combobox.tsx';
import {
  MAX_LINE_QUANTITY,
  filterItemsByQuery,
  firstValue,
  isValidQuantity,
  isSafeOpportunityAmount,
  manualOpportunityLine,
} from './pipeline-model.ts';
import type { LoadState, ProductOption } from './pipeline-references.ts';

const K = 'sales-pipeline.pages.records';

/**
 * ui-kit parses a number field with `parseFloat` unless it gets format options, which reads `1,5` as `1`.
 * With these options the parser follows cs-CZ, so a decimal stays visible and is reported as invalid.
 */
const quantityFormatOptions = { maximumFractionDigits: 3 };

export interface LineEntry {
  readonly invalidAmount?: boolean;
  /**
   * The number typed into the quantity field when it is not a whole number of at least 1. The field keeps showing
   * it and the line reports it; `line` keeps the last valid quantity.
   */
  readonly invalidQuantity?: number;
  readonly key: string;
  readonly line: OpportunityLine;
}

interface PickState {
  readonly description: string;
  readonly price: number;
  readonly productId: string | null;
  readonly quantity: number;
  readonly vat: OpportunityLine['vatRate'];
}

const emptyPick: PickState = { description: '', price: 0, productId: null, quantity: 1, vat: 21 };

interface LinesEditorProps {
  readonly lines: readonly LineEntry[];
  readonly onChange: (lines: readonly LineEntry[]) => void;
  readonly products: LoadState<readonly ProductOption[]>;
}

interface LineRowProps {
  readonly entry: LineEntry;
  readonly onQuantity: (value: number) => void;
  readonly onRemove: () => void;
}

const LineRow = ({ entry, onQuantity, onRemove }: LineRowProps) => {
  const { t } = useModernI18n();
  const { invalidAmount, invalidQuantity, line } = entry;
  const quantityInvalid = invalidQuantity !== undefined && invalidAmount !== true;
  return (
    <li className="flex flex-col gap-100 rounded-md border border-border-primary p-150">
      <div className="flex items-center gap-150">
        <div className="flex min-w-0 flex-1 flex-col gap-50">
          <span className="truncate font-medium text-sm">{line.productName}</span>
          <span className="text-fg-secondary text-xs tabular-nums">
            {t(`${K}.create.lineMeta`, {
              price: formatMoney(line.unitPriceMinor),
              quantity: formatNumber(line.quantity),
              vat: line.vatRate,
            })}
          </span>
        </div>
        <div className="w-32 shrink-0">
          <NumericInput
            clampValueOnBlur={false}
            formatOptions={quantityFormatOptions}
            invalid={quantityInvalid || invalidAmount === true}
            locale="cs-CZ"
            max={MAX_LINE_QUANTITY}
            min={1}
            onChange={onQuantity}
            size="sm"
            step={1}
            {...(Number.isFinite(invalidQuantity ?? line.quantity) ? { value: invalidQuantity ?? line.quantity } : {})}
          >
            <NumericInput.Control>
              <NumericInput.Input aria-label={t(`${K}.create.fields.quantity`)} />
            </NumericInput.Control>
          </NumericInput>
        </div>
        {/* A minimum width keeps totals aligned across rows; a longer total grows instead of running into the delete button. */}
        <span className="min-w-28 shrink-0 whitespace-nowrap text-end font-medium text-sm tabular-nums">
          {formatMoney(line.quantity * line.unitPriceMinor)}
        </span>
        <Button
          aria-label={t(`${K}.create.removeLine`)}
          icon="icon-[mdi--delete-outline]"
          onClick={onRemove}
          size="sm"
          theme="borderless"
          type="button"
          variant="secondary"
        />
      </div>
      {invalidAmount === true && (
        <StatusText showIcon size="sm" status="error">
          {t(`${K}.create.errors.amountRange`)}
        </StatusText>
      )}
      {quantityInvalid && (
        <StatusText showIcon size="sm" status="error">
          {t(`${K}.create.errors.quantityRange`, { max: formatNumber(MAX_LINE_QUANTITY) })}
        </StatusText>
      )}
    </li>
  );
};

/**
 * Product lines of an opportunity. A line copies the product's current price and VAT when it is added;
 * that price then stays on the line, so later price changes do not reach it.
 */
export const LinesEditor = ({ lines, onChange, products }: LinesEditorProps) => {
  const { t } = useModernI18n();
  const [pick, setPick] = useState<PickState>(emptyPick);
  const [lineError, setLineError] = useState<string>();
  const [productQuery, setProductQuery] = useState('');
  /** Local React keys for draft lines; never sent to the server. */
  const keySequence = useRef(0);

  const activeProducts = products.status === 'ready' ? products.items.filter((item) => item.active) : [];
  const manual = products.status === 'ready' && activeProducts.length === 0;
  const pickedProduct = activeProducts.find((item) => item.id === pick.productId);
  const productItems = activeProducts.map((product) => ({
    id: product.id,
    label: `${product.sku} – ${product.name}`,
    value: product.id,
  }));
  // The list filters on the typed text here, not inside Combobox, so it always follows the input.
  const shownProductItems = filterItemsByQuery(
    productItems,
    productQuery,
    productItems.find((item) => item.value === pick.productId)?.label,
  );
  const total = opportunityAmountMinor(lines.map((entry) => entry.line));
  // The typed quantity is kept as entered so an invalid value is reported, not silently replaced.
  const quantityValid = isValidQuantity(pick.quantity);

  /** Adds the picked product. A missing product says so here; an invalid quantity is already reported on its field. */
  const addLine = () => {
    if (!quantityValid) {
      return;
    }
    let line: Option.Option<OpportunityLine> = Option.none();
    if (manual) {
      line = manualOpportunityLine(pick.description, pick.quantity, pick.price, pick.vat);
    } else if (pickedProduct !== undefined) {
      line = Schema.decodeOption(OpportunityLineSchema)({
        productId: pickedProduct.id,
        productName: pickedProduct.name,
        quantity: pick.quantity,
        unitPriceMinor: pickedProduct.currentPriceMinor,
        vatRate: pickedProduct.vatRate,
      });
    }
    if (Option.isNone(line)) {
      setLineError(t(`${K}.create.errors.${manual ? 'manualLine' : 'productRequired'}`));
      return;
    }
    if (!isSafeOpportunityAmount([...lines.map((entry) => entry.line), line.value])) {
      setLineError(t(`${K}.create.errors.amountRange`));
      return;
    }
    setLineError(undefined);
    keySequence.current += 1;
    const entry: LineEntry = {
      key: `line-${keySequence.current}`,
      line: line.value,
    };
    onChange([...lines, entry]);
    setPick(emptyPick);
    setProductQuery('');
  };

  /**
   * A valid quantity updates the line; any other number stays as typed and is reported, never replaced. A field
   * that is empty or mid-edit remains invalid until a valid quantity is entered.
   */
  const setQuantity = (key: string, value: number) => {
    onChange(
      lines.map((entry): LineEntry => {
        if (entry.key !== key) {
          return entry;
        }
        if (!isValidQuantity(value)) {
          return { invalidQuantity: value, key: entry.key, line: entry.line };
        }
        const nextLine = { ...entry.line, quantity: value };
        const nextLines = lines.map((item) => (item.key === key ? nextLine : item.line));
        return isSafeOpportunityAmount(nextLines)
          ? { key: entry.key, line: nextLine }
          : { invalidAmount: true, invalidQuantity: value, key: entry.key, line: entry.line };
      }),
    );
  };

  return (
    <section className="flex flex-col gap-150 border-border-primary border-t pt-200">
      <div className="flex flex-wrap items-baseline justify-between gap-100">
        <h2 className="font-semibold text-md">{t(`${K}.create.fields.lines`)}</h2>
        <span className="text-fg-secondary text-xs">{t(`${K}.create.priceFixedHint`)}</span>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_7rem] items-end gap-150">
        <div className="min-w-0">
          {manual ? (
            <FormInput
              helpText={t(`${K}.create.rentHint`)}
              id="opportunity-rent-description"
              label={t(`${K}.create.fields.rentDescription`)}
              maxLength={300}
              onChange={(event) => {
                const description = event.currentTarget.value;
                setPick((current) => ({ ...current, description }));
              }}
              value={pick.description}
            />
          ) : (
            <PickerCombobox
              error={products.status === 'error' ? t(`${K}.create.productsFailed`) : undefined}
              filterBehavior="external"
              items={shownProductItems}
              label={t(`${K}.create.fields.product`)}
              loading={products.status === 'loading'}
              loadingMessage={t('sales-pipeline.loading')}
              noResultsMessage={t(`${K}.create.noProductMatch`)}
              onChange={(values) => {
                setLineError(undefined);
                setPick((current) => ({ ...current, productId: firstValue(values) ?? null }));
              }}
              onInputValueChange={setProductQuery}
              placeholder={t(`${K}.create.productPlaceholder`)}
              value={pick.productId === null ? [] : [pick.productId]}
            />
          )}
        </div>
        <div className="min-w-0">
          <FormNumericInput
            clampValueOnBlur={false}
            formatOptions={quantityFormatOptions}
            helpText={
              quantityValid
                ? undefined
                : t(`${K}.create.errors.quantityRange`, { max: formatNumber(MAX_LINE_QUANTITY) })
            }
            id="opportunity-line-quantity"
            label={t(`${K}.create.fields.quantity`)}
            locale="cs-CZ"
            max={MAX_LINE_QUANTITY}
            min={1}
            name="lineQuantity"
            onChange={(value) => setPick((current) => ({ ...current, quantity: value }))}
            step={1}
            validateStatus={quantityValid ? 'default' : 'error'}
            {...(Number.isFinite(pick.quantity) ? { value: pick.quantity } : {})}
          >
            <NumericInput.Control>
              {/* Enter here adds the line rather than submitting the whole opportunity. The capture handler
                  leaves zag's own key handling (arrows, Home, End) on the field in place. */}
              <NumericInput.Input
                onKeyDownCapture={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addLine();
                  }
                }}
              />
            </NumericInput.Control>
          </FormNumericInput>
        </div>
      </div>
      {manual && (
        <div className="grid grid-cols-2 items-end gap-150">
          <FormNumericInput
            clampValueOnBlur={false}
            formatOptions={{ maximumFractionDigits: 2 }}
            id="opportunity-rent-price"
            label={t(`${K}.create.fields.price`)}
            locale="cs-CZ"
            min={0}
            onChange={(value) => setPick((current) => ({ ...current, price: value }))}
            {...(Number.isFinite(pick.price) ? { value: pick.price } : {})}
          >
            <NumericInput.Control>
              <NumericInput.Input />
            </NumericInput.Control>
          </FormNumericInput>
          <SelectTemplate
            items={[0, 12, 21].map((rate) => ({ label: `${rate} %`, value: String(rate) }))}
            label={t(`${K}.create.fields.vat`)}
            onValueChange={({ value }) => {
              const parsed = Number(value[0]);
              if (Schema.is(VatRateSchema)(parsed)) {
                setPick((current) => ({ ...current, vat: parsed }));
              }
            }}
            value={[String(pick.vat)]}
          />
        </div>
      )}
      <div className="flex items-center justify-between gap-150">
        <p className="min-w-0 text-fg-secondary text-xs">
          {pickedProduct !== undefined &&
            t(`${K}.create.currentPrice`, {
              price: formatMoney(pickedProduct.currentPriceMinor),
              vat: pickedProduct.vatRate,
            })}
        </p>
        {/* Never disabled: a click without a product explains what is missing instead of doing nothing. */}
        <Button icon="icon-[mdi--plus]" onClick={addLine} size="sm" theme="outlined" type="button" variant="secondary">
          {t(`${K}.create.addLine`)}
        </Button>
      </div>
      {lineError !== undefined && (
        <StatusText showIcon status="error">
          {lineError}
        </StatusText>
      )}

      {lines.length === 0 ? (
        <p className="text-fg-secondary text-sm">{t(`${K}.create.noLines`)}</p>
      ) : (
        <ul className="flex flex-col gap-100">
          {lines.map((entry) => (
            <LineRow
              entry={entry}
              key={entry.key}
              onQuantity={(value) => setQuantity(entry.key, value)}
              onRemove={() => onChange(lines.filter((item) => item.key !== entry.key))}
            />
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between gap-150 font-semibold text-sm">
        <span>{t(`${K}.create.total`)}</span>
        <span className="tabular-nums">{formatMoney(total)}</span>
      </div>
    </section>
  );
};
