// @effect-diagnostics asyncFunction:off
// Stock movement form (S05): příjem, výdej, přesun, korekce, plánovaný výdej. ops-purchasing lane.
import { SectionCard } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { useState } from 'react';
import type { OpsCommand } from '../../../../../../shared/agendas.ts';
import type {
  PurchasingState,
  StockItem,
  StockPlannedIssue,
  StockRef,
} from '../../../../../../shared/domain/purchasing.ts';
import { batchesInStock, onHandIn, serialsInStock } from '../../../../../../shared/domain/purchasing-stock.ts';
import { usePropertyOptions } from '../../../../../ui/property-options.ts';
import {
  failureKey,
  formatQuantity,
  parseInteger,
  parsePositiveInt,
  parseSerials,
  todayIso,
  usePurchasingT,
  useTaskOptions,
} from './purchasing-model.ts';
import type { RunCommand } from './purchasing-model.ts';

export type MovementKind = 'receipt' | 'issue' | 'transfer' | 'adjustment' | 'planned';

const NONE = 'none';

interface Props {
  readonly item: StockItem;
  readonly kind: MovementKind;
  readonly state: PurchasingState;
  readonly run: RunCommand;
  readonly onDone: () => void;
  /** Issue that fulfils a planned issue (prefilled quantity and refs). */
  readonly planned?: StockPlannedIssue;
}

