import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { NumericInput } from '@techsio/ui-kit/atoms/numeric-input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormNumericInput } from '@techsio/ui-kit/molecules/form-numeric-input';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { SidePanel, comboboxTranslations, dialogCloseLabel } from '@app/admin-ui';
import { useState } from 'react';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import type { ProductUnit, VatRate } from '../../../../../shared/domain/merchandise-model.ts';
import { sameSku } from '../../../../../shared/domain/merchandise-model.ts';
import { MONEY_FORMAT, NO_ARIA_MAX, WHOLE_NUMBER_FORMAT } from '../../../../form-number.ts';
import { runCommand } from './products-api.ts';
import type { FailureReason } from './products-api.ts';

export interface FormDialogProps {
  /** Called after a successful command. The page shows the toast and reloads. */
  readonly onCommitted: (message: string) => void;
  readonly onOpenChange: (open: boolean) => void;
  /** Called on a revision conflict so the page reloads the current state. */
  readonly onReload: () => void;
  readonly open: boolean;
  readonly revision: number;
}

export const UNITS: readonly ProductUnit[] = ['ks', 'bal', 'hod', 'lic'];
export const VAT_RATES: readonly VatRate[] = [0, 10, 12, 21];

const REQUIRED_KEY = 'validation.required';
const KEY_PREFIX = 'merchandise.pages.products';

/** Translates a key under the products namespace. */
export const useProductLabel = () => {
  const { t } = useModernI18n();
  return (path: string, values?: Record<string, number | string>) => t(`${KEY_PREFIX}.${path}`, values);
};
export type ProductLabel = ReturnType<typeof useProductLabel>;

/**
 * Text limits of the apply-command schema. The forms check them before sending: an over-long value would
 * otherwise fail to encode, send nothing, and surface only as the generic failure toast.
 */
export const PRODUCT_LIMITS = { category: 120, name: 200, note: 2000, sku: 64 } as const;

/** Length message for a trimmed text field over its limit, or undefined. Counts UTF-16 units, as the schema does. */
export const tooLongMessage = (k: ProductLabel, value: string, maximum: number): string | undefined =>
  value.trim().length > maximum ? k('validation.tooLong', { max: maximum }) : undefined;

/** Failure text for a refused command. Conflicts also ask the page to reload. */
export const useCommandFailure = () => {
  const label = useProductLabel();
  return (reason: FailureReason, onReload: () => void): string => {
    if (reason === 'conflict') {
      onReload();
      return label('messages.conflict');
    }
    if (reason === 'rejected') {
      return label('messages.rejected');
    }
    return label('messages.failed');
  };
};

/** Combobox reports a single value as a string or a one-item array; both shapes collapse to the picked id. */
const pickFirst = (values: string | string[]): string | undefined => (Array.isArray(values) ? values[0] : values);

/** Price in Kč, haléře allowed (the input keeps two decimals): a finite number above zero. An emptied input reports NaN. */
export const priceErrorKey = (priceCzk: number): string | undefined =>
  Number.isFinite(priceCzk) && priceCzk > 0 ? undefined : 'validation.positive';

/** Low-stock threshold: a whole number of zero or more. */
export const lowStockErrorKey = (lowStock: number): string | undefined =>
  Number.isInteger(lowStock) && lowStock >= 0 ? undefined : 'validation.lowStock';

export const fieldError = (submitted: boolean, message: string | undefined) =>
  submitted && message !== undefined ? { helpText: message, validateStatus: 'error' as const } : {};

/**
 * After a refused submit, moves focus to the first invalid field so keyboard and screen-reader users land on
 * the problem. Each entry is the field's DOM id and whether it is invalid, in form order.
 */
export const focusFirstInvalid = (fields: readonly (readonly [string, boolean])[]): void => {
  const first = fields.find(([, invalid]) => invalid);
  if (first !== undefined) {
    globalThis.document.querySelector<HTMLElement>(`[id="${first[0]}"]`)?.focus();
  }
};

