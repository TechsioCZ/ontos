import { formatMoney, matchesSearch, comboboxTranslations, surfaceTileClassName } from '@app/admin-ui';
import { ComboboxField, NumberField, SelectField, TextField } from '@app/core-runtime/ui/form';
import type { FormReact } from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Schema } from 'effect';
import { createElement, useState } from 'react';
import type { ComponentProps } from 'react';
import {
  DraftDiscountKindSchema,
  DraftLineKindSchema,
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
import { fieldPart } from './field-lens.ts';
import { LineVatChoiceSchema, VatChoiceField } from './vat-choice-select.tsx';

const ns = 'finance-billing.faktury';

/** One invoice line as the form holds it; numbers a person could not type as a number are `NaN`. */
export const DraftLineSchema = Schema.Struct({
  description: Schema.String,
  discountInput: Schema.optionalKey(Schema.String),
  discountKind: Schema.optionalKey(DraftDiscountKindSchema),
  discountReason: Schema.optionalKey(Schema.String),
  discountValue: Schema.optionalKey(Schema.Number),
  key: Schema.String,
  kind: DraftLineKindSchema,
  priceListItemId: Schema.optionalKey(
    Schema.OptionFromNullOr(Schema.String.pipe(Schema.brand('FinanceDraftPriceListItemId'))),
  ),
  productId: Schema.OptionFromNullOr(Schema.String.pipe(Schema.brand('FinanceDraftProductId'))),
  quantity: Schema.Number,
  unitPriceMinor: Schema.Number,
  vat: LineVatChoiceSchema,
});

interface LinesProps {
  /** Whose invoice it is: a supplier's own invoice may use every VAT treatment. */
  readonly direction: InvoiceDirection;
  /** What a line says is wrong with it, as the form decides when to say it. */
  readonly issueOf: (line: DraftLine) => DraftLineIssue | undefined;
  /** After a line was removed, such as moving focus to a control that stays. */
  readonly onRemoved?: () => void;
  /** Active finance price-list items offered for free lines. */
  readonly priceList?: readonly PriceListItem[];
  /** Active products only; the caller filters them. */
  readonly products: readonly ProductRecord[];
  readonly productsReadable: boolean;
  /** The line as the form shows and edits it, such as with the seller's VAT regime applied. */
  readonly shownLine?: (line: DraftLine) => DraftLine;
  /** The company's VAT on the issue date, as Finance reads it from Tax. */
  readonly vat: VatChoicesState;
}

interface InvoiceLineEditorProps extends Omit<LinesProps, 'issueOf' | 'onRemoved' | 'shownLine'> {
  readonly canRemove: boolean;
  /** The lines field, which every part of the line edits. */
  readonly field: FormReact.FieldState<readonly DraftLine[]>;
  readonly issue: DraftLineIssue | undefined;
  readonly line: DraftLine;
  readonly onChange: (next: DraftLine) => void;
  readonly onRemove: () => void;
  /** 1-based line number; names the line group and its remove button, so each line is told apart. */
  readonly position: number;
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

const InvoiceLineDiscount = ({
  field,
  line,
  onChange,
}: Pick<InvoiceLineEditorProps, 'field' | 'line' | 'onChange'>) => {
  const { t } = useModernI18n();
  return (
    <>
      <div className="finance-invoice-line-discount grid grid-cols-1 items-end gap-150 sm:grid-cols-[10rem_8rem_minmax(0,1fr)]">
        {createElement(SelectField, {
          field: fieldPart<readonly DraftLine[], string>(
            field,
            `${line.key}.discountKind`,
            line.discountKind ?? 'NONE',
            (value) => {
              const kind = DISCOUNT_KINDS.find(([entry]) => entry === value)?.[0] ?? 'NONE';
              const next = { ...line, discountKind: kind };
              onChange(
                kind === 'NONE' ? { ...next, discountInput: '', discountReason: '', discountValue: Number.NaN } : next,
              );
            },
          ),
          props: {
            items: DISCOUNT_KINDS.map(([value, label]) => ({ displayValue: label, label, value })),
            label: t('finance-billing.financeUi.line.discount'),
            labelProps: formLabelProps,
            name: `invoice-line-discount-kind-${line.key}`,
          },
        })}
        {(line.discountKind ?? 'NONE') !== 'NONE' && (
          <>
            {createElement(TextField, {
              field: fieldPart(field, `${line.key}.discountInput`, line.discountInput ?? '', (raw) => {
                const parsed = Number(raw.replaceAll(/\s/gu, '').replace(',', '.'));
                onChange({ ...line, discountInput: raw, discountValue: raw.trim() === '' ? Number.NaN : parsed });
              }),
              props: {
                id: `invoice-line-discount-value-${line.key}`,
                inputMode: 'decimal',
                label: line.discountKind === 'PERCENT' ? 'Sleva (%)' : 'Sleva (Kč)',
              },
            })}
            {createElement(TextField, {
              field: fieldPart(field, `${line.key}.discountReason`, line.discountReason ?? '', (discountReason) =>
                onChange({ ...line, discountReason }),
              ),
              props: {
                id: `invoice-line-discount-reason-${line.key}`,
                label: t('finance-billing.financeUi.line.discountReason'),
                placeholder: t('finance-billing.financeUi.line.discountExample'),
              },
            })}
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
  field,
  line,
  onChange,
  priceList,
}: Pick<InvoiceLineEditorProps, 'field' | 'line' | 'onChange'> & { readonly priceList: readonly PriceListItem[] }) => {
  const { t } = useModernI18n();
  return (
    <div className="min-w-0">
      {createElement(SelectField, {
        field: fieldPart(field, `${line.key}.priceListItemId`, line.priceListItemId ?? 'MANUAL', (value) => {
          const item = priceList.find((entry) => entry.id === value);
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
        }),
        props: {
          items: [
            { displayValue: 'Ruční zadání', label: 'Ruční zadání', value: 'MANUAL' },
            ...priceList.map((item) => {
              const unit = item.unit === undefined ? '' : ` / ${item.unit}`;
              const label = `${item.name} · ${formatMoney(item.unitPriceMinor)}${unit}`;
              return { displayValue: label, label, value: item.id };
            }),
          ],
          label: t('finance-billing.financeUi.line.fromPriceList'),
          labelProps: formLabelProps,
          name: `invoice-line-price-list-${line.key}`,
        },
      })}
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
const InvoiceLineEditor = ({
  canRemove,
  direction,
  field,
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
  // The text typed into the product search narrows the offered products; it is not part of the line.
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
  const descriptionProps: ComponentProps<typeof TextField>['props'] = {
    autoComplete: 'off',
    id: `invoice-line-description-${line.key}`,
    label: t(`${ns}.form.description`),
    name: 'description',
  };
  if (!productsReadable) {
    descriptionProps.placeholder = t(`${ns}.form.rentalDescriptionPlaceholder`);
  }
  // `displayValue` names the hidden native option too; without it the option reads as the raw value.
  const kindItems = [
    ...(productsReadable
      ? [{ displayValue: t(`${ns}.form.kindProduct`), label: t(`${ns}.form.kindProduct`), value: 'product' }]
      : []),
    { displayValue: t(`${ns}.form.kindFree`), label: t(`${ns}.form.kindFree`), value: 'free' },
  ];

  return (
    // A named fieldset per line, so the line's inputs and its remove button read as "Položka 2" and not as a
    // copy of the first line.
    <fieldset
      aria-label={t(`${ns}.form.lineGroup`, { position })}
      className={`${surfaceTileClassName} m-0 flex min-w-0 flex-col gap-100 p-150`}
    >
      <div className="finance-invoice-line-identity grid items-end gap-150">
        <div className="min-w-0">
          {createElement(SelectField, {
            field: fieldPart<readonly DraftLine[], string>(field, `${line.key}.kind`, line.kind, (value) => {
              const kind = value === 'free' ? 'free' : 'product';
              if (kind !== line.kind) {
                onChange(newDraftLine(line.key, kind, line.vat));
              }
            }),
            props: {
              items: kindItems,
              label: t(`${ns}.form.lineKind`),
              labelProps: formLabelProps,
              name: `invoice-line-kind-${line.key}`,
              placeholder: t('finance-billing.selectPlaceholder'),
            },
          })}
        </div>
        <div className="min-w-0">
          {line.kind === 'product'
            ? createElement(ComboboxField, {
                field: fieldPart(field, `${line.key}.productId`, line.productId ?? '', (productId) => {
                  const next = products.find((item) => item.id === productId);
                  if (next !== undefined) {
                    onChange(withProductSnapshot(line, next));
                  }
                }),
                props: {
                  filterBehavior: 'external',
                  id: productComboboxId,
                  items: productItems,
                  keepOnClear: true,
                  label: t(`${ns}.form.product`),
                  noResultsMessage: t(`${ns}.form.noProducts`),
                  onInputValueChange: setProductQuery,
                  onOpenChange: () => setProductQuery(''),
                  openOnClick: true,
                  placeholder: t(`${ns}.form.product`),
                  translations: comboboxTranslations,
                },
              })
            : createElement(TextField, {
                field: fieldPart(field, `${line.key}.description`, line.description, (description) =>
                  onChange({ ...line, description }),
                ),
                props: descriptionProps,
              })}
        </div>
        <Button
          appearance="ghost"
          aria-label={t(`${ns}.form.removeLine`, { position })}
          disabled={!canRemove}
          icon="icon-[mdi--delete-outline]"
          onClick={onRemove}
          severity="secondary"
          size="sm"
        />
      </div>
      <div className="finance-invoice-line-values grid items-end gap-150">
        <div className="min-w-0">
          {createElement(NumberField, {
            field: fieldPart(field, `${line.key}.quantity`, line.quantity, (quantity) =>
              onChange({ ...line, quantity }),
            ),
            props: {
              // Blur must not clamp a typed 0,001 to 1; `lineIssue` rejects it with a message instead.
              clampValueOnBlur: false,
              formatOptions: quantityFormatOptions,
              id: `invoice-line-quantity-${line.key}`,
              label: t(`${ns}.form.quantity`),
              locale: 'cs-CZ',
              min: 1,
              name: 'quantity',
              step: 1,
            },
          })}
        </div>
        {line.kind === 'free' && (
          <div className="min-w-0">
            {createElement(NumberField, {
              // Text that is not a price stores NaN, so `lineIssue` reports `price` instead of a silent 0; a NaN price
              // leaves the input uncontrolled, so the typed text stays visible next to the error.
              field: fieldPart(
                field,
                `${line.key}.unitPrice`,
                Number.isFinite(line.unitPriceMinor) ? line.unitPriceMinor / 100 : Number.NaN,
                (value) =>
                  onChange({ ...line, unitPriceMinor: Number.isFinite(value) ? czkToMinor(value) : Number.NaN }),
              ),
              props: {
                // Two decimals at most, so `1234,5` stays 1 234,50 Kč instead of being rounded to whole crowns.
                // Blur must not clamp a typed -100 to 0; `lineIssue` rejects it with a message instead.
                clampValueOnBlur: false,
                formatOptions: priceFormatOptions,
                id: `invoice-line-price-${line.key}`,
                label: t(`${ns}.form.unitPrice`),
                locale: 'cs-CZ',
                min: 0,
                name: 'unitPrice',
                step: 0.01,
              },
            })}
          </div>
        )}
        <div className="min-w-0">
          {createElement(VatChoiceField, {
            field: fieldPart(field, `${line.key}.vat`, line.vat, (next) => onChange({ ...line, vat: next })),
            props: {
              direction,
              invalid: issue === 'vat' || (choices !== undefined && lineVatProblem(line, choices, direction)),
              name: `invoice-line-vat-${line.key}`,
              vat,
            },
          })}
        </div>
      </div>
      {line.kind === 'free' && priceList.length > 0 && (
        <PriceListPick field={field} line={line} onChange={onChange} priceList={priceList} />
      )}
      <InvoiceLineDiscount field={field} line={line} onChange={onChange} />
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

/**
 * The lines of an invoice as one field: each line edits its own entry, a line can be removed while more than one is
 * left, and every part of a line is a kit control bound to the lines field.
 */
export const InvoiceLinesField: FormReact.FieldComponent<readonly DraftLine[], LinesProps> = ({ field, props }) => {
  const { issueOf, onRemoved, shownLine, ...editor } = props;
  const lines = shownLine === undefined ? field.value : field.value.map(shownLine);
  return lines.map((line, index) => (
    <InvoiceLineEditor
      {...editor}
      canRemove={lines.length > 1}
      field={field}
      issue={issueOf(line)}
      key={line.key}
      line={line}
      onChange={(next) => field.onChange(field.value.map((item) => (item.key === line.key ? next : item)))}
      onRemove={() => {
        field.onChange(field.value.filter((item) => item.key !== line.key));
        onRemoved?.();
      }}
      position={index + 1}
    />
  ));
};