export const MovementForm = ({ item, kind, onDone, planned, run, state }: Props) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const toast = useToast();
  const properties = usePropertyOptions();
  const tasks = useTaskOptions();
  const [warehouseId, setWarehouseId] = useState<string>(item.warehouseId);
  const [targetId, setTargetId] = useState<string>(
    state.warehouses.find((entry) => entry.id !== item.warehouseId)?.id ?? item.warehouseId,
  );
  const [quantity, setQuantity] = useState(planned === undefined ? '' : String(planned.quantity));
  const [date, setDate] = useState(kind === 'planned' ? '' : todayIso());
  const [reason, setReason] = useState(planned?.reason ?? '');
  const [batch, setBatch] = useState('');
  const [serialText, setSerialText] = useState('');
  const [picked, setPicked] = useState<Record<string, true>>({});
  const [task, setTask] = useState(NONE);
  const [place, setPlace] = useState(NONE);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const outgoing = kind === 'issue' || kind === 'transfer';
  const sourceWarehouse = warehouseId;
  const available = onHandIn(state, item.id, sourceWarehouse as StockItem['warehouseId']);
  const serials = [...serialsInStock(state, item.id).entries()]
    .filter(([, where]) => where === sourceWarehouse)
    .map(([serial]) => serial);
  const batches = batchesInStock(state, item.id).filter((entry) => entry.warehouseId === sourceWarehouse);
  const warehouseItems = state.warehouses.map((entry) => ({
    displayValue: `${entry.code} · ${entry.name}`,
    label: `${entry.code} · ${entry.name}`,
    value: entry.id,
  }));

  const refs = (): StockRef[] => {
    const result: StockRef[] = [];
    const taskRef = tasks.status === 'ready' ? tasks.options.find((option) => option.value === task)?.ref : undefined;
    if (taskRef !== undefined) {
      result.push(taskRef);
    }
    const placeRef =
      properties.status === 'ready' ? properties.options.find((option) => option.value === place)?.ref : undefined;
    if (placeRef !== undefined) {
      result.push({ id: placeRef.id, kind: placeRef.kind, label: placeRef.label });
    }
    return result;
  };

  const submit = async () => {
    setError(undefined);
    const trimmedReason = reason.trim();
    const amount = kind === 'adjustment' ? parseInteger(quantity) : parsePositiveInt(quantity);
    if (amount === undefined || amount === 0 || trimmedReason === '' || date === '') {
      setError(t('siampark-ops.common.required'));
      return;
    }
    const removing = outgoing || (kind === 'adjustment' && amount < 0);
    const units = Math.abs(amount);
    if (removing && units > available) {
      setError(k('movement.insufficient', { available: formatQuantity(available, item.unit) }));
      return;
    }
    const pickedSerials = Object.keys(picked);
    const typedSerials = parseSerials(serialText);
    const serialList = removing ? pickedSerials : typedSerials;
    if (kind !== 'planned' && item.tracking === 'serial' && serialList.length !== units) {
      setError(k('movement.serialCount', { count: units }));
      return;
    }
    const batchValue = batch.trim();
    if (kind !== 'planned' && item.tracking === 'batch' && batchValue === '') {
      setError(k('movement.batchRequired'));
      return;
    }
    const tracking = {
      ...(batchValue === '' ? {} : { batch: batchValue }),
      ...(item.tracking === 'serial' && serialList.length > 0 ? { serialNumbers: serialList } : {}),
    };
    let command: OpsCommand;
    if (kind === 'receipt') {
      command = {
        _tag: 'StockReceipt',
        date,
        itemId: item.id,
        quantity: units,
        reason: trimmedReason,
        refs: refs(),
        warehouseId: warehouseId as StockItem['warehouseId'],
        ...tracking,
      };
    } else if (kind === 'issue') {
      command = {
        _tag: 'StockIssue',
        date,
        itemId: item.id,
        quantity: units,
        reason: trimmedReason,
        refs: refs(),
        warehouseId: warehouseId as StockItem['warehouseId'],
        ...tracking,
        ...(planned === undefined ? {} : { plannedIssueId: planned.id }),
      };
    } else if (kind === 'transfer') {
      if (targetId === warehouseId) {
        setError(k('movement.sameWarehouse'));
        return;
      }
      command = {
        _tag: 'StockTransfer',
        date,
        fromWarehouseId: warehouseId as StockItem['warehouseId'],
        itemId: item.id,
        quantity: units,
        reason: trimmedReason,
        toWarehouseId: targetId as StockItem['warehouseId'],
        ...tracking,
      };
    } else if (kind === 'adjustment') {
      command = {
        _tag: 'StockAdjustment',
        date,
        delta: amount,
        itemId: item.id,
        reason: trimmedReason,
        warehouseId: warehouseId as StockItem['warehouseId'],
        ...tracking,
      };
    } else {
      command = {
        _tag: 'StockPlannedIssueCreate',
        date,
        itemId: item.id,
        quantity: units,
        reason: trimmedReason,
        refs: refs(),
      };
    }
    setBusy(true);
    const outcome = await run(command);
    setBusy(false);
    if (outcome.ok) {
      toast.create({ duration: 5000, title: k(`movement.done.${kind}`), type: 'success' });
      onDone();
    } else {
      setError(t(failureKey(outcome.reason)));
    }
  };

  return (
    <SectionCard title={k(`movement.title.${kind}`)}>
      <div className="flex flex-col gap-200">
        {error !== undefined && (
          <StatusText showIcon status="error">
            {error}
          </StatusText>
        )}
        <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
          {kind !== 'planned' && (
            <Select
              placeholder={k('placeholders.warehouse')}
              items={warehouseItems}
              label={kind === 'transfer' ? k('movement.fromWarehouse') : k('fields.warehouse')}
              name="warehouse"
              onValueChange={({ value }) => {
                setWarehouseId(value[0] ?? item.warehouseId);
                setPicked({});
                setBatch('');
              }}
              size="md"
              value={[warehouseId]}
            />
          )}
          {kind === 'transfer' && (
            <Select
              placeholder={k('placeholders.warehouse')}
              items={warehouseItems}
              label={k('movement.toWarehouse')}
              name="target"
              onValueChange={({ value }) => setTargetId(value[0] ?? targetId)}
              size="md"
              value={[targetId]}
            />
          )}
          <FormInput
            helpText={
              outgoing || kind === 'adjustment'
                ? k('movement.available', { available: formatQuantity(available, item.unit) })
                : undefined
            }
            id="movement-quantity"
            inputMode="numeric"
            label={
              kind === 'adjustment'
                ? k('movement.delta', { unit: item.unit })
                : k('movement.quantity', { unit: item.unit })
            }
            onChange={(event) => setQuantity(event.target.value)}
            required
            value={quantity}
          />
          <FormInput
            id="movement-date"
            label={kind === 'planned' ? k('movement.plannedDate') : k('fields.date')}
            onChange={(event) => setDate(event.target.value)}
            required
            type="date"
            value={date}
          />
        </div>
        <FormInput
          helpText={kind === 'adjustment' ? k('movement.reasonRequired') : undefined}
          id="movement-reason"
          label={k('fields.reason')}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
          required
          value={reason}
        />
        {kind !== 'planned' &&
          item.tracking === 'batch' &&
          (outgoing || (kind === 'adjustment' && quantity.trim().startsWith('-')) ? (
            <Select
              items={batches.map((entry) => ({
                displayValue: `${entry.batch} (${formatQuantity(entry.quantity, item.unit)})`,
                label: `${entry.batch} (${formatQuantity(entry.quantity, item.unit)})`,
                value: entry.batch,
              }))}
              label={k('fields.batch')}
              name="batch"
              onValueChange={({ value }) => setBatch(value[0] ?? '')}
              placeholder={k('movement.pickBatch')}
              size="md"
              value={batch === '' ? [] : [batch]}
            />
          ) : (
            <FormInput
              id="movement-batch"
              label={k('fields.batch')}
              maxLength={100}
              onChange={(event) => setBatch(event.target.value)}
              required
              value={batch}
            />
          ))}
        {kind !== 'planned' &&
          item.tracking === 'serial' &&
          (outgoing || (kind === 'adjustment' && quantity.trim().startsWith('-')) ? (
            <fieldset className="flex flex-col gap-100">
              <legend className="mb-100 text-fg-secondary text-sm">{k('movement.pickSerials')}</legend>
              {serials.length === 0 ? (
                <p className="text-fg-secondary text-sm">{k('movement.noSerials')}</p>
              ) : (
                <div className="flex flex-wrap gap-150">
                  {serials.map((serial) => (
                    <FormCheckbox
                      checked={picked[serial] === true}
                      key={serial}
                      label={serial}
                      onCheckedChange={(checked) =>
                        setPicked((current) => {
                          const next = { ...current };
                          if (checked === true) {
                            next[serial] = true;
                          } else {
                            delete next[serial];
                          }
                          return next;
                        })
                      }
                    />
                  ))}
                </div>
              )}
            </fieldset>
          ) : (
            <FormTextarea
              helpText={k('movement.serialHelp')}
              id="movement-serials"
              label={k('fields.serialNumbers')}
              onChange={(event) => setSerialText(event.target.value)}
              rows={3}
              value={serialText}
            />
          ))}
        {(kind === 'issue' || kind === 'receipt' || kind === 'planned') && (
          <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
            <Select
              placeholder={k('placeholders.option')}
              items={[
                { displayValue: k('refs.noTask'), label: k('refs.noTask'), value: NONE },
                ...(tasks.status === 'ready'
                  ? tasks.options.map((option) => ({
                      displayValue: option.ref.label,
                      label: option.ref.label,
                      value: option.value,
                    }))
                  : []),
              ]}
              label={k('refs.task')}
              name="task"
              onValueChange={({ value }) => setTask(value[0] ?? NONE)}
              size="md"
              value={[task]}
            />
            <Select
              placeholder={k('placeholders.option')}
              items={[
                { displayValue: k('refs.noPlace'), label: k('refs.noPlace'), value: NONE },
                ...(properties.status === 'ready'
                  ? properties.options.map((option) => ({
                      displayValue: option.ref.label,
                      label: option.ref.label,
                      value: option.value,
                    }))
                  : []),
              ]}
              label={k('refs.place')}
              name="place"
              onValueChange={({ value }) => setPlace(value[0] ?? NONE)}
              size="md"
              value={[place]}
            />
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-100">
          <Button onClick={onDone} size="sm" theme="outlined" variant="secondary">
            {t('siampark-ops.common.cancel')}
          </Button>
          <Button
            isLoading={busy}
            loadingText={t('siampark-ops.common.saving')}
            onClick={() => void submit()}
            size="sm"
            variant="primary"
          >
            {k(`movement.submit.${kind}`)}
          </Button>
        </div>
      </div>
    </SectionCard>
  );
};
