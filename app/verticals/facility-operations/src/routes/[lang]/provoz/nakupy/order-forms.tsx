import type { IsoDate } from '../../../../../shared/domain/common.ts';
import { Effect, Option, Result, Schema } from 'effect';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { optionalField } from '../../../../../shared/domain/common.ts';
// S06 forms: new supplier quote, new purchase order (direct or from replenishment), supplier. ops-purchasing lane.
import { SidePanel, surfaceTileClassName } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { useId, useRef, useState } from 'react';
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

const cancelLabelKey = 'facility-operations.common.cancel';
const savingLabelKey = 'facility-operations.common.saving';
const closeLabelKey = 'facility-operations.common.close';
const noteLabelKey = 'facility-operations.common.note';
const requiredLabelKey = 'facility-operations.common.required';

const FREE = '__free__';

export interface DraftLine {
  readonly description: string;
  readonly itemId: string;
  readonly key: string;
  readonly price: string;
  readonly quantity: string;
}

export const draftLine = (key: string, item?: StockItem, quantity?: number): DraftLine => ({
  description: item?.name ?? '',
  itemId: item?.id ?? FREE,
  key,
  price: item?.lastPriceMinor === undefined ? '' : String(item.lastPriceMinor / 100),
  quantity: quantity === undefined ? '' : String(quantity),
});

