// @effect-diagnostics asyncFunction:off
// S06 forms: new supplier quote, new purchase order (direct or from replenishment), supplier. ops-purchasing lane.
import { SidePanel } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { useState } from 'react';
import type { PurchasingState, StockItem } from '../../../../../../shared/domain/purchasing.ts';
import {
  failureKey,
  formatAmount,
  parseAmountMinor,
  parsePositiveInt,
  todayIso,
  usePurchasingT,
} from './purchasing-model.ts';
import type { RunCommand } from './purchasing-model.ts';

const FREE = '__free__';

export interface DraftLine {
  readonly key: string;
  readonly itemId: string;
  readonly description: string;
  readonly quantity: string;
  readonly price: string;
}

let lineCounter = 0;
export const draftLine = (item?: StockItem, quantity?: number): DraftLine => {
  lineCounter += 1;
  return {
    description: item?.name ?? '',
    itemId: item?.id ?? FREE,
    key: `line-${lineCounter}`,
    price: item?.lastPriceMinor === undefined ? '' : String(item.lastPriceMinor / 100),
    quantity: quantity === undefined ? '' : String(quantity),
  };
};

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
  const total = lines.reduce(
    (sum, line) => sum + (parsePositiveInt(line.quantity) ?? 0) * (parseAmountMinor(line.price) ?? 0),
    0,
  );
  return (
    <div className="flex flex-col gap-150">
      <span className="font-medium text-sm">{k('fields.lines')}</span>
      {lines.map((line, index) => (
        <div className="flex flex-col gap-100 rounded-md border border-border-primary p-150" key={line.key}>
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
                  ...(item?.lastPriceMinor === undefined ? {} : { price: String(item.lastPriceMinor / 100) }),
                });
              }}
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
        <Button
          icon="icon-[mdi--plus]"
          onClick={() => onChange([...lines, draftLine()])}
          size="sm"
          theme="outlined"
          variant="secondary"
        >
          {k('lines.add')}
        </Button>
        <span className="font-semibold text-sm tabular-nums">{`${k('fields.total')}: ${formatAmount(total)}`}</span>
      </div>
    </div>
  );
};

const linesToCommand = (lines: readonly DraftLine[]) => {
  const result = lines.map((line) => {
    const quantity = parsePositiveInt(line.quantity);
    const unitPriceMinor = parseAmountMinor(line.price);
    const description = line.description.trim();
    if (quantity === undefined || unitPriceMinor === undefined || description === '') {
      return undefined;
    }
    return {
      description,
      quantity,
      unitPriceMinor,
      ...(line.itemId === FREE ? {} : { itemId: line.itemId as StockItem['id'] }),
    };
  });
  return result.every((line) => line !== undefined) ? result.filter((line) => line !== undefined) : undefined;
};

type DocumentKind = 'order' | 'quote';

