import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Effect } from 'effect';
import { constVoid } from 'effect/Function';
import { Button } from '@techsio/ui-kit/atoms/button';
import { NumericInput } from '@techsio/ui-kit/atoms/numeric-input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormNumericInput } from '@techsio/ui-kit/molecules/form-numeric-input';
import { SelectTemplate } from '@app/admin-ui/select-template';
import {
  SaveBar,
  SidePanel,
  UnsavedChangesDialog,
  dialogCloseLabel,
  saveLabelsFor,
  useDraftSave,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { DraftSave, SaveLabels, SaveOutcome, SaveState, UnsavedChangesGuard } from '@app/admin-ui';
import { useState } from 'react';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import type { ProductUnit, VatRate } from '../../../../../shared/domain/merchandise-model.ts';
import { sameSku } from '../../../../../shared/domain/merchandise-model.ts';
import { MONEY_FORMAT, WHOLE_NUMBER_FORMAT } from '../../../../form-number.ts';
import { productCommandOutcome, runCommand } from './products-api.ts';
import type { CommandOutcome, ProductCommand } from './products-api.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { selectItem } from '../../../../ui/select-item.ts';
import { ProductSearchCombobox } from './product-search.tsx';
import { useCommandFailure, useProductLabel } from './product-form-labels.ts';
import {
  PRODUCT_LIMITS,
  UNITS,
  VAT_RATES,
  fieldError,
  focusFirstInvalid,
  lowStockErrorKey,
  priceErrorKey,
  tooLongMessage,
} from './product-form-validation.ts';

export interface FormDialogProps {
  /** Called after a successful command. The page shows the toast and reloads. */
  readonly onCommitted: (message: string) => void;
  readonly onOpenChange: (open: boolean) => void;
  /** Called on a revision conflict so the page reloads the current state. */
  readonly onReload: () => void;
  readonly open: boolean;
  readonly revision: number;
}

const RESIZE_LABEL_KEY = 'merchandise.sidePanel.resize';
const REQUIRED_KEY = 'validation.required';

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

/** What the create form holds until Uložit. The texts are what the inputs show; the numbers are their parsed values. */
interface ProductDraft {
  readonly category: string;
  readonly lowStock: number;
  readonly lowStockText: string;
  readonly name: string;
  // NaN until typed: an empty price is refused by priceErrorKey instead of starting at 0.
  readonly priceCzk: number;
  readonly priceText: string;
  readonly sku: string;
  readonly unit: ProductUnit;
  readonly vatRate: VatRate;
}

const blankProduct: ProductDraft = {
  category: '',
  lowStock: 0,
  lowStockText: '0',
  name: '',
  priceCzk: Number.NaN,
  priceText: '',
  sku: '',
  unit: 'ks',
  vatRate: 21,
};

/** The texts carry the numbers, so two drafts with the same texts are the same draft. */
const sameProduct = (left: ProductDraft, right: ProductDraft): boolean =>
  left.category === right.category &&
  left.lowStockText === right.lowStockText &&
  left.name === right.name &&
  left.priceText === right.priceText &&
  left.sku === right.sku &&
  left.unit === right.unit &&
  left.vatRate === right.vatRate;

interface FormSaveOptions<V> {
  /** The product command that sends the draft. */
  readonly command: (value: V) => ProductCommand;
  readonly equals: (left: V, right: V) => boolean;
  /** The version the form opens empty with; the draft is compared with it. */
  readonly initial: V;
  /** The form's own validation; an invalid draft is never sent and keeps Uložit disabled. */
  readonly isValid: (value: V) => boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onReload: () => void;
  /** The command went through: the page shows the toast and reloads. */
  readonly onSaved: () => void;
  /** Whether the panel is open. A closed panel holds nothing typed, so it never asks before leaving. */
  readonly open: boolean;
  /**
   * The values the form opens with when they differ from `initial` (a suggested value Uložit can send at once).
   * They are not typed input, so leaving with them does not ask.
   */
  readonly opened?: V | undefined;
  /** Text of a refused save; the general failure text when it returns null. */
  readonly refused?: (outcome: Extract<CommandOutcome, { readonly ok: false }>, value: V) => string | null;
  /** Puts `value` back into the form's state. */
  readonly reset: (value: V) => void;
  readonly revision: number;
  readonly value: V;
}

/**
 * Explicit save of one create or bulk form: typing changes only the draft, the shared Save button sends it as one
 * product command, and leaving with unsaved input asks Uložit / Zahodit změny / Zůstat.
 */
const useFormSave = <V,>(options: FormSaveOptions<V>) => {
  const failure = useCommandFailure();
  const { language } = useModernI18n();
  const [error, setError] = useState<string | null>(null);
  const record = useDraftSave<V, never>({
    equals: options.equals,
    initial: options.initial,
    isValid: options.isValid,
    runtime: browserRuntime,
    save: (value) =>
      productCommandOutcome(options.command(value), options.revision).pipe(
        Effect.map((outcome): SaveOutcome => {
          if (outcome.ok) {
            setError(null);
            return 'saved';
          }
          setError(options.refused?.(outcome, value) ?? failure(outcome.reason, options.onReload, outcome.proposal));
          return outcome.proposal === undefined ? 'failed' : 'proposed';
        }),
      ),
    value: options.value,
  });
  // Every way out (Zrušit, the panel's dismissal, a sent draft) starts the next open from the empty form.
  const startOver = () => {
    setError(null);
    options.reset(options.initial);
    record.adopt(options.initial);
  };
  const leave = () => {
    startOver();
    options.onOpenChange(false);
  };
  // Only what the user typed in the open panel asks before leaving: the panel stays mounted while closed, and the
  // values it opens with are not lost input.
  const untouched = options.opened !== undefined && options.equals(options.value, options.opened);
  const guardDraft: DraftSave<V> = { ...record, dirty: record.dirty && options.open && !untouched };
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => guardDraft.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: guardDraft, navigation: blocker, onDiscard: startOver });
  const handleSave = () => {
    record.save();
    record.afterSave((status) => {
      if (status === 'saved') {
        leave();
        options.onSaved();
      }
    });
  };
  return { error, guard, handleSave, labels: saveLabelsFor(language), leave, record };
};

