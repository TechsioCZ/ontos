import { isStockQuantity, MAX_QUANTITY, MIN_STOCK_QUANTITY } from '../../../../../shared/domain/order-quantity.ts';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { DateTime, Effect, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { Atom } from 'effect/reactivity';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { SelectTemplate } from '@app/admin-ui/select-template';
import {
  SaveBar,
  SidePanel,
  UnsavedChangesDialog,
  requiredLabelFor,
  saveLabelsFor,
  useDraftSave,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { SaveLabels, SaveOutcome, SaveState, UnsavedChangesGuard } from '@app/admin-ui';
import {
  FormBuilder,
  FormReact,
  FormRoot,
  NumberTextSchema,
  NumericField,
  TextField,
  unrenderedField,
  useAtomSet,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { useState } from 'react';
import { CategoryTrailSchema } from '../../../../../shared/apis/records.ts';
import type { CategoryTrail, ProductRecord } from '../../../../../shared/apis/records.ts';
import {
  ProductIdSchema,
  ProductUnitSchema,
  VariantIdSchema,
  sameSku,
} from '../../../../../shared/domain/merchandise-model.ts';
import type { ProductUnit } from '../../../../../shared/domain/merchandise-model.ts';
import { CzVatClassificationCodeSchema } from '@app/shared-contracts/cz-vat-classifications';
import type { CzVatClassificationCode } from '@app/shared-contracts/cz-vat-classifications';
import { MONEY_FORMAT, QUANTITY_FORMAT, WHOLE_NUMBER_FORMAT } from '../../../../form-number.ts';
import { productCommandOutcome, runCommand } from './products-api.ts';
import type { CommandOutcome, ProductCommand } from './products-api.ts';
import { browserAtomRuntime, browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { selectItem } from '../../../../ui/select-item.ts';
import { ProductSearchCombobox } from './product-search.tsx';
import { CategorySearchCombobox } from './category-search-combobox.tsx';
import { loadProductRecord } from './product-reads.ts';
import type { ProductRecordState } from './product-reads.ts';
import { useCommandInputGuard } from './command-input-guard.tsx';
import { useCommandFailure, useProductLabel } from './product-form-labels.ts';
import {
  PRODUCT_LIMITS,
  UNITS,
  fieldError,
  fieldVerdict,
  focusFirstInvalid,
  lowStockErrorKey,
  priceErrorKey,
  tooLongMessage,
} from './product-form-validation.ts';
import { DEFAULT_TAX_CLASSIFICATION, classificationChoices, useTaxLabels } from './product-tax-classification.ts';
import type { CompanyVat } from './product-tax-classification.ts';
import { TaxClassificationSelect } from './product-tax-classification-select.tsx';
import { isSymmyImported } from './symmy-provenance.tsx';

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
const LOADING_KEY = 'merchandise.loading';
const REQUIRED_KEY = 'validation.required';

const DialogActions = ({
  busy,
  disabled = false,
  onCancel,
  onSubmit,
  submit,
}: {
  readonly busy: boolean;
  /** The command cannot be sent yet: its form is not validly filled in. */
  readonly disabled?: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: () => void;
  readonly submit: string;
}) => {
  const label = useProductLabel();
  return (
    <>
      <Button appearance="outline" onClick={onCancel} severity="secondary">
        {label('common.cancel')}
      </Button>
      <Button disabled={disabled} isLoading={busy} loadingText={submit} onClick={onSubmit} severity="primary">
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

/**
 * What the create form holds until Uložit. The number inputs keep the text as typed with the number it reads as; the
 * unit and the VAT classification are picked in selects that write the form's fields. Uložit sends it, so the form
 * itself is never submitted.
 */
const createForm = FormReact.make(
  FormBuilder.empty
    .addField('category', Schema.String)
    .addField('lowStock', NumberTextSchema)
    .addField('name', Schema.String)
    // NaN until typed: an empty price is refused by priceErrorKey instead of starting at 0.
    .addField('price', NumberTextSchema)
    .addField('sku', Schema.String)
    // Picked by staff; until then (null) the form uses the first classification with a rate in force.
    .addField('taxClassificationCode', Schema.OptionFromNullOr(CzVatClassificationCodeSchema))
    .addField('unit', ProductUnitSchema),
  {
    fields: {
      category: TextField,
      lowStock: NumericField,
      name: TextField,
      price: NumericField,
      sku: TextField,
      taxClassificationCode: unrenderedField<CzVatClassificationCode | null>(),
      unit: unrenderedField<ProductUnit>(),
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);
type ProductDraft = typeof createForm.schema.Encoded;

const blankProduct: ProductDraft = {
  category: '',
  lowStock: { number: 0, text: '0' },
  name: '',
  price: { number: Number.NaN, text: '' },
  sku: '',
  taxClassificationCode: null,
  unit: 'ks',
};

const productDraft = createForm.values.pipe(Atom.map(Option.getOrElse(() => blankProduct)));
const unitField = createForm.getFieldAtoms(createForm.fields.unit);
const classificationField = createForm.getFieldAtoms(createForm.fields.taxClassificationCode);

/** The texts carry the numbers, so two drafts with the same texts are the same draft. */
const sameProduct = (left: ProductDraft, right: ProductDraft): boolean =>
  left.category === right.category &&
  left.lowStock.text === right.lowStock.text &&
  left.name === right.name &&
  left.price.text === right.price.text &&
  left.sku === right.sku &&
  left.taxClassificationCode === right.taxClassificationCode &&
  left.unit === right.unit;

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
    // The panel stays mounted while closed; only what the user typed in the open panel asks before leaving.
    open: options.open,
    opened: options.opened,
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
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: startOver });
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
      <Button appearance="outline" onClick={() => form.guard.request(form.leave)} severity="secondary">
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

type CreateProductDialogProps = FormDialogProps & {
  /** The company's VAT rates from the staff records read; they name the classifications the select offers. */
  readonly vat: CompanyVat;
};

const CreateProductPanel = ({ onCommitted, onOpenChange, onReload, open, revision, vat }: CreateProductDialogProps) => {
  const k = useProductLabel();
  const { language, t } = useModernI18n();
  const draft = useAtomValue(productDraft);
  const setValues = useAtomSet(createForm.setValues);
  const setUnit = useAtomSet(unitField.setValue);
  const setClassification = useAtomSet(classificationField.setValue);
  // The SKU the server refused as a duplicate. Only that exact value shows the message, so editing it clears it.
  const [takenSku, setTakenSku] = useState<string | null>(null);

  const taxLabels = useTaxLabels();
  const choices = classificationChoices(vat, DateTime.nowUnsafe());
  // A new product starts on the first classification the company has a rate for (standard first).
  const firstPriced = choices.find((choice) => choice.current !== undefined)?.code;
  const classificationOf = (value: ProductDraft) =>
    value.taxClassificationCode ?? firstPriced ?? DEFAULT_TAX_CLASSIFICATION;
  const classificationError = (value: ProductDraft) => {
    if (firstPriced === undefined) {
      return taxLabels.noRateToCreate;
    }
    const code = classificationOf(value);
    return choices.find((choice) => choice.code === code)?.current === undefined
      ? taxLabels.rateNotInForce(code)
      : undefined;
  };
  const errorsOf = (value: ProductDraft) => {
    const skuTakenError = takenSku !== null && sameSku(takenSku, value.sku) ? k('validation.skuTaken') : undefined;
    const priceKey = priceErrorKey(value.price.number);
    const lowStockKey = lowStockErrorKey(value.lowStock.number);
    return {
      category:
        value.category.trim() === '' ? k(REQUIRED_KEY) : tooLongMessage(k, value.category, PRODUCT_LIMITS.category),
      lowStock: lowStockKey === undefined ? undefined : k(lowStockKey),
      name: value.name.trim() === '' ? k(REQUIRED_KEY) : tooLongMessage(k, value.name, PRODUCT_LIMITS.name),
      price: priceKey === undefined ? undefined : k(priceKey),
      sku:
        value.sku.trim() === '' ? k(REQUIRED_KEY) : (skuTakenError ?? tooLongMessage(k, value.sku, PRODUCT_LIMITS.sku)),
      taxClassification: classificationError(value),
    };
  };
  const form = useFormSave<ProductDraft>({
    command: (value) => ({
      _tag: 'CreateProduct',
      active: true,
      category: value.category.trim(),
      lowStockThreshold: value.lowStock.number,
      name: value.name.trim(),
      priceMinor: Math.round(value.price.number * 100),
      sku: value.sku.trim(),
      taxClassificationCode: classificationOf(value),
      unit: value.unit,
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
      setValues(value);
      setTakenSku(null);
    },
    revision,
    value: draft,
  });
  const errors = errorsOf(draft);
  // Field messages show once the draft cannot be sent, or after the server refused it.
  const shown = form.record.status === 'invalid' || form.record.status === 'error';
  const requiredLabel = requiredLabelFor(language);

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
        <div className="flex flex-col gap-200 py-200">
          <createForm.sku
            autoComplete="off"
            id="product-sku"
            label={k('fields.sku')}
            name="sku"
            required
            requiredLabel={requiredLabel}
            {...fieldVerdict(shown, errors.sku)}
          />
          <createForm.name
            autoComplete="off"
            id="product-name"
            label={k('fields.name')}
            name="name"
            required
            requiredLabel={requiredLabel}
            {...fieldVerdict(shown, errors.name)}
          />
          <createForm.category
            autoComplete="off"
            id="product-category"
            label={k('fields.category')}
            name="category"
            required
            requiredLabel={requiredLabel}
            {...fieldVerdict(shown, errors.category)}
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
                  setUnit(picked);
                }
              }}
              placeholder={k('selectPlaceholder')}
              value={[draft.unit]}
            />
            <TaxClassificationSelect
              error={errors.taxClassification}
              onChange={setClassification}
              value={classificationOf(draft)}
              vat={vat}
            />
          </div>
          <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
            <createForm.price
              formatOptions={MONEY_FORMAT}
              hideValueMax
              id="product-price"
              label={k('fields.price')}
              locale="cs-CZ"
              min={0}
              name="price"
              required
              requiredLabel={requiredLabel}
              step={1}
              {...fieldVerdict(shown, errors.price)}
            />
            <createForm.lowStock
              clampValueOnBlur={false}
              formatOptions={WHOLE_NUMBER_FORMAT}
              hideValueMax
              id="product-low-stock"
              label={k('fields.lowStock')}
              locale="cs-CZ"
              min={0}
              name="lowStock"
              step={1}
              {...fieldVerdict(shown, errors.lowStock)}
            />
          </div>
        </div>
      </SidePanel>
      <UnsavedChangesDialog labels={form.labels} prompt={form.guard.prompt} />
    </>
  );
};

/**
 * Create product: SKU, name, unit, category, VAT classification, price, minimum stock. Sends CreateProduct. The server refuses a
 * SKU the catalog already has; the field then shows that message until the SKU changes. The panel, its footer and its
 * leave question render inside the form, so they read this mount's draft.
 */
export const CreateProductDialog = (props: CreateProductDialogProps) => {
  const { t } = useModernI18n();
  return (
    <FormRoot defaultValues={blankProduct} form={createForm} translateMessage={t}>
      <CreateProductPanel {...props} />
    </FormRoot>
  );
};

/** The picked product's read, shown under the product field: loading, or a failure the retry button answers. */
const receiptReadStatus = (
  read: { readonly failed: boolean; readonly loading: boolean },
  k: ReturnType<typeof useProductLabel>,
) => {
  if (read.failed) {
    return { helpText: k('receipt.productFailed'), validateStatus: 'error' as const };
  }
  return read.loading ? { helpText: k('states.loading') } : {};
};

/** The picked list row (no variants): what the product field shows and whose full record is read. */
const ReceiptProductSchema = Schema.toType(
  Schema.Struct({ id: ProductIdSchema, name: Schema.String, sku: Schema.String }),
);

/**
 * The receipt being typed. Its button records it; Enter in a field does not, so the form itself is never submitted.
 * The product and the variant are picked in a combobox and a select that write the form's fields.
 */
const receiptForm = FormReact.make(
  FormBuilder.empty
    .addField('note', Schema.String)
    .addField('product', Schema.OptionFromNullOr(ReceiptProductSchema))
    .addField('quantity', NumberTextSchema)
    .addField('variantId', Schema.OptionFromNullOr(VariantIdSchema)),
  {
    fields: {
      note: TextField,
      product: unrenderedField<typeof ReceiptProductSchema.Type | null>(),
      quantity: NumericField,
      variantId: unrenderedField<string | null>(),
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);
type ReceiptDraft = typeof receiptForm.schema.Encoded;

const blankReceipt: ReceiptDraft = { note: '', product: null, quantity: { number: 1, text: '1' }, variantId: null };

/** True when the receipt holds a picked product or typed input. */
const isReceiptDirty = (draft: ReceiptDraft) =>
  draft.product !== null || draft.quantity.text !== blankReceipt.quantity.text || draft.note !== '';

const receiptDraft = receiptForm.values.pipe(Atom.map(Option.getOrElse(() => blankReceipt)));
const receiptProductField = receiptForm.getFieldAtoms(receiptForm.fields.product);
const receiptVariantField = receiptForm.getFieldAtoms(receiptForm.fields.variantId);

/** The full record (variants) of one picked product, read when it is picked or retried. */
interface ReceiptRead {
  readonly productId: ProductRecord['id'];
  readonly record: ProductRecordState;
}

/**
 * The picked product of the receipt form with its full record. A record that arrives after another pick is dropped,
 * so a receipt never takes its variants from the previously picked product.
 */
const useReceiptSelection = (draft: ReceiptDraft) => {
  const setProduct = useAtomSet(receiptProductField.setValue);
  const setVariant = useAtomSet(receiptVariantField.setValue);
  const [read, setRead] = useState<ReceiptRead | null>(null);
  const startRead = (productId: ProductRecord['id']) => {
    setRead({ productId, record: { status: 'loading' } });
    loadProductRecord(productId, (record) =>
      setRead((current) => (current?.productId === productId ? { productId, record } : current)),
    );
  };
  const handleProductSelect = (picked: ProductRecord | null) => {
    setVariant(null);
    if (picked === null) {
      setProduct(null);
      return;
    }
    setProduct({ id: picked.id, name: picked.name, sku: picked.sku });
    startRead(picked.id);
  };
  const { product, variantId } = draft;
  const handleRetry = () => {
    if (product !== null) {
      startRead(product.id);
    }
  };
  const record = product !== null && read?.productId === product.id ? read.record : undefined;
  const fullProduct = record?.status === 'ready' ? record.product : undefined;
  const variants = fullProduct?.variantRecords ?? [];
  const variant = variants.find((entry) => entry.id === variantId);
  return {
    failed: record?.status === 'error',
    fullProduct,
    handleProductSelect,
    handleRetry,
    handleVariantSelect: (next: string | undefined) =>
      setVariant(variants.find((entry) => entry.id === next)?.id ?? null),
    loading: record?.status === 'loading',
    product,
    variant,
    variantMissing: variants.length > 0 && variant === undefined,
    variants,
  };
};

const ReceiptPanel = ({ onCommitted, onOpenChange, onReload, open, revision }: FormDialogProps) => {
  const k = useProductLabel();
  const { t } = useModernI18n();
  const failure = useCommandFailure();
  const draft = useAtomValue(receiptDraft);
  const setValues = useAtomSet(receiptForm.setValues);
  const selection = useReceiptSelection(draft);
  const { fullProduct, product, variant, variantMissing, variants } = selection;
  const { note, variantId } = draft;
  const quantity = draft.quantity.number;
  const productId = product?.id ?? null;
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const dirty = isReceiptDirty(draft);

  const productError = productId === null ? k(REQUIRED_KEY) : undefined;
  const quantityError = isStockQuantity(quantity) && quantity > 0 ? undefined : k('validation.quantity');
  const noteError = tooLongMessage(k, note, PRODUCT_LIMITS.note);
  // A Symmy product's stock lives in the ERP: only the movement form of its detail writes it there first.
  const symmy = fullProduct !== undefined && isSymmyImported(fullProduct);
  const valid =
    fullProduct !== undefined &&
    !symmy &&
    !variantMissing &&
    productError === undefined &&
    quantityError === undefined &&
    noteError === undefined;

  const clearForm = () => {
    setValues(blankReceipt);
    setSubmitted(false);
  };
  // The receipt keeps its own button; leaving with typed input asks the shared leave question first.
  const { dialog, guard } = useCommandInputGuard(open && dirty, clearForm);
  const close = () => guard.request(() => onOpenChange(false));
  const submit = () => {
    if (busy) {
      return;
    }
    setSubmitted(true);
    if (productId === null || !valid) {
      // The combobox puts its id on the input as `${id}-input`.
      focusFirstInvalid([
        ['receipt-product-input', productId === null],
        ['receipt-variant', variantMissing],
        ['receipt-quantity', quantityError !== undefined],
        ['receipt-note', noteError !== undefined],
      ]);
      return;
    }
    setBusy(true);
    setServerError(null);
    const trimmed = note.trim();
    const movement = { _tag: 'RecordStockMovement' as const, delta: quantity, productId, reason: 'RECEIPT' as const };
    const receipt = variant === undefined ? movement : { ...movement, variantId: variant.id };
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
            disabled={!valid}
            onCancel={close}
            onSubmit={submit}
            submit={k('receipt.submit')}
          />
        }
        description={k('receipt.description')}
        guard={guard}
        onOpenChange={(next) => {
          if (!next) {
            onOpenChange(false);
          }
        }}
        open={open}
        resizeLabel={t(RESIZE_LABEL_KEY)}
        size="md"
        title={k('receipt.title')}
      >
        <div className="flex flex-col gap-200 py-200">
          <ErrorLine message={serverError} />
          {symmy && (
            <StatusText showIcon status="error">
              Sklad tohoto produktu měňte v detailu produktu (Pohyby), aby se zapsal i do ERP.
            </StatusText>
          )}
          <ProductSearchCombobox
            errorMessage={k('states.error')}
            id="receipt-product"
            label={k('fields.product')}
            loadingMessage={t(LOADING_KEY)}
            noResultsMessage={k('states.noResults')}
            onSelect={selection.handleProductSelect}
            placeholder={k('filters.search')}
            retryLabel={k('common.retry')}
            selected={product}
            {...(productId === null ? fieldError(submitted, productError) : receiptReadStatus(selection, k))}
          />
          {selection.failed && (
            <div>
              <Button appearance="outline" onClick={selection.handleRetry} severity="secondary" size="sm" type="button">
                {k('common.retry')}
              </Button>
            </div>
          )}
          {variants.length > 0 && (
            <SelectTemplate
              id="receipt-variant"
              items={variants.map((entry) => selectItem(entry.id, `${entry.name} (${entry.sku})`))}
              label={t('merchandise.ui.variant')}
              name="receiptVariant"
              onValueChange={(details) => selection.handleVariantSelect(details.value[0])}
              placeholder={t('merchandise.ui.selectVariant')}
              required
              value={variantId === null ? [] : [variantId]}
              {...fieldError(submitted && variantMissing, k(REQUIRED_KEY))}
            />
          )}
          <receiptForm.quantity
            clampValueOnBlur={false}
            formatOptions={QUANTITY_FORMAT}
            hideValueMax
            id="receipt-quantity"
            label={k('fields.quantity')}
            locale="cs-CZ"
            max={MAX_QUANTITY}
            min={MIN_STOCK_QUANTITY}
            name="quantity"
            step={1}
            {...fieldVerdict(submitted, quantityError)}
          />
          <receiptForm.note
            autoComplete="off"
            id="receipt-note"
            label={k('fields.note')}
            name="note"
            {...fieldVerdict(submitted, noteError)}
          />
        </div>
      </SidePanel>
      {dialog}
    </>
  );
};

/**
 * Goods receipt: pick a product, enter a positive quantity, record RECEIPT with a positive delta. The panel renders
 * inside the form, so its button and leave question read this mount's receipt.
 */
export const ReceiptDialog = (props: FormDialogProps) => {
  const { t } = useModernI18n();
  return (
    <FormRoot defaultValues={blankReceipt} form={receiptForm} translateMessage={t}>
      <ReceiptPanel {...props} />
    </FormRoot>
  );
};

const PERCENT_MIN = -90;
const PERCENT_MAX = 1000;

/**
 * The bulk price change. The percent's text is what the input shows; "5,5" reaches validation as 5.5 instead of
 * silently becoming 55. Uložit sends it, so the form itself is never submitted.
 */
const percentForm = FormReact.make(FormBuilder.empty.addField('percent', NumberTextSchema), {
  fields: { percent: NumericField },
  onSubmit: () => Effect.void,
  runtime: browserAtomRuntime,
});
type PercentDraft = typeof percentForm.schema.Encoded;

/** Empty, so the 5 % the form opens with is already a change Uložit sends. */
const noPercent: PercentDraft = { percent: { number: Number.NaN, text: '' } };
const openingPercent: PercentDraft = { percent: { number: 5, text: '5' } };

const percentDraft = percentForm.values.pipe(Atom.map(Option.getOrElse(() => openingPercent)));

const validPercent = (percent: number) =>
  Number.isInteger(percent) && percent >= PERCENT_MIN && percent <= PERCENT_MAX && percent !== 0;

const NO_PRODUCTS: readonly Pick<ProductRecord, 'id' | 'name'>[] = [];

type PriceChangeDialogProps = FormDialogProps & {
  readonly ids: readonly ProductRecord['id'][];
  /** Selected products imported through Symmy: their price is written to the ERP only by the detail save. */
  readonly symmyProducts?: readonly Pick<ProductRecord, 'id' | 'name'>[];
  /** Selected products the list knows to be priced by sellable variants. */
  readonly variantProducts: readonly Pick<ProductRecord, 'id' | 'name'>[];
};

const PriceChangePanel = ({
  ids,
  onCommitted,
  onOpenChange,
  onReload,
  open,
  revision,
  symmyProducts = NO_PRODUCTS,
  variantProducts,
}: PriceChangeDialogProps) => {
  const k = useProductLabel();
  const { t } = useModernI18n();
  const draft = useAtomValue(percentDraft);
  const setValues = useAtomSet(percentForm.setValues);
  const form = useFormSave<PercentDraft>({
    command: (value) => ({
      _tag: 'BulkUpdateProducts',
      ids: [...ids],
      patch: { priceChangePercent: value.percent.number },
    }),
    equals: (left, right) => left.percent.text === right.percent.text,
    initial: noPercent,
    isValid: (value) =>
      validPercent(value.percent.number) &&
      ids.length > 0 &&
      variantProducts.length === 0 &&
      symmyProducts.length === 0,
    onOpenChange,
    onReload,
    onSaved: () => onCommitted(k('messages.priceChanged')),
    open,
    opened: openingPercent,
    // The next open starts at 5 % again.
    reset: () => setValues(openingPercent),
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
        <div className="flex flex-col gap-200 py-200">
          <p className="text-fg-secondary text-sm tabular-nums">
            {t('merchandise.pages.products.priceDialog.affected', { total: ids.length })}
          </p>
          {variantProducts.length > 0 && (
            <StatusText showIcon status="error">
              {t('merchandise.pages.products.priceDialog.variantProducts', {
                names: variantProducts.map((product) => product.name).join(', '),
              })}
            </StatusText>
          )}
          {symmyProducts.length > 0 && (
            <StatusText showIcon status="error">
              Cenu tohoto produktu měňte v detailu produktu. Importováno přes Symmy:{' '}
              {symmyProducts.map((product) => product.name).join(', ')}
            </StatusText>
          )}
          {/* The real -90..1000 range for ARIA, without clamping on blur, so validation still sees an out-of-range value. */}
          <percentForm.percent
            clampValueOnBlur={false}
            formatOptions={WHOLE_NUMBER_FORMAT}
            id="price-percent"
            label={k('priceDialog.field')}
            locale="cs-CZ"
            max={PERCENT_MAX}
            min={PERCENT_MIN}
            name="priceChangePercent"
            step={1}
            {...fieldVerdict(
              form.record.status === 'invalid' && !validPercent(draft.percent.number),
              k('validation.percent'),
            )}
          />
          <StatusText showIcon status="warning">
            {k('priceDialog.warning')}
          </StatusText>
        </div>
      </SidePanel>
      <UnsavedChangesDialog labels={form.labels} prompt={form.guard.prompt} />
    </>
  );
};

/**
 * Bulk price change by a whole percent. Sends BulkUpdateProducts with priceChangePercent. Products priced by their
 * variants cannot take it (each variant has its own price); the selected ones the list shows are named before
 * anything is typed, and the server refuses any others.
 */
export const PriceChangeDialog = (props: PriceChangeDialogProps) => {
  const { t } = useModernI18n();
  return (
    <FormRoot defaultValues={openingPercent} form={percentForm} translateMessage={t}>
      <PriceChangePanel {...props} />
    </FormRoot>
  );
};

/**
 * The bulk category change: a picked storefront tree category (a company with a tree) or a typed category label (a
 * company without a tree). Uložit sends it, so the form itself is never submitted.
 */
const categoryForm = FormReact.make(
  FormBuilder.empty
    .addField('category', Schema.OptionFromNullOr(Schema.toType(CategoryTrailSchema)))
    .addField('label', Schema.String),
  {
    fields: { category: unrenderedField<CategoryTrail | null>(), label: TextField },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);
type CategoryDraft = typeof categoryForm.schema.Encoded;

const noCategory: CategoryDraft = { category: null, label: '' };

const categoryDraft = categoryForm.values.pipe(Atom.map(Option.getOrElse(() => noCategory)));
const categoryField = categoryForm.getFieldAtoms(categoryForm.fields.category);

type CategoryDialogProps = FormDialogProps & {
  readonly hasTree: boolean;
  readonly ids: readonly ProductRecord['id'][];
};

const CategoryPanel = ({ hasTree, ids, onCommitted, onOpenChange, onReload, open, revision }: CategoryDialogProps) => {
  const k = useProductLabel();
  const { language, t } = useModernI18n();
  const draft = useAtomValue(categoryDraft);
  const setValues = useAtomSet(categoryForm.setValues);
  const setCategory = useAtomSet(categoryField.setValue);
  const errorOf = (value: CategoryDraft) => {
    if (hasTree) {
      return value.category === null ? k(REQUIRED_KEY) : undefined;
    }
    return value.label.trim() === '' ? k(REQUIRED_KEY) : tooLongMessage(k, value.label, PRODUCT_LIMITS.category);
  };
  const form = useFormSave<CategoryDraft>({
    command: (value) => ({
      _tag: 'BulkUpdateProducts',
      ids: [...ids],
      patch: hasTree && value.category !== null ? { categoryId: value.category.id } : { category: value.label.trim() },
    }),
    equals: (left, right) => left.category?.id === right.category?.id && left.label === right.label,
    initial: noCategory,
    isValid: (value) => errorOf(value) === undefined && ids.length > 0,
    onOpenChange,
    onReload,
    onSaved: () => onCommitted(k('messages.bulkUpdated')),
    open,
    // With a tree the only business refusal is a category that no longer exists (deleted or moved meanwhile).
    refused: (outcome) => (hasTree && outcome.reason === 'rejected' ? k('category.missing') : null),
    reset: setValues,
    revision,
    value: draft,
  });
  const shown = form.record.status === 'invalid';

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
        <div className="flex flex-col gap-200 py-200">
          {hasTree ? (
            <CategorySearchCombobox
              errorMessage={k('filters.categoryError')}
              id="bulk-category"
              label={k('category.field')}
              loadingMessage={t(LOADING_KEY)}
              moreMessage={(count, total) =>
                t('merchandise.pages.products.filters.categoryMore', { shown: count, total })
              }
              noResultsMessage={k('filters.categoryNoResults')}
              onSelect={setCategory}
              placeholder={k('filters.categorySearch')}
              required
              retryLabel={k('filters.categoryRetry')}
              selected={draft.category}
              {...fieldError(shown, errorOf(draft))}
            />
          ) : (
            <categoryForm.label
              autoComplete="off"
              id="bulk-category"
              label={k('category.field')}
              name="category"
              required
              requiredLabel={requiredLabelFor(language)}
              {...fieldVerdict(shown, errorOf(draft))}
            />
          )}
        </div>
      </SidePanel>
      <UnsavedChangesDialog labels={form.labels} prompt={form.guard.prompt} />
    </>
  );
};

/**
 * Bulk category change. A company with a storefront tree picks a tree category and sends its identity, so the server
 * derives each product's category path; a company without a tree types the category label as before.
 */
export const CategoryDialog = (props: CategoryDialogProps) => {
  const { t } = useModernI18n();
  return (
    <FormRoot defaultValues={noCategory} form={categoryForm} translateMessage={t}>
      <CategoryPanel {...props} />
    </FormRoot>
  );
};