/** New purchase order (direct) or new received supplier quote. */
export const PurchaseDocumentPanel = ({
  initialLines,
  initialSupplierId,
  kind,
  onClose,
  onCreated,
  run,
  state,
}: {
  readonly kind: DocumentKind;
  readonly initialSupplierId?: string;
  readonly initialLines?: readonly DraftLine[];
  readonly state: PurchasingState;
  readonly run: RunCommand;
  readonly onClose: () => void;
  readonly onCreated: (id: string) => void;
}) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const toast = useToast();
  const [supplierId, setSupplierId] = useState(initialSupplierId ?? state.suppliers[0]?.id ?? '');
  const [warehouseId, setWarehouseId] = useState(
    state.items.find((item) => item.id === initialLines?.[0]?.itemId)?.warehouseId ?? state.warehouses[0]?.id ?? '',
  );
  const [number, setNumber] = useState('');
  const [date, setDate] = useState(todayIso());
  const [secondDate, setSecondDate] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<readonly DraftLine[]>(initialLines ?? [draftLine()]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setError(undefined);
    const commandLines = linesToCommand(lines);
    if (
      supplierId === '' ||
      commandLines === undefined ||
      (kind === 'quote' && (number.trim() === '' || date === ''))
    ) {
      setError(k('lines.invalid'));
      return;
    }
    const optionalNote = note.trim() === '' ? {} : { note: note.trim() };
    setBusy(true);
    const outcome = await run(
      kind === 'order'
        ? {
            _tag: 'PurchaseOrderCreate',
            currency: 'CZK',
            lines: commandLines,
            supplierId: supplierId as StockItem['supplierId'] & string,
            warehouseId: warehouseId as StockItem['warehouseId'],
            ...(secondDate === '' ? {} : { expectedDate: secondDate }),
            ...optionalNote,
          }
        : {
            _tag: 'PurchaseQuoteCreate',
            currency: 'CZK',
            date,
            lines: commandLines,
            number: number.trim(),
            supplierId: supplierId as StockItem['supplierId'] & string,
            ...(secondDate === '' ? {} : { validUntil: secondDate }),
            ...optionalNote,
          },
    );
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
  };
  return (
    <SidePanel
      actions={
        <>
          <Button onClick={onClose} theme="outlined" variant="secondary">
            {t('siampark-ops.common.cancel')}
          </Button>
          <Button
            isLoading={busy}
            loadingText={t('siampark-ops.common.saving')}
            onClick={() => void submit()}
            variant="primary"
          >
            {kind === 'order' ? 'Založit návrh' : k('quotes.createSubmit')}
          </Button>
        </>
      }
      closeOnInteractOutside={false}
      description={k(kind === 'order' ? 'orders.createDescription' : 'quotes.createDescription')}
      onOpenChange={(open) => !open && onClose()}
      open
      resizeLabel={t('siampark-ops.common.close')}
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
          label={t('siampark-ops.common.note')}
          onChange={(event) => setNote(event.target.value)}
          rows={2}
          value={note}
        />
      </div>
    </SidePanel>
  );
};

export const SupplierPanel = ({ onClose, run }: { readonly run: RunCommand; readonly onClose: () => void }) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const toast = useToast();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const value = (name: string) => (values[name] ?? '').trim();
  const field = (name: string, label: string, extra: { type?: string; inputMode?: 'numeric' } = {}) => (
    <FormInput
      id={`supplier-${name}`}
      label={label}
      maxLength={200}
      onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))}
      value={values[name] ?? ''}
      {...extra}
    />
  );
  const submit = async () => {
    setError(undefined);
    const lead = value('leadTimeDays');
    const leadValue = lead === '' ? undefined : Number(lead);
    if (
      value('name') === '' ||
      (value('ico') !== '' && !/^\d{8}$/.test(value('ico'))) ||
      (leadValue !== undefined && !Number.isInteger(leadValue))
    ) {
      setError(k('suppliers.invalid'));
      return;
    }
    setBusy(true);
    const optional = (name: string) => (value(name) === '' ? {} : { [name]: value(name) });
    const outcome = await run({
      _tag: 'PurchaseSupplierCreate',
      name: value('name'),
      ...optional('ico'),
      ...optional('contact'),
      ...optional('email'),
      ...optional('phone'),
      ...optional('note'),
      ...(leadValue === undefined ? {} : { leadTimeDays: leadValue }),
    });
    setBusy(false);
    if (outcome.ok) {
      toast.create({ duration: 5000, title: k('suppliers.created'), type: 'success' });
      onClose();
    } else {
      setError(t(failureKey(outcome.reason)));
    }
  };
  return (
    <SidePanel
      actions={
        <>
          <Button onClick={onClose} theme="outlined" variant="secondary">
            {t('siampark-ops.common.cancel')}
          </Button>
          <Button
            isLoading={busy}
            loadingText={t('siampark-ops.common.saving')}
            onClick={() => void submit()}
            variant="primary"
          >
            {k('suppliers.createSubmit')}
          </Button>
        </>
      }
      closeOnInteractOutside={false}
      onOpenChange={(open) => !open && onClose()}
      open
      resizeLabel={t('siampark-ops.common.close')}
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
        {field('note', t('siampark-ops.common.note'))}
      </div>
    </SidePanel>
  );
};