const DialogActions = ({
  busy,
  onCancel,
  onSubmit,
  submit,
}: {
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: () => void;
  readonly submit: string;
}) => {
  const label = useProductLabel();
  return (
    <>
      <Button onClick={onCancel} theme="outlined" variant="secondary">
        {label('common.cancel')}
      </Button>
      <Button isLoading={busy} loadingText={submit} onClick={onSubmit} variant="primary">
        {submit}
      </Button>
    </>
  );
};

/**
 * Close handling for a form with a typed draft. Esc, outside clicks and Zrušit come here: a draft asks before it is
 * discarded, an empty form closes at once.
 */
const useDraftClose = (dirty: boolean, onOpenChange: (open: boolean) => void) => {
  const [discardOpen, setDiscardOpen] = useState(false);
  const requestClose = (next: boolean) => {
    if (next) {
      return;
    }
    if (dirty) {
      setDiscardOpen(true);
      return;
    }
    onOpenChange(false);
  };
  return { discardOpen, requestClose, setDiscardOpen };
};

/** Asks before a form with an unsent draft closes. Esc, outside clicks and Zrušit all reach it first. */
const DiscardConfirm = ({
  onConfirm,
  onKeep,
  open,
  title,
}: {
  readonly onConfirm: () => void;
  readonly onKeep: () => void;
  readonly open: boolean;
  readonly title: string;
}) => {
  const k = useProductLabel();
  return (
    <Dialog
      actions={
        <>
          <Button onClick={onKeep} theme="outlined" variant="secondary">
            {k('detail.discardKeep')}
          </Button>
          <Button onClick={onConfirm} variant="danger">
            {k('detail.discardAction')}
          </Button>
        </>
      }
      closeLabel={dialogCloseLabel}
      customTrigger
      description={k('detail.discardDescription')}
      onOpenChange={({ open: next }) => {
        if (!next) {
          onKeep();
        }
      }}
      open={open}
      role="alertdialog"
      size="sm"
      title={title}
    />
  );
};

const ErrorLine = ({ message }: { readonly message: string | null }) =>
  message === null ? null : (
    <StatusText showIcon status="error">
      {message}
    </StatusText>
  );

/**
 * Create product: SKU, name, unit, category, VAT, price, minimum stock. Sends CreateProduct. A SKU already in
 * the loaded list is refused before sending; the server still refuses one created meanwhile by someone else.
 */
