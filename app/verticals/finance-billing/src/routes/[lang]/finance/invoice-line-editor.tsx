import { formatMoney, matchesSearch, comboboxTranslations, surfaceTileClassName } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { NumericInput } from '@techsio/ui-kit/atoms/numeric-input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Combobox, FormInput, FormNumericInput } from '@app/admin-ui/form-controls';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { useState } from 'react';
import type { ComponentProps } from 'react';
import {
  czkToMinor,
  lineVatProblem,
  newDraftLine,
  withProductSnapshot,
  draftLineDiscount,
} from '../../../../shared/domain/invoice-draft.ts';
import type { DraftDiscountKind, DraftLine, DraftLineIssue } from '../../../../shared/domain/invoice-draft.ts';
import { lineDiscountMinor } from '../../../../shared/domain/invoice-totals.ts';
import { lineVatChoice, lineVatOf } from '../../../../shared/domain/line-vat.ts';
import type { ProductRecord } from './use-finance-references.ts';
import type { InvoiceDirection } from '../../../../shared/domain/line-vat.ts';
import type { PriceListItem } from '../../../../shared/apis/records.ts';
import { formLabelProps } from './invoice-view.ts';
import type { VatChoicesState } from './use-vat-choices.ts';
import { VatChoiceSelect } from './vat-choice-select.tsx';

const ns = 'finance-billing.faktury';

interface InvoiceLineEditorProps {
  readonly canRemove: boolean;
  /** Whose invoice it is: a supplier's own invoice may use every VAT treatment. */
  readonly direction: InvoiceDirection;
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
  /** The company's VAT on the issue date, as Finance reads it from Tax. */
  readonly vat: VatChoicesState;
}

const DISCOUNT_KINDS: readonly (readonly [DraftDiscountKind, string])[] = [
  ['NONE', 'Bez slevy'],
  ['PERCENT', 'Procentem'],
  ['AMOUNT', 'Částkou'],
];

const noPriceList: readonly PriceListItem[] = [];

const priceFormatOptions: Intl.NumberFormatOptions = { maximumFractionDigits: 2, minimumFractionDigits: 0 };
// Without a format the input parses with parseFloat, which stops at the decimal comma: `2,25` became 2.
// Three digits keep a typed fraction visible so `lineIssue` can reject it with a message.
const quantityFormatOptions: Intl.NumberFormatOptions = { maximumFractionDigits: 3, minimumFractionDigits: 0 };

const InvoiceLineDiscount = ({ line, onChange }: Pick<InvoiceLineEditorProps, 'line' | 'onChange'>) => {
  const { t } = useModernI18n();
  return (
    <>
      <div className="finance-invoice-line-discount grid grid-cols-1 items-end gap-150 sm:grid-cols-[10rem_8rem_minmax(0,1fr)]">
        <SelectTemplate
          items={DISCOUNT_KINDS.map(([value, label]) => ({ displayValue: label, label, value }))}
          label={t('finance-billing.financeUi.line.discount')}
          labelProps={formLabelProps}
          name={`invoice-line-discount-kind-${line.key}`}
          onValueChange={({ value }) => {
            const kind = DISCOUNT_KINDS.find(([entry]) => entry === value[0])?.[0] ?? 'NONE';
            const next = { ...line, discountKind: kind };
            onChange(
              kind === 'NONE' ? { ...next, discountInput: '', discountReason: '', discountValue: Number.NaN } : next,
            );
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
              label={t('finance-billing.financeUi.line.discountReason')}
              onChange={(event) => onChange({ ...line, discountReason: event.target.value })}
              placeholder={t('finance-billing.financeUi.line.discountExample')}
              value={line.discountReason ?? ''}
            />
          </>
        )}
      </div>
      {draftLineDiscount(line) !== undefined && (
        <p className="text-fg-secondary text-xs">
          Sleva {formatMoney(lineDiscountMinor({ ...line, discount: draftLineDiscount(line) }))} se na dokladu zobrazí
          samostatně i s důvodem.
        </p>
      )}
    </>
  );
};