export const ItemCreatePanel = ({
  onClose,
  onCreated,
  run,
  state,
}: {
  readonly state: PurchasingState;
  readonly run: RunCommand;
  readonly onClose: () => void;
  readonly onCreated: (id: string) => void;
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
  const [error, setError] = useState<string | undefined>(undefined);
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
  const submit = async () => {
    setError(undefined);
    const minimum = Number(value('minimum'));
    const maximum = Number(value('maximum'));
    const lead = Number(value('leadTimeDays'));
    if (
      value('sku') === '' ||
      value('name') === '' ||
      value('unit') === '' ||
      value('warehouseId') === '' ||
      ![minimum, maximum, lead].every((entry) => Number.isInteger(entry) && entry >= 0) ||
      value('minimum') === '' ||
      value('maximum') === ''
    ) {
      setError(t('siampark-ops.common.required'));
      return;
    }
    if (maximum > 0 && maximum < minimum) {
      setError(k('items.maxBelowMin'));
      return;
    }
    setBusy(true);
    const outcome = await run({
      _tag: 'StockItemCreate',
      category: value('category') as StockItem['category'],
      leadTimeDays: lead,
      maximum,
      minimum,
      name: value('name'),
      sku: value('sku'),
      tracking: value('tracking') as StockItem['tracking'],
      unit: value('unit'),
      warehouseId: value('warehouseId') as StockItem['warehouseId'],
      ...(value('supplierId') === '' || value('supplierId') === 'none'
        ? {}
        : { supplierId: value('supplierId') as StockItem['supplierId'] & string }),
      ...(value('note') === '' ? {} : { note: value('note') }),
      ...(parseAmountMinor(value('price')) === undefined
        ? {}
        : { lastPriceMinor: parseAmountMinor(value('price')) ?? 0 }),
    });
    setBusy(false);
    if (outcome.ok) {
      toast.create({ duration: 5000, title: k('items.created'), type: 'success' });
      onCreated(outcome.result.entityIds[0] ?? '');
    } else {
      setError(t(failureKey(outcome.reason)));
    }
  };
  const categories = ['consumable', 'spare_part', 'cleaning', 'chemical', 'tool'];
  return (
    <SidePanel
      actions={
        <>
          <Button onClick={onClose} theme="outlined" variant="secondary">
            {t('siampark-ops.common.cancel')}
          </Button>
          <Button
            isLoading={busy}
            loadingText={t('siampark-ops.common.saving')}
            onClick={() => void submit()}
            variant="primary"
          >
            {k('items.createSubmit')}
          </Button>
        </>
      }
      closeOnInteractOutside={false}
      onOpenChange={(open) => !open && onClose()}
      open
      resizeLabel={t('siampark-ops.common.close')}
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
            categories.map((entry) => ({ label: k(`category.${entry}`), value: entry })),
          )}
          {select(
            'tracking',
            k('fields.tracking'),
            ['none', 'batch', 'serial'].map((entry) => ({ label: k(`tracking.${entry}`), value: entry })),
          )}
          {select(
            'warehouseId',
            k('fields.warehouse'),
            state.warehouses.map((entry) => ({ label: entry.name, value: entry.id })),
          )}
          {select('supplierId', k('fields.supplier'), [
            { label: t('siampark-ops.common.notProvided'), value: 'none' },
            ...state.suppliers.map((entry) => ({ label: entry.name, value: entry.id })),
          ])}
          {text('minimum', k('fields.minimum'), true)}
          {text('maximum', k('fields.maximum'), true)}
          {text('leadTimeDays', k('fields.leadTimeDays'), true)}
          {text('price', k('fields.lastPriceCzk'), true)}
        </div>
        <FormTextarea
          id="item-note"
          label={t('siampark-ops.common.note')}
          onChange={(event) => set('note', event.target.value)}
          rows={2}
          value={values['note'] ?? ''}
        />
      </div>
    </SidePanel>
  );
};