export const CreateProductDialog = ({
  onCommitted,
  onOpenChange,
  onReload,
  open,
  products,
  revision,
}: FormDialogProps & { readonly products: readonly ProductRecord[] }) => {
  const k = useProductLabel();
  const failure = useCommandFailure();
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [unit, setUnit] = useState<ProductUnit>('ks');
  const [vatRate, setVatRate] = useState<VatRate>(21);
  // NaN until typed: an empty price is refused by priceErrorKey instead of starting at 0. The text is what the
  // input shows; a string value keeps the two-decimal format from rewriting it on every keystroke.
  const [priceCzk, setPriceCzk] = useState(Number.NaN);
  const [priceText, setPriceText] = useState('');
  const [lowStock, setLowStock] = useState(0);
  const [lowStockText, setLowStockText] = useState('0');
  // The SKU the server refused as a duplicate. Only that exact value shows the message, so editing it clears it.
  const [takenSku, setTakenSku] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const dirty = sku !== '' || name !== '' || category !== '' || priceText !== '' || lowStock !== 0;
  const { discardOpen, requestClose, setDiscardOpen } = useDraftClose(dirty, onOpenChange);

  const skuTaken =
    (takenSku !== null && sameSku(takenSku, sku)) || products.some((product) => sameSku(product.sku, sku));
  const skuTakenError = skuTaken ? k('validation.skuTaken') : undefined;
  const skuError = sku.trim() === '' ? k(REQUIRED_KEY) : (skuTakenError ?? tooLongMessage(k, sku, PRODUCT_LIMITS.sku));
  const nameError = name.trim() === '' ? k(REQUIRED_KEY) : tooLongMessage(k, name, PRODUCT_LIMITS.name);
  const categoryError = category.trim() === '' ? k(REQUIRED_KEY) : tooLongMessage(k, category, PRODUCT_LIMITS.category);
  const priceKey = priceErrorKey(priceCzk);
  const priceError = priceKey === undefined ? undefined : k(priceKey);
  const lowStockKey = lowStockErrorKey(lowStock);
  const lowStockError = lowStockKey === undefined ? undefined : k(lowStockKey);
  const hasErrors = [skuError, nameError, categoryError, priceError, lowStockError].some(
    (message) => message !== undefined,
  );

  const clearForm = () => {
    setSku('');
    setTakenSku(null);
    setName('');
    setCategory('');
    setPriceCzk(Number.NaN);
    setPriceText('');
    setLowStock(0);
    setLowStockText('0');
    setSubmitted(false);
  };
  const submit = () => {
    if (busy) {
      return;
    }
    setSubmitted(true);
    if (hasErrors) {
      focusFirstInvalid([
        ['product-sku', skuError !== undefined],
        ['product-name', nameError !== undefined],
        ['product-category', categoryError !== undefined],
        ['product-price', priceError !== undefined],
        ['product-low-stock', lowStockError !== undefined],
      ]);
      return;
    }
    setBusy(true);
    setServerError(null);
    runCommand(
      {
        _tag: 'CreateProduct',
        active: true,
        category: category.trim(),
        lowStockThreshold: lowStock,
        name: name.trim(),
        priceMinor: Math.round(priceCzk * 100),
        sku: sku.trim(),
        unit,
        vatRate,
      },
      revision,
      (outcome) => {
        setBusy(false);
        if (!outcome.ok) {
          // CreateProduct's only business refusal is a duplicate SKU, so the stock wording in `rejected` does not apply.
          if (outcome.reason === 'rejected') {
            setTakenSku(sku.trim());
            return;
          }
          setServerError(failure(outcome.reason, onReload));
          return;
        }
        clearForm();
        onOpenChange(false);
        onCommitted(k('messages.created'));
      },
    );
  };

  return (
    <>
      <SidePanel
        actions={
          <DialogActions
            busy={busy}
            onCancel={() => requestClose(false)}
            onSubmit={submit}
            submit={k('create.submit')}
          />
        }
        closeOnInteractOutside={!dirty}
        onOpenChange={requestClose}
        open={open}
        size="md"
        title={k('create.title')}
      >
        <form
          className="flex flex-col gap-200 py-200"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <ErrorLine message={serverError} />
          <FormInput
            autoComplete="off"
            id="product-sku"
            label={k('fields.sku')}
            name="sku"
            onChange={(event) => setSku(event.target.value)}
            required
            value={sku}
            {...fieldError(submitted, skuError)}
          />
          <FormInput
            autoComplete="off"
            id="product-name"
            label={k('fields.name')}
            name="name"
            onChange={(event) => setName(event.target.value)}
            required
            value={name}
            {...fieldError(submitted, nameError)}
          />
          <FormInput
            autoComplete="off"
            id="product-category"
            label={k('fields.category')}
            name="category"
            onChange={(event) => setCategory(event.target.value)}
            required
            value={category}
            {...fieldError(submitted, categoryError)}
          />
          <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
            <SelectTemplate
              items={UNITS.map((value) => ({ label: value, value }))}
              label={k('fields.unit')}
              name="unit"
              onValueChange={(details) => {
                const [next] = details.value;
                const picked = UNITS.find((value) => value === next);
                if (picked !== undefined) {
                  setUnit(picked);
                }
              }}
              placeholder={k('selectPlaceholder')}
              value={[unit]}
            />
            <SelectTemplate
              items={VAT_RATES.map((rate) => ({ label: `${rate} %`, value: String(rate) }))}
              label={k('fields.vat')}
              name="vat"
              onValueChange={(details) => {
                const [next] = details.value;
                const picked = VAT_RATES.find((rate) => String(rate) === next);
                if (picked !== undefined) {
                  setVatRate(picked);
                }
              }}
              placeholder={k('selectPlaceholder')}
              value={[String(vatRate)]}
            />
          </div>
          <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
            <FormNumericInput
              formatOptions={MONEY_FORMAT}
              id="product-price"
              label={k('fields.price')}
              locale="cs-CZ"
              min={0}
              name="price"
              onValueChange={(details) => {
                setPriceCzk(details.valueAsNumber);
                setPriceText(details.value);
              }}
              required
              step={1}
              value={priceText}
              {...fieldError(submitted, priceError)}
            >
              <NumericInput.Control>
                <NumericInput.Input {...NO_ARIA_MAX} />
              </NumericInput.Control>
            </FormNumericInput>
            <FormNumericInput
              clampValueOnBlur={false}
              formatOptions={WHOLE_NUMBER_FORMAT}
              id="product-low-stock"
              label={k('fields.lowStock')}
              locale="cs-CZ"
              min={0}
              name="lowStock"
              onValueChange={(details) => {
                setLowStock(details.valueAsNumber);
                setLowStockText(details.value);
              }}
              step={1}
              value={lowStockText}
              {...fieldError(submitted, lowStockError)}
            >
              <NumericInput.Control>
                <NumericInput.Input {...NO_ARIA_MAX} />
              </NumericInput.Control>
            </FormNumericInput>
          </div>
        </form>
      </SidePanel>
      <DiscardConfirm
        onConfirm={() => {
          setDiscardOpen(false);
          clearForm();
          onOpenChange(false);
        }}
        onKeep={() => setDiscardOpen(false)}
        open={discardOpen}
        title={k('create.discardTitle')}
      />
    </>
  );
};

