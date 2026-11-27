import type { IsoDate } from '../../../../../shared/domain/common.ts';
import { Effect, Option, Result, Schema } from 'effect';
import { optionalField } from '../../../../../shared/domain/common.ts';
// S06 forms: new supplier quote, new purchase order (direct or from replenishment), supplier. ops-purchasing lane.
import { SidePanel, requiredLabelFor, surfaceTileClassName } from '@app/admin-ui';
import {
  ChoiceField,
  Field,
  FormBuilder,
  FormReact,
  FormRoot,
  TemplateChoiceField,
  TextAreaField,
  TextField,
  useAtomSet,
  useAtomSubscribe,
} from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { useId, useRef, useState } from 'react';
import { browserAtomRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { useFormValues } from '../../../../ui/form-values.tsx';
import {
  StockItemCategorySchema,
  StockTrackingSchema,
  SupplierIcoSchema,
} from '../../../../../shared/domain/purchasing.ts';
import type { PurchasingState, StockItem } from '../../../../../shared/domain/purchasing.ts';
import {
  failureKey,
  formatAmount,
  parseAmountMinor,
  parsePositiveInt,
  todayIso,
  usePurchasingT,
} from './purchasing-model.ts';
import type { RunCommand } from './purchasing-model.ts';
import { FormSaveFooter, refusedOutcome, submitDone, useFormSave } from '../../../../ui/form-save.tsx';

const cancelLabelKey = 'facility-operations.common.cancel';
const optionPlaceholderKey = 'placeholders.option';
const closeLabelKey = 'facility-operations.common.close';
const noteLabelKey = 'facility-operations.common.note';
const requiredLabelKey = 'facility-operations.common.required';

const FREE = '__free__';

/**
 * One order or quote line as typed: `itemChoice` is the picked stock item or the free-text choice, and `key` tells the
 * rows apart while lines come and go.
 */
const DraftLineSchema = Schema.Struct({
  description: Schema.String,
  itemChoice: Schema.String,
  key: Schema.String,
  price: Schema.String,
  quantity: Schema.String,
});
export type DraftLine = typeof DraftLineSchema.Type;

export const draftLine = (key: string, item?: StockItem, quantity?: number): DraftLine => ({
  description: item?.name ?? '',
  itemChoice: item?.id ?? FREE,
  key,
  price: item?.lastPriceMinor === undefined ? '' : String(item.lastPriceMinor / 100),
  quantity: quantity === undefined ? '' : String(quantity),
});

/** A line whose item was just picked: it takes the item's name and its last price, when the item has one. */
const pickedItemLine = (line: DraftLine, item: StockItem | undefined): DraftLine => ({
  ...line,
  description: item?.name ?? line.description,
  ...optionalField('price', item?.lastPriceMinor === undefined ? undefined : String(item.lastPriceMinor / 100)),
});

/**
 * A new purchase order or a received supplier quote. Uložit sends it through the form save, so the form only holds
 * the values and Enter sends nothing. One document panel is open at a time.
 */
const purchaseDocumentForm = FormReact.make(
  FormBuilder.empty
    .addField('date', Schema.String)
    .addField(Field.makeArrayField('lines', DraftLineSchema))
    .addField('note', Schema.String)
    .addField('number', Schema.String)
    .addField('secondDate', Schema.String)
    .addField('supplierId', Schema.String)
    .addField('warehouseId', Schema.String),
  {
    fields: {
      date: TextField,
      lines: {
        description: TextField,
        itemChoice: TemplateChoiceField,
        key: TextField,
        price: TextField,
        quantity: TextField,
      },
      note: TextAreaField,
      number: TextField,
      secondDate: TextField,
      supplierId: ChoiceField,
      warehouseId: ChoiceField,
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);
type PurchaseDocumentValues = typeof purchaseDocumentForm.schema.Encoded;

const lineAmount = (line: DraftLine) => (parsePositiveInt(line.quantity) ?? 0) * (parseAmountMinor(line.price) ?? 0);

const LinesEditor = ({ state }: { readonly state: PurchasingState }) => {
  const k = usePurchasingT();
  const keyPrefix = useId();
  const lineSequence = useRef(0);
  const itemChoices = [
    { label: k('lines.free'), value: FREE },
    ...state.items.map((item) => ({ label: `${item.sku} · ${item.name}`, value: item.id })),
  ];
  return (
    <div className="flex flex-col gap-150">
      <span className="font-medium text-sm">{k('fields.lines')}</span>
      <purchaseDocumentForm.lines>
        {({ append, items, remove }) => (
          <>
            {items.map((line, index) => (
              <purchaseDocumentForm.lines.Item index={index} key={line.key}>
                <div className={`${surfaceTileClassName} flex flex-col gap-100 p-150`}>
                  <div className="flex flex-col gap-100">
                    <purchaseDocumentForm.lines.itemChoice
                      items={itemChoices}
                      label={k('lines.item', { index: index + 1 })}
                      placeholder={k('placeholders.item')}
                      size="sm"
                    />
                    {line.itemChoice === FREE && (
                      <purchaseDocumentForm.lines.description
                        id={`line-description-${line.key}`}
                        label={k('fields.description')}
                        maxLength={300}
                        size="sm"
                      />
                    )}
                  </div>
                  <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-100">
                    <purchaseDocumentForm.lines.quantity
                      id={`line-quantity-${line.key}`}
                      inputMode="numeric"
                      label={k('fields.quantity')}
                      size="sm"
                    />
                    <purchaseDocumentForm.lines.price
                      id={`line-price-${line.key}`}
                      inputMode="decimal"
                      label={k('fields.unitPriceCzk')}
                      size="sm"
                    />
                    <div className="flex items-end">
                      <Button
                        appearance="ghost"
                        aria-label={k('lines.remove')}
                        disabled={items.length === 1}
                        icon="icon-[mdi--close]"
                        onClick={() => remove(index)}
                        severity="secondary"
                        size="sm"
                      />
                    </div>
                  </div>
                  <span className="text-right text-fg-secondary text-xs tabular-nums">
                    {formatAmount(lineAmount(line))}
                  </span>
                </div>
              </purchaseDocumentForm.lines.Item>
            ))}
            <div className="flex flex-wrap items-center justify-between gap-100">
              <Button
                appearance="outline"
                icon="icon-[mdi--plus]"
                onClick={() => {
                  lineSequence.current += 1;
                  append(draftLine(`${keyPrefix}-${lineSequence.current}`));
                }}
                severity="secondary"
                size="sm"
              >
                {k('lines.add')}
              </Button>
              <span className="font-semibold text-sm tabular-nums">
                {`${k('fields.total')}: ${formatAmount(items.reduce((sum, line) => sum + lineAmount(line), 0))}`}
              </span>
            </div>
          </>
        )}
      </purchaseDocumentForm.lines>
    </div>
  );
};

type PurchaseDraftLine = Extract<Parameters<RunCommand>[0], { readonly _tag: 'PurchaseOrderCreate' }>['lines'][number];
const linesToCommand = (lines: readonly DraftLine[], items: readonly StockItem[]) => {
  const result: PurchaseDraftLine[] = [];
  const itemsById = new Map<string, StockItem>();
  for (const item of items) {
    if (!itemsById.has(item.id)) {
      itemsById.set(item.id, item);
    }
  }
  for (const line of lines) {
    const quantity = parsePositiveInt(line.quantity);
    const unitPriceMinor = parseAmountMinor(line.price);
    const description = line.description.trim();
    const item = itemsById.get(line.itemChoice);
    if (quantity === undefined || unitPriceMinor === undefined || description === '') {
      return Option.none();
    }
    if (line.itemChoice !== FREE && item === undefined) {
      return Option.none();
    }
    result.push({ description, quantity, unitPriceMinor, ...optionalField('itemId', item?.id) });
  }
  return Option.some(result);
};
const DocumentKindSchema = Schema.Literals(['order', 'quote']);

type DocumentKind = typeof DocumentKindSchema.Type;

/** New purchase order (direct) or new received supplier quote. */
interface SubmitPurchaseDocumentInput {
  readonly date: string;
  readonly k: ReturnType<typeof usePurchasingT>;
  readonly kind: DocumentKind;
  readonly lines: readonly DraftLine[];
  readonly note: string;
  readonly number: string;
  readonly onCreated: (id: string) => void;
  readonly run: RunCommand;
  readonly secondDate: IsoDate;
  readonly setError: (value: string | undefined) => void;
  readonly state: PurchasingState;
  readonly supplierId: string;
  readonly t: ReturnType<typeof useModernI18n>['t'];
  readonly toast: ReturnType<typeof useToast>;
  readonly warehouseId: string;
}
const submitPurchaseDocument = Effect.fn('FacilityOperations.Purchasing.submitPurchaseDocument')(
  function* submitPurchaseDocument(input: SubmitPurchaseDocumentInput) {
    const {
      date,
      k,
      kind,
      lines,
      note,
      number,
      onCreated,
      run,
      secondDate,
      setError,
      state,
      supplierId,
      t,
      toast,
      warehouseId,
    } = input;
    setError(undefined);
    const commandLines = Option.getOrUndefined(linesToCommand(lines, state.items));
    const supplier = state.suppliers.find((candidate) => candidate.id === supplierId);
    if (
      supplier === undefined ||
      commandLines === undefined ||
      (kind === 'quote' && (number.trim() === '' || date === ''))
    ) {
      setError(k('lines.invalid'));
      return 'failed' as const;
    }
    const optionalNote = optionalField('note', note.trim() === '' ? undefined : note.trim());
    let command: Parameters<RunCommand>[0];
    if (kind === 'order') {
      const warehouse = state.warehouses.find((candidate) => candidate.id === warehouseId);
      if (warehouse === undefined) {
        setError(k('lines.invalid'));
        return 'failed' as const;
      }
      command = {
        _tag: 'PurchaseOrderCreate',
        currency: 'CZK',
        lines: commandLines,
        supplierId: supplier.id,
        warehouseId: warehouse.id,
        ...optionalField('expectedDate', secondDate === '' ? undefined : secondDate),
        ...optionalNote,
      };
    } else {
      command = {
        _tag: 'PurchaseQuoteCreate',
        currency: 'CZK',
        date,
        lines: commandLines,
        number: number.trim(),
        supplierId: supplier.id,
        ...optionalField('validUntil', secondDate === '' ? undefined : secondDate),
        ...optionalNote,
      };
    }
    const outcome = yield* run(command);
    if (!outcome.ok) {
      setError(t(failureKey(outcome.reason)));
      return refusedOutcome(outcome);
    }
    return submitDone(() => {
      toast.create({
        duration: 5000,
        title: k(kind === 'order' ? 'orders.created' : 'quotes.created'),
        type: 'success',
      });
      onCreated(outcome.result.entityIds[0] ?? '');
    });
  },
);

export const PurchaseDocumentPanel = ({
  initialLines,
  initialSupplierId,
  kind,
  onClose,
  onCreated,
  run,
  state,
}: {
  readonly initialLines?: readonly DraftLine[];
  readonly initialSupplierId?: string;
  readonly kind: DocumentKind;
  readonly onClose: () => void;
  readonly onCreated: (id: string) => void;
  readonly run: RunCommand;
  readonly state: PurchasingState;
}) => {
  const k = usePurchasingT();
  const { language, t } = useModernI18n();
  const toast = useToast();
  const initialLineId = useId();
  const opened: PurchaseDocumentValues = {
    date: todayIso(),
    lines: initialLines ?? [draftLine(initialLineId)],
    note: '',
    number: '',
    secondDate: '',
    supplierId: initialSupplierId ?? state.suppliers[0]?.id ?? '',
    warehouseId:
      state.items.find((item) => item.id === initialLines?.[0]?.itemChoice)?.warehouseId ??
      state.warehouses[0]?.id ??
      '',
  };
  const shown = useFormValues(purchaseDocumentForm, opened);
  const { values } = shown;
  const setValues = useAtomSet(purchaseDocumentForm.setValues);
  // Picking a line's item fills in its name and last price.
  useAtomSubscribe(purchaseDocumentForm.values, (next) => {
    if (!shown.initialized || Option.isNone(next)) {
      return;
    }
    const lines = next.value.lines.map((line) => {
      const before = values.lines.find((entry) => entry.key === line.key);
      return before === undefined || before.itemChoice === line.itemChoice
        ? line
        : pickedItemLine(
            line,
            state.items.find((item) => item.id === line.itemChoice),
          );
    });
    if (lines.some((line, index) => line !== next.value.lines[index])) {
      setValues({ ...next.value, lines });
    }
  });
  const [error, setError] = useState<string | undefined>();
  // The order or quote is sent on Uložit only; lines handed over from a suggestion can be sent as they are.
  const form = useFormSave({
    savableAtOnce: initialLines !== undefined,
    submit: () =>
      submitPurchaseDocument({
        date: values.date,
        k,
        kind,
        lines: values.lines,
        note: values.note,
        number: values.number,
        onCreated,
        run,
        secondDate: values.secondDate,
        setError,
        state,
        supplierId: values.supplierId,
        t,
        toast,
        warehouseId: values.warehouseId,
      }),
    value: values,
  });
  const requiredLabel = requiredLabelFor(language);
  return (
    <SidePanel
      actions={<FormSaveFooter cancelLabel={t(cancelLabelKey)} error={error} form={form} onCancel={onClose} />}
      description={k(kind === 'order' ? 'orders.createDescription' : 'quotes.createDescription')}
      guard={form.guard}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      resizeLabel={t(closeLabelKey)}
      size="lg"
      title={k(kind === 'order' ? 'orders.createTitle' : 'quotes.createTitle')}
    >
      <FormRoot
        className="flex flex-col gap-200 py-200"
        defaultValues={opened}
        form={purchaseDocumentForm}
        translateMessage={(message) => t(message)}
      >
        {shown.ready}
        {error !== undefined && (
          <StatusText showIcon status="error">
            {error}
          </StatusText>
        )}
        <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
          <purchaseDocumentForm.supplierId
            items={state.suppliers.map((entry) => ({ label: entry.name, value: entry.id }))}
            label={k('fields.supplier')}
            placeholder={k('placeholders.supplier')}
          />
          {kind === 'order' ? (
            <purchaseDocumentForm.warehouseId
              items={state.warehouses.map((entry) => ({ label: entry.name, value: entry.id }))}
              label={k('fields.deliverTo')}
              placeholder={k('placeholders.warehouse')}
            />
          ) : (
            <purchaseDocumentForm.number
              id="quote-number"
              label={k('fields.quoteNumber')}
              maxLength={64}
              required
              requiredLabel={requiredLabel}
            />
          )}
          {kind === 'quote' && (
            <purchaseDocumentForm.date
              id="quote-date"
              label={k('fields.quoteDate')}
              required
              requiredLabel={requiredLabel}
              type="date"
            />
          )}
          <purchaseDocumentForm.secondDate
            id="document-second-date"
            label={kind === 'order' ? k('fields.expectedDate') : k('fields.validUntil')}
            type="date"
          />
        </div>
        <LinesEditor state={state} />
        <purchaseDocumentForm.note id="document-note" label={t(noteLabelKey)} rows={2} />
      </FormRoot>
    </SidePanel>
  );
};

/** A new supplier as typed. Uložit sends it through the form save, so Enter sends nothing. */
const supplierForm = FormReact.make(
  FormBuilder.empty
    .addField('contact', Schema.String)
    .addField('email', Schema.String)
    .addField('ico', Schema.String)
    .addField('leadTimeDays', Schema.String)
    .addField('name', Schema.String)
    .addField('note', Schema.String)
    .addField('phone', Schema.String),
  {
    fields: {
      contact: TextField,
      email: TextField,
      ico: TextField,
      leadTimeDays: TextField,
      name: TextField,
      note: TextField,
      phone: TextField,
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);
type SupplierValues = typeof supplierForm.schema.Encoded;
const noSupplier: SupplierValues = {
  contact: '',
  email: '',
  ico: '',
  leadTimeDays: '',
  name: '',
  note: '',
  phone: '',
};

interface SubmitSupplierInput {
  readonly k: ReturnType<typeof usePurchasingT>;
  readonly onClose: () => void;
  readonly run: RunCommand;
  readonly setError: (value: string | undefined) => void;
  readonly t: ReturnType<typeof useModernI18n>['t'];
  readonly toast: ReturnType<typeof useToast>;
  readonly value: (name: keyof SupplierValues) => string;
}

const submitSupplier = Effect.fn('FacilityOperations.Purchasing.submitSupplier')(function* submitSupplier(
  input: SubmitSupplierInput,
) {
  const { k, onClose, run, setError, t, toast, value } = input;
  setError(undefined);
  const lead = value('leadTimeDays');
  const leadValue = lead === '' ? undefined : Number(lead);
  if (
    value('name') === '' ||
    (value('ico') !== '' && !/^\d{8}$/u.test(value('ico'))) ||
    (leadValue !== undefined && !Number.isInteger(leadValue))
  ) {
    setError(k('suppliers.invalid'));
    return 'failed' as const;
  }
  const ico = yield* Effect.result(
    Schema.decodeEffect(Schema.OptionFromUndefinedOr(SupplierIcoSchema))(
      value('ico') === '' ? undefined : value('ico'),
    ),
  );
  if (Result.isFailure(ico)) {
    setError(k('suppliers.invalid'));
    yield* Effect.logWarning('Supplier identifier validation failed', ico.failure);
    return 'failed' as const;
  }
  const optional = (name: 'contact' | 'email' | 'note' | 'phone') =>
    optionalField(name, value(name) === '' ? undefined : value(name));
  const outcome = yield* run({
    _tag: 'PurchaseSupplierCreate',
    name: value('name'),
    ...optional('contact'),
    ...optional('email'),
    ...optional('phone'),
    ...optional('note'),
    ...optionalField('ico', Option.getOrUndefined(ico.success)),
    ...optionalField('leadTimeDays', leadValue),
  });
  if (!outcome.ok) {
    setError(t(failureKey(outcome.reason)));
    return refusedOutcome(outcome);
  }
  return submitDone(() => {
    toast.create({ duration: 5000, title: k('suppliers.created'), type: 'success' });
    onClose();
  });
});

export const SupplierPanel = ({ onClose, run }: { readonly onClose: () => void; readonly run: RunCommand }) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const toast = useToast();
  const shown = useFormValues(supplierForm, noSupplier);
  const { values } = shown;
  const [error, setError] = useState<string | undefined>();
  const value = (name: keyof SupplierValues) => values[name].trim();
  // The supplier is created on Uložit only.
  const form = useFormSave({
    submit: () => submitSupplier({ k, onClose, run, setError, t, toast, value }),
    value: values,
  });
  return (
    <SidePanel
      actions={<FormSaveFooter cancelLabel={t(cancelLabelKey)} error={error} form={form} onCancel={onClose} />}
      guard={form.guard}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      resizeLabel={t(closeLabelKey)}
      size="md"
      title={k('suppliers.createTitle')}
    >
      <FormRoot
        className="flex flex-col gap-200 py-200"
        defaultValues={noSupplier}
        form={supplierForm}
        translateMessage={(message) => t(message)}
      >
        {shown.ready}
        {error !== undefined && (
          <StatusText showIcon status="error">
            {error}
          </StatusText>
        )}
        <supplierForm.name id="supplier-name" label={k('fields.supplierName')} maxLength={200} />
        <supplierForm.ico id="supplier-ico" inputMode="numeric" label={k('fields.ico')} maxLength={200} />
        <supplierForm.contact id="supplier-contact" label={k('fields.contact')} maxLength={200} />
        <supplierForm.email id="supplier-email" label={k('fields.email')} maxLength={200} type="email" />
        <supplierForm.phone id="supplier-phone" label={k('fields.phone')} maxLength={200} />
        <supplierForm.leadTimeDays
          id="supplier-leadTimeDays"
          inputMode="numeric"
          label={k('fields.leadTimeDays')}
          maxLength={200}
        />
        <supplierForm.note id="supplier-note" label={t(noteLabelKey)} maxLength={200} />
      </FormRoot>
    </SidePanel>
  );
};

const requiredStockFields = ['sku', 'name', 'unit', 'warehouseId', 'minimum', 'maximum'] as const;

/** A new stock item as typed; no supplier picked is `""`. Uložit sends it through the form save, so Enter sends nothing. */
const itemCreateForm = FormReact.make(
  FormBuilder.empty
    .addField('category', Schema.String)
    .addField('leadTimeDays', Schema.String)
    .addField('maximum', Schema.String)
    .addField('minimum', Schema.String)
    .addField('name', Schema.String)
    .addField('note', Schema.String)
    .addField('price', Schema.String)
    .addField('sku', Schema.String)
    .addField('supplierId', Schema.String)
    .addField('tracking', Schema.String)
    .addField('unit', Schema.String)
    .addField('warehouseId', Schema.String),
  {
    fields: {
      category: ChoiceField,
      leadTimeDays: TextField,
      maximum: TextField,
      minimum: TextField,
      name: TextField,
      note: TextAreaField,
      price: TextField,
      sku: TextField,
      supplierId: ChoiceField,
      tracking: ChoiceField,
      unit: TextField,
      warehouseId: ChoiceField,
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);
type ItemCreateValues = typeof itemCreateForm.schema.Encoded;

interface SubmitStockItemCreationInput {
  readonly k: ReturnType<typeof usePurchasingT>;
  readonly onCreated: (id: string) => void;
  readonly run: RunCommand;
  readonly setError: (value: string | undefined) => void;
  readonly state: PurchasingState;
  readonly t: ReturnType<typeof useModernI18n>['t'];
  readonly toast: ReturnType<typeof useToast>;
  readonly value: (name: keyof ItemCreateValues) => string;
}

const submitStockItemCreation = Effect.fn('FacilityOperations.Purchasing.submitStockItemCreation')(
  function* createStockItem(input: SubmitStockItemCreationInput) {
    const { k, onCreated, run, setError, state, t, toast, value } = input;
    setError(undefined);
    const minimum = Number(value('minimum'));
    const maximum = Number(value('maximum'));
    const lead = Number(value('leadTimeDays'));
    if (
      requiredStockFields.some((field) => value(field) === '') ||
      ![minimum, maximum, lead].every((entry) => Number.isInteger(entry) && entry >= 0)
    ) {
      setError(t(requiredLabelKey));
      return 'failed' as const;
    }
    if (maximum > 0 && maximum < minimum) {
      setError(k('items.maxBelowMin'));
      return 'failed' as const;
    }
    const category = value('category');
    const tracking = value('tracking');
    const warehouse = state.warehouses.find((entry) => entry.id === value('warehouseId'));
    const supplierId = value('supplierId');
    const supplier = state.suppliers.find((entry) => entry.id === supplierId);
    const supplierSelected = supplierId !== '' && supplierId !== 'none';
    if (
      !Schema.is(StockItemCategorySchema)(category) ||
      !Schema.is(StockTrackingSchema)(tracking) ||
      warehouse === undefined
    ) {
      setError(t(requiredLabelKey));
      return 'failed' as const;
    }
    if (supplierSelected && supplier === undefined) {
      setError(t(requiredLabelKey));
      return 'failed' as const;
    }
    const outcome = yield* run({
      _tag: 'StockItemCreate',
      category,
      leadTimeDays: lead,
      maximum,
      minimum,
      name: value('name'),
      sku: value('sku'),
      tracking,
      unit: value('unit'),
      warehouseId: warehouse.id,
      ...optionalField('supplierId', supplierSelected ? supplier?.id : undefined),
      ...optionalField('note', value('note') === '' ? undefined : value('note')),
      ...optionalField('lastPriceMinor', parseAmountMinor(value('price'))),
    });
    if (!outcome.ok) {
      setError(t(failureKey(outcome.reason)));
      return refusedOutcome(outcome);
    }
    return submitDone(() => {
      toast.create({ duration: 5000, title: k('items.created'), type: 'success' });
      onCreated(outcome.result.entityIds[0] ?? '');
    });
  },
);

export const ItemCreatePanel = ({
  onClose,
  onCreated,
  run,
  state,
}: {
  readonly onClose: () => void;
  readonly onCreated: (id: string) => void;
  readonly run: RunCommand;
  readonly state: PurchasingState;
}) => {
  const k = usePurchasingT();
  const { language, t } = useModernI18n();
  const toast = useToast();
  const opened: ItemCreateValues = {
    category: 'consumable',
    leadTimeDays: '7',
    maximum: '',
    minimum: '',
    name: '',
    note: '',
    price: '',
    sku: '',
    supplierId: '',
    tracking: 'none',
    unit: 'ks',
    warehouseId: state.warehouses[0]?.id ?? '',
  };
  const shown = useFormValues(itemCreateForm, opened);
  const { values } = shown;
  const [error, setError] = useState<string | undefined>();
  const value = (name: keyof ItemCreateValues) => values[name].trim();
  const requiredLabel = requiredLabelFor(language);
  // The item is created on Uložit only; the defaults it opens with are not typed input.
  const form = useFormSave({
    submit: () => submitStockItemCreation({ k, onCreated, run, setError, state, t, toast, value }),
    value: values,
  });
  return (
    <SidePanel
      actions={<FormSaveFooter cancelLabel={t(cancelLabelKey)} error={error} form={form} onCancel={onClose} />}
      guard={form.guard}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      resizeLabel={t(closeLabelKey)}
      size="md"
      title={k('items.createTitle')}
    >
      <FormRoot
        className="flex flex-col gap-200 py-200"
        defaultValues={opened}
        form={itemCreateForm}
        translateMessage={(message) => t(message)}
      >
        {shown.ready}
        {error !== undefined && (
          <StatusText showIcon status="error">
            {error}
          </StatusText>
        )}
        <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
          <itemCreateForm.sku
            id="item-sku"
            label={k('fields.sku')}
            maxLength={200}
            required
            requiredLabel={requiredLabel}
          />
          <itemCreateForm.unit
            id="item-unit"
            label={k('fields.unit')}
            maxLength={200}
            required
            requiredLabel={requiredLabel}
          />
        </div>
        <itemCreateForm.name
          id="item-name"
          label={k('fields.name')}
          maxLength={200}
          required
          requiredLabel={requiredLabel}
        />
        <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
          <itemCreateForm.category
            items={StockItemCategorySchema.literals.map((entry) => ({ label: k(`category.${entry}`), value: entry }))}
            label={k('fields.category')}
            placeholder={k(optionPlaceholderKey)}
          />
          <itemCreateForm.tracking
            items={StockTrackingSchema.literals.map((entry) => ({ label: k(`tracking.${entry}`), value: entry }))}
            label={k('fields.tracking')}
            placeholder={k(optionPlaceholderKey)}
          />
          <itemCreateForm.warehouseId
            items={state.warehouses.map((entry) => ({ label: entry.name, value: entry.id }))}
            label={k('fields.warehouse')}
            placeholder={k(optionPlaceholderKey)}
          />
          <itemCreateForm.supplierId
            items={[
              { label: t('facility-operations.common.notProvided'), value: 'none' },
              ...state.suppliers.map((entry) => ({ label: entry.name, value: entry.id })),
            ]}
            label={k('fields.supplier')}
            placeholder={k(optionPlaceholderKey)}
          />
          <itemCreateForm.minimum
            id="item-minimum"
            inputMode="numeric"
            label={k('fields.minimum')}
            maxLength={200}
            required
            requiredLabel={requiredLabel}
          />
          <itemCreateForm.maximum
            id="item-maximum"
            inputMode="numeric"
            label={k('fields.maximum')}
            maxLength={200}
            required
            requiredLabel={requiredLabel}
          />
          <itemCreateForm.leadTimeDays
            id="item-leadTimeDays"
            inputMode="numeric"
            label={k('fields.leadTimeDays')}
            maxLength={200}
          />
          <itemCreateForm.price id="item-price" inputMode="numeric" label={k('fields.lastPriceCzk')} maxLength={200} />
        </div>
        <itemCreateForm.note id="item-note" label={t(noteLabelKey)} rows={2} />
      </FormRoot>
    </SidePanel>
  );
};
