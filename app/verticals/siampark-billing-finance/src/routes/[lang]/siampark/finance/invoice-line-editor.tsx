import type { ProductRecord } from '@app/merchandise/contracts/records';
import { formatMoney, matchesSearch, comboboxTranslations, surfaceTileClassName } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { NumericInput } from '@techsio/ui-kit/atoms/numeric-input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormNumericInput } from '@techsio/ui-kit/molecules/form-numeric-input';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { useState } from 'react';
import {
  czkToMinor,
  newDraftLine,
  VAT_RATE_CHOICES,
  withProductSnapshot,
} from '../../../../../shared/domain/invoice-draft.ts';
import type { DraftDiscountKind, DraftLine, DraftLineIssue } from '../../../../../shared/domain/invoice-draft.ts';
import { draftLineDiscount, toInvoiceLine } from '../../../../../shared/domain/invoice-draft.ts';
import { lineDiscountMinor } from '../../../../../shared/domain/invoice-totals.ts';
import type { PriceListItem } from '../../../../../shared/apis/records.ts';
import { formLabelProps } from './invoice-view.ts';

const ns = 'siampark-billing-finance.faktury';

interface InvoiceLineEditorProps {
  readonly canRemove: boolean;
  readonly issue: DraftLineIssue | undefined;
  readonly line: DraftLine;
  readonly onChange: (next: DraftLine) => void;
  readonly onRemove: () => void;
  /** 1-based line number; names the line group and its remove button, so each line is told apart. */
  readonly position: number;
  /** Active finance price-list items offered for free lines. */
  readonly priceList?: readonly PriceListItem[];
  /** Active products only; the caller filters them. */
  readonly products: readonly ProductRecord[];
  readonly productsReadable: boolean;
}

const DISCOUNT_KINDS: readonly (readonly [DraftDiscountKind, string])[] = [
  ['NONE', 'Bez slevy'],
  ['PERCENT', 'Procentem'],
  ['AMOUNT', 'Částkou'],
];

const priceFormatOptions: Intl.NumberFormatOptions = { maximumFractionDigits: 2, minimumFractionDigits: 0 };
// Without a format the input parses with parseFloat, which stops at the decimal comma: `2,25` became 2.
// Three digits keep a typed fraction visible so `lineIssue` can reject it with a message.
const quantityFormatOptions: Intl.NumberFormatOptions = { maximumFractionDigits: 3, minimumFractionDigits: 0 };