/** Goods receipt: pick a product, enter a positive quantity, record RECEIPT with a positive delta. */
export const ReceiptDialog = ({
  onCommitted,
  onOpenChange,
  onReload,
  open,
  products,
  revision,
}: FormDialogProps & { readonly products: readonly ProductRecord[] }) => {
  const k = useProductLabel();
  const failure = useCommandFailure();
  const [productId, setProductId] = useState<ProductRecord['id'] | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [quantityText, setQuantityText] = useState('1');
  const [note, setNote] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const dirty = productId !== null || quantity !== 1 || note !== '';
  const { discardOpen, requestClose, setDiscardOpen } = useDraftClose(dirty, onOpenChange);

  const productError = productId === null ? k(REQUIRED_KEY) : undefined;
  const quantityError = Number.isInteger(quantity) && quantity >= 1 ? undefined : k('validation.quantity');
  const noteError = tooLongMessage(k, note, PRODUCT_LIMITS.note);

  const clearForm = () => {
    setProductId(null);
    setQuantity(1);
    setQuantityText('1');
    setNote('');
    setSubmitted(false);
  };
  const submit = () => {
    if (busy) {
      return;
    }
    setSubmitted(true);
    if (productId === null || quantityError !== undefined || noteError !== undefined) {
      // The combobox puts its id on the input as `${id}-input`.
      focusFirstInvalid([
        ['receipt-product-input', productId === null],
        ['receipt-quantity', quantityError !== undefined],
        ['receipt-note', noteError !== undefined],
      ]);
      return;
    }
    setBusy(true);
    setServerError(null);
    const trimmed = note.trim();
    const receipt = {
      _tag: 'RecordStockMovement' as const,
      delta: Math.round(quantity),
      productId,
      reason: 'RECEIPT' as const,
    };
    runCommand(trimmed === '' ? receipt : { ...receipt, note: trimmed }, revision, (outcome) => {
      setBusy(false);
      if (!outcome.ok) {
        setServerError(failure(outcome.reason, onReload));
        return;
      }
      clearForm();
      onOpenChange(false);
      onCommitted(k('messages.receiptRecorded'));
    });
  };

  return (
    <>
      <SidePanel
        actions={
          <DialogActions
            busy={busy}
            onCancel={() => requestClose(false)}
            onSubmit={submit}
            submit={k('receipt.submit')}
          />
        }
        closeOnInteractOutside={!dirty}
        description={k('receipt.description')}
        onOpenChange={requestClose}
        open={open}
        size="md"
        title={k('receipt.title')}
      >
        <form
          className="flex flex-col gap-200 py-200"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <ErrorLine message={serverError} />
          {/* Not clearable: ui-kit names the clear control "Clear value" in English; picking another product replaces it. */}
          <Combobox
            clearable={false}
            id="receipt-product"
            items={products.map((product) => ({
              id: product.id,
              label: `${product.name} (${product.sku})`,
              value: product.id,
            }))}
            label={k('fields.product')}
            name="product"
            noResultsMessage={k('states.noResults')}
            onChange={(values) => {
              const picked = pickFirst(values);
              setProductId(products.find((product) => product.id === picked)?.id ?? null);
            }}
            placeholder={k('filters.search')}
            translations={comboboxTranslations}
            value={productId === null ? [] : [productId]}
            {...fieldError(submitted, productError)}
          />
          <FormNumericInput
            clampValueOnBlur={false}
            formatOptions={WHOLE_NUMBER_FORMAT}
            id="receipt-quantity"
            label={k('fields.quantity')}
            locale="cs-CZ"
            min={1}
            name="quantity"
            onValueChange={(details) => {
              setQuantity(details.valueAsNumber);
              setQuantityText(details.value);
            }}
            step={1}
            value={quantityText}
            {...fieldError(submitted, quantityError)}
          >
            <NumericInput.Control>
              <NumericInput.Input {...NO_ARIA_MAX} />
            </NumericInput.Control>
          </FormNumericInput>
          <FormInput
            autoComplete="off"
            id="receipt-note"
            label={k('fields.note')}
            name="note"
            onChange={(event) => setNote(event.target.value)}
            value={note}
            {...fieldError(submitted, noteError)}
          />
        </form>
      </SidePanel>
      <DiscardConfirm
        onConfirm={() => {
          setDiscardOpen(false);
          clearForm();
          onOpenChange(false);
        }}
        onKeep={() => setDiscardOpen(false)}
        open={discardOpen}
        title={k('receipt.discardTitle')}
      />
    </>
  );
};