/** What the footer of a form needs from its save. */
interface FormSave {
  readonly error: string | null;
  readonly guard: UnsavedChangesGuard;
  readonly handleSave: () => void;
  readonly labels: SaveLabels;
  readonly leave: () => void;
  readonly record: { readonly status: SaveState };
}

/** Zrušit and the shared Save button, last in the panel's footer. */
const FormSaveActions = ({ form }: { readonly form: FormSave }) => {
  const label = useProductLabel();
  return (
    <>
      <Button onClick={() => form.guard.request(form.leave)} theme="outlined" variant="secondary">
        {label('common.cancel')}
      </Button>
      <SaveBar
        error={form.error}
        labels={form.labels}
        onReloadLatest={constVoid}
        onSave={form.handleSave}
        status={form.record.status}
      />
    </>
  );
};

/**
 * Create product: SKU, name, unit, category, VAT, price, minimum stock. Sends CreateProduct. The server refuses a
 * SKU the catalog already has; the field then shows that message until the SKU changes.
 */
export const CreateProductDialog = ({ onCommitted, onOpenChange, onReload, open, revision }: FormDialogProps) => {
  const k = useProductLabel();
  const { t } = useModernI18n();
  const [draft, setDraft] = useState<ProductDraft>(blankProduct);
  const update = (patch: Partial<ProductDraft>) => setDraft((current) => ({ ...current, ...patch }));
  // The SKU the server refused as a duplicate. Only that exact value shows the message, so editing it clears it.
  const [takenSku, setTakenSku] = useState<string | null>(null);

  const errorsOf = (value: ProductDraft) => {
    const skuTakenError = takenSku !== null && sameSku(takenSku, value.sku) ? k('validation.skuTaken') : undefined;
    const priceKey = priceErrorKey(value.priceCzk);
    const lowStockKey = lowStockErrorKey(value.lowStock);
    return {
      category:
        value.category.trim() === '' ? k(REQUIRED_KEY) : tooLongMessage(k, value.category, PRODUCT_LIMITS.category),
      lowStock: lowStockKey === undefined ? undefined : k(lowStockKey),
      name: value.name.trim() === '' ? k(REQUIRED_KEY) : tooLongMessage(k, value.name, PRODUCT_LIMITS.name),
      price: priceKey === undefined ? undefined : k(priceKey),
      sku:
        value.sku.trim() === '' ? k(REQUIRED_KEY) : (skuTakenError ?? tooLongMessage(k, value.sku, PRODUCT_LIMITS.sku)),
    };
  };
  const form = useFormSave<ProductDraft>({
    command: (value) => ({
      _tag: 'CreateProduct',
      active: true,
      category: value.category.trim(),
      lowStockThreshold: value.lowStock,
      name: value.name.trim(),
      priceMinor: Math.round(value.priceCzk * 100),
      sku: value.sku.trim(),
      unit: value.unit,
      vatRate: value.vatRate,
    }),
    equals: sameProduct,
    initial: blankProduct,
    isValid: (value) => Object.values(errorsOf(value)).every((message) => message === undefined),
    onOpenChange,
    onReload,
    onSaved: () => onCommitted(k('messages.created')),
    open,
    // CreateProduct's only business refusal is a duplicate SKU, so the stock wording in `rejected` does not apply.
    refused: (outcome, value) => {
      if (outcome.reason !== 'rejected') {
        return null;
      }
      setTakenSku(value.sku.trim());
      return k('validation.skuTaken');
    },
    reset: (value) => {
      setDraft(value);
      setTakenSku(null);
    },
    revision,
    value: draft,
  });
  const errors = errorsOf(draft);
  // Field messages show once the draft cannot be sent, or after the server refused it.
  const shown = form.record.status === 'invalid' || form.record.status === 'error';

  return (
    <>
      <SidePanel
        actions={<FormSaveActions form={form} />}
        guard={form.guard}
        onOpenChange={(next) => {
          if (!next) {
            form.leave();
          }
        }}
        open={open}
        resizeLabel={t(RESIZE_LABEL_KEY)}
        size="md"
        title={k('create.title')}
      >
        <form className="flex flex-col gap-200 py-200" onSubmit={(event) => event.preventDefault()}>
          <FormInput
            autoComplete="off"
            id="product-sku"
            label={k('fields.sku')}
            name="sku"
            onChange={(event) => update({ sku: event.target.value })}
            required
            value={draft.sku}
            {...fieldError(shown, errors.sku)}
          />
          <FormInput
            autoComplete="off"
            id="product-name"
            label={k('fields.name')}
            name="name"
            onChange={(event) => update({ name: event.target.value })}
            required
            value={draft.name}
            {...fieldError(shown, errors.name)}
          />
          <FormInput
            autoComplete="off"
            id="product-category"
            label={k('fields.category')}
            name="category"
            onChange={(event) => update({ category: event.target.value })}
            required
            value={draft.category}
            {...fieldError(shown, errors.category)}
          />
          <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
            <SelectTemplate
              items={UNITS.map((value) => selectItem(value, value))}
              label={k('fields.unit')}
              name="unit"
              onValueChange={(details) => {
                const [next] = details.value;
                const picked = UNITS.find((value) => value === next);
                if (picked !== undefined) {
                  update({ unit: picked });
                }
              }}
              placeholder={k('selectPlaceholder')}
              value={[draft.unit]}
            />
            <SelectTemplate
              items={VAT_RATES.map((rate) => selectItem(String(rate), `${rate} %`))}
              label={k('fields.vat')}
              name="vat"
              onValueChange={(details) => {
                const [next] = details.value;
                const picked = VAT_RATES.find((rate) => String(rate) === next);
                if (picked !== undefined) {
                  update({ vatRate: picked });
                }
              }}
              placeholder={k('selectPlaceholder')}
              value={[String(draft.vatRate)]}
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
              onValueChange={(details) => update({ priceCzk: details.valueAsNumber, priceText: details.value })}
              required
              step={1}
              value={draft.priceText}
              {...fieldError(shown, errors.price)}
            >
              <NumericInput.Control>
                <NumericInput.Input aria-valuemax={undefined} />
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
              onValueChange={(details) => update({ lowStock: details.valueAsNumber, lowStockText: details.value })}
              step={1}
              value={draft.lowStockText}
              {...fieldError(shown, errors.lowStock)}
            >
              <NumericInput.Control>
                <NumericInput.Input aria-valuemax={undefined} />
              </NumericInput.Control>
            </FormNumericInput>
          </div>
        </form>
      </SidePanel>
      <UnsavedChangesDialog labels={form.labels} prompt={form.guard.prompt} />
    </>
  );
};