const LinesEditor = ({
  lines,
  onChange,
  state,
}: {
  readonly lines: readonly DraftLine[];
  readonly onChange: (lines: readonly DraftLine[]) => void;
  readonly state: PurchasingState;
}) => {
  const k = usePurchasingT();
  const update = (key: string, patch: Partial<DraftLine>) =>
    onChange(lines.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  const keyPrefix = useId();
  const lineSequence = useRef(0);
  const addLine = () => {
    lineSequence.current += 1;
    onChange([...lines, draftLine(`${keyPrefix}-${lineSequence.current}`)]);
  };
  const total = lines.reduce(
    (sum, line) => sum + (parsePositiveInt(line.quantity) ?? 0) * (parseAmountMinor(line.price) ?? 0),
    0,
  );
  return (
    <div className="flex flex-col gap-150">
      <span className="font-medium text-sm">{k('fields.lines')}</span>
      {lines.map((line, index) => (
        <div className={`${surfaceTileClassName} flex flex-col gap-100 p-150`} key={line.key}>
          <div className="flex flex-col gap-100">
            <Select
              items={[
                { displayValue: k('lines.free'), label: k('lines.free'), value: FREE },
                ...state.items.map((item) => ({
                  displayValue: `${item.sku} · ${item.name}`,
                  label: `${item.sku} · ${item.name}`,
                  value: item.id,
                })),
              ]}
              label={k('lines.item', { index: index + 1 })}
              name={`line-item-${line.key}`}
              onValueChange={({ value }) => {
                const item = state.items.find((entry) => entry.id === value[0]);
                update(line.key, {
                  description: item?.name ?? line.description,
                  itemId: value[0] ?? FREE,
                  ...optionalField(
                    'price',
                    item?.lastPriceMinor === undefined ? undefined : String(item.lastPriceMinor / 100),
                  ),
                });
              }}
              placeholder={k('placeholders.item')}
              size="sm"
              value={[line.itemId]}
            />
            {line.itemId === FREE && (
              <FormInput
                id={`line-description-${line.key}`}
                label={k('fields.description')}
                maxLength={300}
                onChange={(event) => update(line.key, { description: event.target.value })}
                size="sm"
                value={line.description}
              />
            )}
          </div>
          <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-100">
            <FormInput
              id={`line-quantity-${line.key}`}
              inputMode="numeric"
              label={k('fields.quantity')}
              onChange={(event) => update(line.key, { quantity: event.target.value })}
              size="sm"
              value={line.quantity}
            />
            <FormInput
              id={`line-price-${line.key}`}
              inputMode="decimal"
              label={k('fields.unitPriceCzk')}
              onChange={(event) => update(line.key, { price: event.target.value })}
              size="sm"
              value={line.price}
            />
            <div className="flex items-end">
              <Button
                aria-label={k('lines.remove')}
                disabled={lines.length === 1}
                icon="icon-[mdi--close]"
                onClick={() => onChange(lines.filter((entry) => entry.key !== line.key))}
                size="sm"
                theme="borderless"
                variant="secondary"
              />
            </div>
          </div>
          <span className="text-right text-fg-secondary text-xs tabular-nums">
            {formatAmount((parsePositiveInt(line.quantity) ?? 0) * (parseAmountMinor(line.price) ?? 0))}
          </span>
        </div>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-100">
        <Button icon="icon-[mdi--plus]" onClick={addLine} size="sm" theme="outlined" variant="secondary">
          {k('lines.add')}
        </Button>
        <span className="font-semibold text-sm tabular-nums">{`${k('fields.total')}: ${formatAmount(total)}`}</span>
      </div>
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
    const item = itemsById.get(line.itemId);
    if (quantity === undefined || unitPriceMinor === undefined || description === '') {
      return Option.none();
    }
    if (line.itemId !== FREE && item === undefined) {
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
  readonly setBusy: (value: boolean) => void;
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
      setBusy,
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
      return;
    }
    const optionalNote = optionalField('note', note.trim() === '' ? undefined : note.trim());
    let command: Parameters<RunCommand>[0];
    if (kind === 'order') {
      const warehouse = state.warehouses.find((candidate) => candidate.id === warehouseId);
      if (warehouse === undefined) {
        setError(k('lines.invalid'));
        return;
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
    setBusy(true);
    const outcome = yield* run(command);
    setBusy(false);
    if (outcome.ok) {
      toast.create({
        duration: 5000,
        title: k(kind === 'order' ? 'orders.created' : 'quotes.created'),
        type: 'success',
      });
      onCreated(outcome.result.entityIds[0] ?? '');
    } else {
      setError(t(failureKey(outcome.reason)));
    }
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
  const { t } = useModernI18n();
  const toast = useToast();
  const [supplierId, setSupplierId] = useState(initialSupplierId ?? state.suppliers[0]?.id ?? '');
  const [warehouseId, setWarehouseId] = useState(
    () =>
      state.items.find((item) => item.id === initialLines?.[0]?.itemId)?.warehouseId ?? state.warehouses[0]?.id ?? '',
  );
  const [number, setNumber] = useState('');
  const [date, setDate] = useState(todayIso);
  const [secondDate, setSecondDate] = useState('');
  const [note, setNote] = useState('');
  const initialLineId = useId();
  const [lines, setLines] = useState<readonly DraftLine[]>(() => initialLines ?? [draftLine(initialLineId)]);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const submit = () =>
    submitPurchaseDocument({
      date,
      k,
      kind,
      lines,
      note,
      number,
      onCreated,
      run,
      secondDate,
      setBusy,
      setError,
      state,
      supplierId,
      t,
      toast,
      warehouseId,
    });
  return (
    <SidePanel
      actions={
        <>
          <Button onClick={onClose} theme="outlined" variant="secondary">
            {t(cancelLabelKey)}
          </Button>
          <Button
            isLoading={busy}
            loadingText={t(savingLabelKey)}
            onClick={() => {
              browserRuntime.runFork(submit());
            }}
            variant="primary"
          >
            {kind === 'order' ? 'Založit návrh' : k('quotes.createSubmit')}
          </Button>
        </>
      }
      closeOnInteractOutside={false}
      description={k(kind === 'order' ? 'orders.createDescription' : 'quotes.createDescription')}
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
      <div className="flex flex-col gap-200 py-200">
        {error !== undefined && (
          <StatusText showIcon status="error">
            {error}
          </StatusText>
        )}
        <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
          <Select
            items={state.suppliers.map((entry) => ({ displayValue: entry.name, label: entry.name, value: entry.id }))}
            label={k('fields.supplier')}
            name="supplier"
            onValueChange={({ value }) => setSupplierId(value[0] ?? '')}
            placeholder={k('placeholders.supplier')}
            size="md"
            value={supplierId === '' ? [] : [supplierId]}
          />
          {kind === 'order' ? (
            <Select
              items={state.warehouses.map((entry) => ({
                displayValue: entry.name,
                label: entry.name,
                value: entry.id,
              }))}
              label={k('fields.deliverTo')}
              name="warehouse"
              onValueChange={({ value }) => setWarehouseId(value[0] ?? warehouseId)}
              placeholder={k('placeholders.warehouse')}
              size="md"
              value={[warehouseId]}
            />
          ) : (
            <FormInput
              id="quote-number"
              label={k('fields.quoteNumber')}
              maxLength={64}
              onChange={(event) => setNumber(event.target.value)}
              required
              value={number}
            />
          )}
          {kind === 'quote' && (
            <FormInput
              id="quote-date"
              label={k('fields.quoteDate')}
              onChange={(event) => setDate(event.target.value)}
              required
              type="date"
              value={date}
            />
          )}
          <FormInput
            id="document-second-date"
            label={kind === 'order' ? k('fields.expectedDate') : k('fields.validUntil')}
            onChange={(event) => setSecondDate(event.target.value)}
            type="date"
            value={secondDate}
          />
        </div>
        <LinesEditor lines={lines} onChange={setLines} state={state} />
        <FormTextarea
          id="document-note"
          label={t(noteLabelKey)}
          onChange={(event) => setNote(event.target.value)}
          rows={2}
          value={note}
        />
      </div>
    </SidePanel>
  );
};

interface SubmitSupplierInput {
  readonly k: ReturnType<typeof usePurchasingT>;
  readonly onClose: () => void;
  readonly run: RunCommand;
  readonly setBusy: (value: boolean) => void;
  readonly setError: (value: string | undefined) => void;
  readonly t: ReturnType<typeof useModernI18n>['t'];
  readonly toast: ReturnType<typeof useToast>;
  readonly value: (name: string) => string;
}

const submitSupplier = Effect.fn('FacilityOperations.Purchasing.submitSupplier')(function* submitSupplier(
  input: SubmitSupplierInput,
) {
  const { k, onClose, run, setBusy, setError, t, toast, value } = input;
  setError(undefined);
  const lead = value('leadTimeDays');
  const leadValue = lead === '' ? undefined : Number(lead);
  if (
    value('name') === '' ||
    (value('ico') !== '' && !/^\d{8}$/u.test(value('ico'))) ||
    (leadValue !== undefined && !Number.isInteger(leadValue))
  ) {
    setError(k('suppliers.invalid'));
    return;
  }
  const ico = yield* Effect.result(
    Schema.decodeEffect(Schema.OptionFromUndefinedOr(SupplierIcoSchema))(
      value('ico') === '' ? undefined : value('ico'),
    ),
  );
  if (Result.isFailure(ico)) {
    setError(k('suppliers.invalid'));
    yield* Effect.logWarning('Supplier identifier validation failed', ico.failure);
    return;
  }
  setBusy(true);
  const optional = (name: string) => optionalField(name, value(name) === '' ? undefined : value(name));
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
  setBusy(false);
  if (outcome.ok) {
    toast.create({ duration: 5000, title: k('suppliers.created'), type: 'success' });
    onClose();
  } else {
    setError(t(failureKey(outcome.reason)));
  }
});

export const SupplierPanel = ({ onClose, run }: { readonly onClose: () => void; readonly run: RunCommand }) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const toast = useToast();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const value = (name: string) => (values[name] ?? '').trim();
  const field = (name: string, label: string, extra: { inputMode?: 'numeric'; type?: string } = {}) => (
    <FormInput
      id={`supplier-${name}`}
      label={label}
      maxLength={200}
      onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))}
      value={values[name] ?? ''}
      {...extra}
    />
  );
  const submit = () => submitSupplier({ k, onClose, run, setBusy, setError, t, toast, value });
  return (
    <SidePanel
      actions={
        <>
          <Button onClick={onClose} theme="outlined" variant="secondary">
            {t(cancelLabelKey)}
          </Button>
          <Button
            isLoading={busy}
            loadingText={t(savingLabelKey)}
            onClick={() => {
              browserRuntime.runFork(submit());
            }}
            variant="primary"
          >
            {k('suppliers.createSubmit')}
          </Button>
        </>
      }
      closeOnInteractOutside={false}
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
      <div className="flex flex-col gap-200 py-200">
        {error !== undefined && (
          <StatusText showIcon status="error">
            {error}
          </StatusText>
        )}
        {field('name', k('fields.supplierName'))}
        {field('ico', k('fields.ico'), { inputMode: 'numeric' })}
        {field('contact', k('fields.contact'))}
        {field('email', k('fields.email'), { type: 'email' })}
        {field('phone', k('fields.phone'))}
        {field('leadTimeDays', k('fields.leadTimeDays'), { inputMode: 'numeric' })}
        {field('note', t(noteLabelKey))}
      </div>
    </SidePanel>
  );
};

const requiredStockFields = ['sku', 'name', 'unit', 'warehouseId', 'minimum', 'maximum'] as const;

interface SubmitStockItemCreationInput {
  readonly k: ReturnType<typeof usePurchasingT>;
  readonly onCreated: (id: string) => void;
  readonly run: RunCommand;
  readonly setBusy: (value: boolean) => void;
  readonly setError: (value: string | undefined) => void;
  readonly state: PurchasingState;
  readonly t: ReturnType<typeof useModernI18n>['t'];
  readonly toast: ReturnType<typeof useToast>;
  readonly value: (name: string) => string;
}

const submitStockItemCreation = Effect.fn('FacilityOperations.Purchasing.submitStockItemCreation')(
  function* createStockItem(input: SubmitStockItemCreationInput) {
    const { k, onCreated, run, setBusy, setError, state, t, toast, value } = input;
    setError(undefined);
    const minimum = Number(value('minimum'));
    const maximum = Number(value('maximum'));
    const lead = Number(value('leadTimeDays'));
    if (
      requiredStockFields.some((field) => value(field) === '') ||
      ![minimum, maximum, lead].every((entry) => Number.isInteger(entry) && entry >= 0)
    ) {
      setError(t(requiredLabelKey));
      return;
    }
    if (maximum > 0 && maximum < minimum) {
      setError(k('items.maxBelowMin'));
      return;
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
      return;
    }
    if (supplierSelected && supplier === undefined) {
      setError(t(requiredLabelKey));
      return;
    }
    setBusy(true);
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
    setBusy(false);
    if (outcome.ok) {
      toast.create({ duration: 5000, title: k('items.created'), type: 'success' });
      onCreated(outcome.result.entityIds[0] ?? '');
    } else {
      setError(t(failureKey(outcome.reason)));
    }
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
  const { t } = useModernI18n();
  const toast = useToast();
  const [values, setValues] = useState<Record<string, string>>({
    category: 'consumable',
    leadTimeDays: '7',
    tracking: 'none',
    unit: 'ks',
    warehouseId: state.warehouses[0]?.id ?? '',
  });
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const set = (name: string, next: string) => setValues((current) => ({ ...current, [name]: next }));
  const value = (name: string) => (values[name] ?? '').trim();
  const select = (
    name: string,
    label: string,
    items: readonly { readonly label: string; readonly value: string }[],
  ) => (
    <Select
      items={items.map((entry) => ({ displayValue: entry.label, label: entry.label, value: entry.value }))}
      label={label}
      name={name}
      onValueChange={({ value: picked }) => set(name, picked[0] ?? '')}
      placeholder={k('placeholders.option')}
      size="md"
      value={value(name) === '' ? [] : [value(name)]}
    />
  );
  const text = (name: string, label: string, numeric = false) => (
    <FormInput
      id={`item-${name}`}
      inputMode={numeric ? 'numeric' : undefined}
      label={label}
      maxLength={200}
      onChange={(event) => set(name, event.target.value)}
      required={!numeric || (name !== 'leadTimeDays' && name !== 'price')}
      value={values[name] ?? ''}
    />
  );
  const submit = () => submitStockItemCreation({ k, onCreated, run, setBusy, setError, state, t, toast, value });
  return (
    <SidePanel
      actions={
        <>
          <Button onClick={onClose} theme="outlined" variant="secondary">
            {t(cancelLabelKey)}
          </Button>
          <Button
            isLoading={busy}
            loadingText={t(savingLabelKey)}
            onClick={() => {
              browserRuntime.runFork(submit());
            }}
            variant="primary"
          >
            {k('items.createSubmit')}
          </Button>
        </>
      }
      closeOnInteractOutside={false}
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
      <div className="flex flex-col gap-200 py-200">
        {error !== undefined && (
          <StatusText showIcon status="error">
            {error}
          </StatusText>
        )}
        <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
          {text('sku', k('fields.sku'))}
          {text('unit', k('fields.unit'))}
        </div>
        {text('name', k('fields.name'))}
        <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
          {select(
            'category',
            k('fields.category'),
            StockItemCategorySchema.literals.map((entry) => ({ label: k(`category.${entry}`), value: entry })),
          )}
          {select(
            'tracking',
            k('fields.tracking'),
            StockTrackingSchema.literals.map((entry) => ({ label: k(`tracking.${entry}`), value: entry })),
          )}
          {select(
            'warehouseId',
            k('fields.warehouse'),
            state.warehouses.map((entry) => ({ label: entry.name, value: entry.id })),
          )}
          {select('supplierId', k('fields.supplier'), [
            { label: t('facility-operations.common.notProvided'), value: 'none' },
            ...state.suppliers.map((entry) => ({ label: entry.name, value: entry.id })),
          ])}
          {text('minimum', k('fields.minimum'), true)}
          {text('maximum', k('fields.maximum'), true)}
          {text('leadTimeDays', k('fields.leadTimeDays'), true)}
          {text('price', k('fields.lastPriceCzk'), true)}
        </div>
        <FormTextarea
          id="item-note"
          label={t(noteLabelKey)}
          onChange={(event) => set('note', event.target.value)}
          rows={2}
          value={values['note'] ?? ''}
        />
      </div>
    </SidePanel>
  );
};