const PERCENT_MIN = -90;
const PERCENT_MAX = 1000;

/** Bulk price change by a whole percent. Sends BulkUpdateProducts with priceChangePercent. */
export const PriceChangeDialog = ({
  ids,
  onCommitted,
  onOpenChange,
  onReload,
  open,
  revision,
}: FormDialogProps & { readonly ids: readonly ProductRecord['id'][] }) => {
  const k = useProductLabel();
  const failure = useCommandFailure();
  const { t } = useModernI18n();
  const [percent, setPercent] = useState(5);
  // The text is what the input shows; "5,5" reaches validation as 5.5 instead of silently becoming 55.
  const [percentText, setPercentText] = useState('5');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const valid = Number.isInteger(percent) && percent >= PERCENT_MIN && percent <= PERCENT_MAX && percent !== 0;
  const submit = () => {
    setSubmitted(true);
    if (!valid || ids.length === 0) {
      focusFirstInvalid([['price-percent', !valid]]);
      return;
    }
    setBusy(true);
    setServerError(null);
    runCommand(
      { _tag: 'BulkUpdateProducts', ids: [...ids], patch: { priceChangePercent: percent } },
      revision,
      (outcome) => {
        setBusy(false);
        if (!outcome.ok) {
          setServerError(failure(outcome.reason, onReload));
          return;
        }
        setPercent(5);
        setPercentText('5');
        setSubmitted(false);
        onOpenChange(false);
        onCommitted(k('messages.priceChanged'));
      },
    );
  };

  return (
    <SidePanel
      actions={
        <DialogActions
          busy={busy}
          onCancel={() => onOpenChange(false)}
          onSubmit={submit}
          submit={k('priceDialog.submit')}
        />
      }
      description={k('priceDialog.description')}
      onOpenChange={onOpenChange}
      open={open}
      size="md"
      title={k('priceDialog.title')}
    >
      <form
        className="flex flex-col gap-200 py-200"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <ErrorLine message={serverError} />
        <p className="text-fg-secondary text-sm tabular-nums">
          {t('merchandise.pages.products.priceDialog.affected', { total: ids.length })}
        </p>
        {/* The real -90..1000 range for ARIA, without clamping on blur, so validation still sees an out-of-range value. */}
        <FormNumericInput
          clampValueOnBlur={false}
          formatOptions={WHOLE_NUMBER_FORMAT}
          id="price-percent"
          label={k('priceDialog.field')}
          locale="cs-CZ"
          max={PERCENT_MAX}
          min={PERCENT_MIN}
          name="priceChangePercent"
          onValueChange={(details) => {
            setPercent(details.valueAsNumber);
            setPercentText(details.value);
          }}
          step={1}
          value={percentText}
          {...fieldError(submitted && !valid, k('validation.percent'))}
        >
          <NumericInput.Control>
            <NumericInput.Input />
          </NumericInput.Control>
        </FormNumericInput>
        <StatusText showIcon status="warning">
          {k('priceDialog.warning')}
        </StatusText>
      </form>
    </SidePanel>
  );
};