/** Goods receipt: pick a product, enter a positive quantity, record RECEIPT with a positive delta. */
export const ReceiptDialog = ({ onCommitted, onOpenChange, onReload, open, revision }: FormDialogProps) => {
  const k = useProductLabel();
  const { t } = useModernI18n();
  const failure = useCommandFailure();
  const [product, setProduct] = useState<ProductRecord | null>(null);
  const productId = product?.id ?? null;
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
    setProduct(null);
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
        setServerError(failure(outcome.reason, onReload, outcome.proposal));
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
        description={k('receipt.description')}
        onOpenChange={requestClose}
        open={open}
        resizeLabel={t(RESIZE_LABEL_KEY)}
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
          <ProductSearchCombobox
            errorMessage={k('states.error')}
            id="receipt-product"
            label={k('fields.product')}
            loadingMessage={t('merchandise.loading')}
            noResultsMessage={k('states.noResults')}
            onSelect={setProduct}
            placeholder={k('filters.search')}
            retryLabel={k('common.retry')}
            selected={product}
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
              <NumericInput.Input aria-valuemax={undefined} />
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

interface PercentDraft {
  readonly percent: number;
  // The text is what the input shows; "5,5" reaches validation as 5.5 instead of silently becoming 55.
  readonly percentText: string;
}

/** Empty, so the 5 % the form opens with is already a change Uložit sends. */
const noPercent: PercentDraft = { percent: Number.NaN, percentText: '' };
const openingPercent: PercentDraft = { percent: 5, percentText: '5' };

const validPercent = (percent: number) =>
  Number.isInteger(percent) && percent >= PERCENT_MIN && percent <= PERCENT_MAX && percent !== 0;

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
  const { t } = useModernI18n();
  const [draft, setDraft] = useState<PercentDraft>(openingPercent);
  const form = useFormSave<PercentDraft>({
    command: (value) => ({ _tag: 'BulkUpdateProducts', ids: [...ids], patch: { priceChangePercent: value.percent } }),
    equals: (left, right) => left.percentText === right.percentText,
    initial: noPercent,
    isValid: (value) => validPercent(value.percent) && ids.length > 0,
    onOpenChange,
    onReload,
    onSaved: () => onCommitted(k('messages.priceChanged')),
    open,
    opened: openingPercent,
    // The next open starts at 5 % again.
    reset: () => setDraft(openingPercent),
    revision,
    value: draft,
  });

  return (
    <>
      <SidePanel
        actions={<FormSaveActions form={form} />}
        description={k('priceDialog.description')}
        guard={form.guard}
        onOpenChange={(next) => {
          if (!next) {
            form.leave();
          }
        }}
        open={open}
        resizeLabel={t(RESIZE_LABEL_KEY)}
        size="md"
        title={k('priceDialog.title')}
      >
        <form className="flex flex-col gap-200 py-200" onSubmit={(event) => event.preventDefault()}>
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
            onValueChange={(details) => setDraft({ percent: details.valueAsNumber, percentText: details.value })}
            step={1}
            value={draft.percentText}
            {...fieldError(form.record.status === 'invalid' && !validPercent(draft.percent), k('validation.percent'))}
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
      <UnsavedChangesDialog labels={form.labels} prompt={form.guard.prompt} />
    </>
  );
};