/** Fills a free line from a price-list item; the line takes Tax's rate for the item's classification. */
const PriceListPick = ({
  line,
  onChange,
  priceList,
}: Pick<InvoiceLineEditorProps, 'line' | 'onChange'> & { readonly priceList: readonly PriceListItem[] }) => {
  const { t } = useModernI18n();
  return (
    <div className="min-w-0">
      <SelectTemplate
        items={[
          { displayValue: 'Ruční zadání', label: 'Ruční zadání', value: 'MANUAL' },
          ...priceList.map((item) => {
            const unit = item.unit === undefined ? '' : ` / ${item.unit}`;
            const label = `${item.name} · ${formatMoney(item.unitPriceMinor)}${unit}`;
            return { displayValue: label, label, value: item.id };
          }),
        ]}
        label={t('finance-billing.financeUi.line.fromPriceList')}
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
                  // The item names its classification; the line takes Tax's rate at the issue date.
                  vat: lineVatChoice(item),
                },
          );
        }}
        value={[line.priceListItemId ?? 'MANUAL']}
      />
    </div>
  );
};

/** What the line says under its fields: the picked product's snapshot, the line's problem, or a 0 Kč warning. */
const LineNotes = ({
  errorText,
  line,
  productPicked,
  rate,
  zeroPriceLine,
}: {
  readonly errorText: string | undefined;
  readonly line: DraftLine;
  readonly productPicked: boolean;
  readonly rate: number | undefined;
  readonly zeroPriceLine: boolean;
}) => {
  const { t } = useModernI18n();
  return (
    <>
      {line.kind === 'product' && productPicked && (
        <p className="text-fg-secondary text-xs">
          {t(`${ns}.form.productMeta`, { price: formatMoney(line.unitPriceMinor), vat: rate ?? '—' })}
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
    </>
  );
};

/** One invoice line: a product (snapshot on pick) or free text, then quantity, and price and VAT for free text. */
export const InvoiceLineEditor = ({
  canRemove,
  direction,
  issue,
  line,
  onChange,
  onRemove,
  position,
  priceList = noPriceList,
  products,
  productsReadable,
  vat,
}: InvoiceLineEditorProps) => {
  const { t } = useModernI18n();
  const [productQuery, setProductQuery] = useState('');
  const productComboboxId = `invoice-line-product-${line.key}`;
  const productItems = products.flatMap((item) => {
    const label = `${item.name} (${item.sku})`;
    return matchesSearch(label, productQuery) ? [{ id: item.id, label, value: item.id }] : [];
  });
  const product = products.find((item) => item.id === line.productId);
  // A VAT problem is explained under the VAT select itself.
  const errorText = issue === undefined || issue === 'vat' ? undefined : t(`${ns}.form.error.${issue}`);
  const choices = vat.state === 'ready' ? vat.choices : undefined;
  const lineRate = lineVatOf(line.vat, choices)?.vatRate;
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
  let priceInputProps: Pick<ComponentProps<typeof FormNumericInput>, 'value'> = {};
  if (Number.isFinite(line.unitPriceMinor)) {
    priceInputProps = { value: line.unitPriceMinor / 100 };
  }

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
                onChange(newDraftLine(line.key, kind, line.vat));
              }
            }}
            placeholder={t('finance-billing.selectPlaceholder')}
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
              {...priceInputProps}
            >
              <NumericInput.Control>
                <NumericInput.Input />
              </NumericInput.Control>
            </FormNumericInput>
          </div>
        )}
        <div className="min-w-0">
          <VatChoiceSelect
            choice={line.vat}
            direction={direction}
            invalid={issue === 'vat' || (choices !== undefined && lineVatProblem(line, choices, direction))}
            name={`invoice-line-vat-${line.key}`}
            onChange={(next) => onChange({ ...line, vat: next })}
            vat={vat}
          />
        </div>
      </div>
      {line.kind === 'free' && priceList.length > 0 && (
        <PriceListPick line={line} onChange={onChange} priceList={priceList} />
      )}
      <InvoiceLineDiscount line={line} onChange={onChange} />
      <LineNotes
        errorText={errorText}
        line={line}
        productPicked={product !== undefined}
        rate={lineRate}
        zeroPriceLine={zeroPriceLine}
      />
    </fieldset>
  );
};