/** One invoice line: a product (snapshot on pick) or free text, then quantity, and price and VAT for free text. */
export const InvoiceLineEditor = ({
  canRemove,
  issue,
  line,
  onChange,
  onRemove,
  position,
  priceList = [],
  products,
  productsReadable,
}: InvoiceLineEditorProps) => {
  const { t } = useModernI18n();
  const [productQuery, setProductQuery] = useState('');
  const productComboboxId = `invoice-line-product-${line.key}`;
  const productItems = products.flatMap((item) => {
    const label = `${item.name} (${item.sku})`;
    return matchesSearch(label, productQuery) ? [{ id: item.id, label, value: item.id }] : [];
  });
  const product = products.find((item) => item.id === line.productId);
  const errorText = issue === undefined ? undefined : t(`${ns}.form.error.${issue}`);
  // Shown once the line is being filled in, so a freshly added line does not open with a warning.
  const filledIn = line.kind === 'product' ? line.productId !== null : line.description.trim() !== '';
  const zeroPriceLine = line.unitPriceMinor === 0 && filledIn;
  // `displayValue` names the hidden native option too; without it the option reads as the raw value.
  const kindItems = [
    ...(productsReadable
      ? [{ displayValue: t(`${ns}.form.kindProduct`), label: t(`${ns}.form.kindProduct`), value: 'product' }]
      : []),
    { displayValue: t(`${ns}.form.kindFree`), label: t(`${ns}.form.kindFree`), value: 'free' },
  ];
  const vatItems = VAT_RATE_CHOICES.map((rate) => ({
    displayValue: `${rate} %`,
    label: `${rate} %`,
    value: String(rate),
  }));

  return (
    // A named fieldset per line, so the line's inputs and its remove button read as "Položka 2" and not as a
    // copy of the first line.
    <fieldset
      aria-label={t(`${ns}.form.lineGroup`, { position })}
      className={`${surfaceTileClassName} m-0 flex min-w-0 flex-col gap-100 p-150`}
    >
      <div className="finance-invoice-line-identity grid items-end gap-150">
        <div className="min-w-0">
          <SelectTemplate
            items={kindItems}
            label={t(`${ns}.form.lineKind`)}
            labelProps={formLabelProps}
            name={`invoice-line-kind-${line.key}`}
            onValueChange={({ value }) => {
              const kind = value[0] === 'free' ? 'free' : 'product';
              if (kind !== line.kind) {
                onChange(newDraftLine(line.key, kind));
              }
            }}
            placeholder={t('siampark-billing-finance.selectPlaceholder')}
            value={[line.kind]}
          />
        </div>
        <div className="min-w-0">
          {line.kind === 'product' ? (
            <Combobox
              filterBehavior="external"
              id={productComboboxId}
              items={productItems}
              label={t(`${ns}.form.product`)}
              noResultsMessage={t(`${ns}.form.noProducts`)}
              onChange={(values) => {
                const next = products.find((item) => item.id === values[0]);
                if (next !== undefined) {
                  onChange(withProductSnapshot(line, next));
                }
              }}
              onInputValueChange={setProductQuery}
              onOpenChange={() => setProductQuery('')}
              openOnClick
              placeholder={t(`${ns}.form.product`)}
              translations={comboboxTranslations}
              value={line.productId === null ? [] : [line.productId]}
            />
          ) : (
            <FormInput
              autoComplete="off"
              id={`invoice-line-description-${line.key}`}
              label={t(`${ns}.form.description`)}
              name="description"
              onChange={(event) => onChange({ ...line, description: event.target.value })}
              placeholder={productsReadable ? undefined : t(`${ns}.form.rentalDescriptionPlaceholder`)}
              value={line.description}
            />
          )}
        </div>
        <Button
          aria-label={t(`${ns}.form.removeLine`, { position })}
          disabled={!canRemove}
          icon="icon-[mdi--delete-outline]"
          onClick={onRemove}
          size="sm"
          theme="borderless"
          variant="secondary"
        />
      </div>
      <div className="finance-invoice-line-values grid items-end gap-150">
        <div className="min-w-0">
          <FormNumericInput
            // Blur must not clamp a typed 0,001 to 1; `lineIssue` rejects it with a message instead.
            clampValueOnBlur={false}
            formatOptions={quantityFormatOptions}
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
        {line.kind === 'free' && (
          <>
            <div className="min-w-0">
              <FormNumericInput
                // Two decimals at most, so `1234,5` stays 1 234,50 Kč instead of being rounded to whole crowns.
                // Blur must not clamp a typed -100 to 0; `lineIssue` rejects it with a message instead.
                clampValueOnBlur={false}
                formatOptions={priceFormatOptions}
                id={`invoice-line-price-${line.key}`}
                label={t(`${ns}.form.unitPrice`)}
                locale="cs-CZ"
                min={0}
                name="unitPrice"
                // Text that is not a price stores NaN, so `lineIssue` reports `price` instead of a silent 0.
                onChange={(value) =>
                  onChange({ ...line, unitPriceMinor: Number.isFinite(value) ? czkToMinor(value) : Number.NaN })
                }
                step={0.01}
                // A NaN price leaves the field uncontrolled, so the typed text stays visible next to the error.
                {...(Number.isFinite(line.unitPriceMinor) ? { value: line.unitPriceMinor / 100 } : {})}
              >
                <NumericInput.Control>
                  <NumericInput.Input />
                </NumericInput.Control>
              </FormNumericInput>
            </div>
            <div className="min-w-0">
              <SelectTemplate
                items={vatItems}
                label={t(`${ns}.form.vat`)}
                labelProps={formLabelProps}
                name={`invoice-line-vat-${line.key}`}
                onValueChange={({ value }) => {
                  const rate = VAT_RATE_CHOICES.find((item) => String(item) === value[0]);
                  if (rate !== undefined) {
                    onChange({ ...line, vatRate: rate });
                  }
                }}
                placeholder={t('siampark-billing-finance.selectPlaceholder')}
                value={[String(line.vatRate)]}
              />
            </div>
          </>
        )}
      </div>
      {line.kind === 'free' && priceList.length > 0 && (
        <div className="min-w-0">
          <SelectTemplate
            items={[
              { displayValue: 'Ruční zadání', label: 'Ruční zadání', value: 'MANUAL' },
              ...priceList.map((item) => {
                const label = `${item.name} · ${formatMoney(item.unitPriceMinor)}${item.unit === undefined ? '' : ` / ${item.unit}`}`;
                return { displayValue: label, label, value: item.id };
              }),
            ]}
            label="Z ceníku"
            labelProps={formLabelProps}
            name={`invoice-line-price-list-${line.key}`}
            onValueChange={({ value }) => {
              const item = priceList.find((entry) => entry.id === value[0]);
              onChange(
                item === undefined
                  ? { ...line, priceListItemId: null }
                  : {
                      ...line,
                      description: item.name,
                      priceListItemId: item.id,
                      unitPriceMinor: item.unitPriceMinor,
                      vatRate: item.vatRate,
                    },
              );
            }}
            value={[line.priceListItemId ?? 'MANUAL']}
          />
        </div>
      )}
      <div className="finance-invoice-line-discount grid grid-cols-1 items-end gap-150 sm:grid-cols-[10rem_8rem_minmax(0,1fr)]">
        <SelectTemplate
          items={DISCOUNT_KINDS.map(([value, label]) => ({ displayValue: label, label, value }))}
          label="Sleva"
          labelProps={formLabelProps}
          name={`invoice-line-discount-kind-${line.key}`}
          onValueChange={({ value }) => {
            const kind = DISCOUNT_KINDS.find(([entry]) => entry === value[0])?.[0] ?? 'NONE';
            onChange({
              ...line,
              discountKind: kind,
              ...(kind === 'NONE' ? { discountInput: '', discountReason: '', discountValue: Number.NaN } : {}),
            });
          }}
          value={[line.discountKind ?? 'NONE']}
        />
        {(line.discountKind ?? 'NONE') !== 'NONE' && (
          <>
            <FormInput
              id={`invoice-line-discount-value-${line.key}`}
              inputMode="decimal"
              label={line.discountKind === 'PERCENT' ? 'Sleva (%)' : 'Sleva (Kč)'}
              onChange={(event) => {
                const raw = event.target.value;
                const parsed = Number(raw.replaceAll(/\s/gu, '').replace(',', '.'));
                onChange({ ...line, discountInput: raw, discountValue: raw.trim() === '' ? Number.NaN : parsed });
              }}
                value={line.discountInput ?? ''}
            />
            <FormInput
              id={`invoice-line-discount-reason-${line.key}`}
              label="Důvod schválené slevy"
              onChange={(event) => onChange({ ...line, discountReason: event.target.value })}
              placeholder="např. věrnostní sleva podle smlouvy"
                value={line.discountReason ?? ''}
            />
          </>
        )}
      </div>
      {draftLineDiscount(line) !== undefined && (
        <p className="text-fg-secondary text-xs">
          Sleva {formatMoney(lineDiscountMinor(toInvoiceLine(line)))} se na dokladu zobrazí samostatně i s důvodem.
        </p>
      )}
      {line.kind === 'product' && product !== undefined && (
        <p className="text-fg-secondary text-xs">
          {t(`${ns}.form.productMeta`, {
            price: formatMoney(line.unitPriceMinor),
            vat: line.vatRate,
          })}
        </p>
      )}
      {errorText !== undefined && (
        <StatusText showIcon size="sm" status="error">
          {errorText}
        </StatusText>
      )}
      {/* 0 Kč is a valid free line (e.g. a gift), so it warns instead of blocking the submit. */}
      {errorText === undefined && zeroPriceLine && (
        <StatusText showIcon size="sm" status="warning">
          {t(`${ns}.form.zeroPriceWarning`)}
        </StatusText>
      )}
    </fieldset>
  );
};