/** Bulk category change. Sends BulkUpdateProducts with the new category. */
export const CategoryDialog = ({
  ids,
  onCommitted,
  onOpenChange,
  onReload,
  open,
  revision,
}: FormDialogProps & { readonly ids: readonly ProductRecord['id'][] }) => {
  const k = useProductLabel();
  const failure = useCommandFailure();
  const [category, setCategory] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const categoryError = category.trim() === '' ? k(REQUIRED_KEY) : tooLongMessage(k, category, PRODUCT_LIMITS.category);
  const submit = () => {
    setSubmitted(true);
    if (categoryError !== undefined || ids.length === 0) {
      focusFirstInvalid([['bulk-category', categoryError !== undefined]]);
      return;
    }
    setBusy(true);
    setServerError(null);
    runCommand(
      { _tag: 'BulkUpdateProducts', ids: [...ids], patch: { category: category.trim() } },
      revision,
      (outcome) => {
        setBusy(false);
        if (!outcome.ok) {
          setServerError(failure(outcome.reason, onReload));
          return;
        }
        setCategory('');
        setSubmitted(false);
        onOpenChange(false);
        onCommitted(k('messages.bulkUpdated'));
      },
    );
  };

  return (
    <SidePanel
      actions={
        <DialogActions
          busy={busy}
          onCancel={() => onOpenChange(false)}
          onSubmit={submit}
          submit={k('category.submit')}
        />
      }
      onOpenChange={onOpenChange}
      open={open}
      size="md"
      title={k('category.title')}
    >
      <form
        className="flex flex-col gap-200 py-200"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <ErrorLine message={serverError} />
        <FormInput
          autoComplete="off"
          id="bulk-category"
          label={k('category.field')}
          name="category"
          onChange={(event) => setCategory(event.target.value)}
          required
          value={category}
          {...fieldError(submitted, categoryError)}
        />
      </form>
    </SidePanel>
  );
};
