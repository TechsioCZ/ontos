import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { NumericInput } from '@techsio/ui-kit/atoms/numeric-input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormNumericInput } from '@techsio/ui-kit/molecules/form-numeric-input';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { SidePanel, comboboxTranslations } from '@app/admin-ui';
import { useState } from 'react';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import type { ProductUnit, VatRate } from '../../../../../shared/domain/merchandise-model.ts';
import { WHOLE_NUMBER_FORMAT } from '../../../../form-number.ts';
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
  return (path: string) => t(`${KEY_PREFIX}.${path}`);
};

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

const ErrorLine = ({ message }: { readonly message: string | null }) =>
  message === null ? null : (
    <StatusText showIcon status="error">
      {message}
    </StatusText>
  );

/** Create product: SKU, name, unit, category, VAT, price, minimum stock. Sends CreateProduct. */
export const CreateProductDialog = ({ onCommitted, onOpenChange, onReload, open, revision }: FormDialogProps) => {
  const k = useProductLabel();
  const failure = useCommandFailure();
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [unit, setUnit] = useState<ProductUnit>('ks');
  const [vatRate, setVatRate] = useState<VatRate>(21);
  // NaN until typed: an empty price is refused by priceErrorKey instead of starting at 0.
  const [priceCzk, setPriceCzk] = useState(Number.NaN);
  const [lowStock, setLowStock] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const skuError = sku.trim() === '' ? k(REQUIRED_KEY) : undefined;
  const nameError = name.trim() === '' ? k(REQUIRED_KEY) : undefined;
  const categoryError = category.trim() === '' ? k(REQUIRED_KEY) : undefined;
  const priceKey = priceErrorKey(priceCzk);
  const priceError = priceKey === undefined ? undefined : k(priceKey);
  const lowStockKey = lowStockErrorKey(lowStock);
  const lowStockError = lowStockKey === undefined ? undefined : k(lowStockKey);
  const hasErrors = [skuError, nameError, categoryError, priceError, lowStockError].some(
    (message) => message !== undefined,
  );

  const submit = () => {
    setSubmitted(true);
    if (hasErrors) {
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
          setServerError(failure(outcome.reason, onReload));
          return;
        }
        setSku('');
        setName('');
        setCategory('');
        setPriceCzk(Number.NaN);
        setLowStock(0);
        setSubmitted(false);
        onOpenChange(false);
        onCommitted(k('messages.created'));
      },
    );
  };

  return (
    <SidePanel
      actions={
        <DialogActions busy={busy} onCancel={() => onOpenChange(false)} onSubmit={submit} submit={k('create.submit')} />
      }
      onOpenChange={onOpenChange}
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
            id="product-price"
            label={k('fields.price')}
            locale="cs-CZ"
            min={0}
            name="price"
            onChange={setPriceCzk}
            precision={2}
            required
            step={1}
            value={Number.isNaN(priceCzk) ? '' : priceCzk}
            {...fieldError(submitted, priceError)}
          >
            <NumericInput.Control>
              <NumericInput.Input />
            </NumericInput.Control>
          </FormNumericInput>
          <FormNumericInput
            formatOptions={WHOLE_NUMBER_FORMAT}
            id="product-low-stock"
            label={k('fields.lowStock')}
            locale="cs-CZ"
            name="lowStock"
            onChange={setLowStock}
            step={1}
            value={lowStock}
            {...fieldError(submitted, lowStockError)}
          >
            <NumericInput.Control>
              <NumericInput.Input />
            </NumericInput.Control>
          </FormNumericInput>
        </div>
      </form>
    </SidePanel>
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
  const [note, setNote] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const productError = productId === null ? k(REQUIRED_KEY) : undefined;
  const quantityError = Number.isInteger(quantity) && quantity >= 1 ? undefined : k('validation.quantity');

  const submit = () => {
    setSubmitted(true);
    if (productId === null || quantityError !== undefined) {
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
      setProductId(null);
      setQuantity(1);
      setNote('');
      setSubmitted(false);
      onOpenChange(false);
      onCommitted(k('messages.receiptRecorded'));
    });
  };

  return (
    <SidePanel
      actions={
        <DialogActions
          busy={busy}
          onCancel={() => onOpenChange(false)}
          onSubmit={submit}
          submit={k('receipt.submit')}
        />
      }
      description={k('receipt.description')}
      onOpenChange={onOpenChange}
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
          formatOptions={WHOLE_NUMBER_FORMAT}
          id="receipt-quantity"
          label={k('fields.quantity')}
          locale="cs-CZ"
          name="quantity"
          onChange={setQuantity}
          step={1}
          value={quantity}
          {...fieldError(submitted, quantityError)}
        >
          <NumericInput.Control>
            <NumericInput.Input />
          </NumericInput.Control>
        </FormNumericInput>
        <FormInput
          autoComplete="off"
          id="receipt-note"
          label={k('fields.note')}
          name="note"
          onChange={(event) => setNote(event.target.value)}
          value={note}
        />
      </form>
    </SidePanel>
  );
};

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
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const valid = Number.isInteger(percent) && percent >= -90 && percent <= 1000 && percent !== 0;
  const submit = () => {
    setSubmitted(true);
    if (!valid || ids.length === 0) {
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
        <FormNumericInput
          formatOptions={WHOLE_NUMBER_FORMAT}
          id="price-percent"
          label={k('priceDialog.field')}
          locale="cs-CZ"
          name="priceChangePercent"
          onChange={setPercent}
          step={1}
          value={percent}
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

  const empty = category.trim() === '';
  const submit = () => {
    setSubmitted(true);
    if (empty || ids.length === 0) {
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
          {...fieldError(submitted && empty, k(REQUIRED_KEY))}
        />
      </form>
    </SidePanel>
  );
};