interface CategoryDraft {
  readonly category: string;
}

const noCategory: CategoryDraft = { category: '' };

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
  const { t } = useModernI18n();
  const [draft, setDraft] = useState<CategoryDraft>(noCategory);
  const errorOf = (value: CategoryDraft) =>
    value.category.trim() === '' ? k(REQUIRED_KEY) : tooLongMessage(k, value.category, PRODUCT_LIMITS.category);
  const form = useFormSave<CategoryDraft>({
    command: (value) => ({ _tag: 'BulkUpdateProducts', ids: [...ids], patch: { category: value.category.trim() } }),
    equals: (left, right) => left.category === right.category,
    initial: noCategory,
    isValid: (value) => errorOf(value) === undefined && ids.length > 0,
    onOpenChange,
    onReload,
    onSaved: () => onCommitted(k('messages.bulkUpdated')),
    open,
    reset: setDraft,
    revision,
    value: draft,
  });

  return (
    <>
      <SidePanel
        actions={<FormSaveActions form={form} />}
        guard={form.guard}
        onOpenChange={(next) => {
          if (!next) {
            form.leave();
          }
        }}
        open={open}
        resizeLabel={t(RESIZE_LABEL_KEY)}
        size="md"
        title={k('category.title')}
      >
        <form className="flex flex-col gap-200 py-200" onSubmit={(event) => event.preventDefault()}>
          <FormInput
            autoComplete="off"
            id="bulk-category"
            label={k('category.field')}
            name="category"
            onChange={(event) => setDraft({ category: event.target.value })}
            required
            value={draft.category}
            {...fieldError(form.record.status === 'invalid', errorOf(draft))}
          />
        </form>
      </SidePanel>
      <UnsavedChangesDialog labels={form.labels} prompt={form.guard.prompt} />
    </>
  );
};
