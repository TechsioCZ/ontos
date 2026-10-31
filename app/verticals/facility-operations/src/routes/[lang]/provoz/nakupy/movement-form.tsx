import { Effect, Match, Schema } from 'effect';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { optionalField } from '../../../../../shared/domain/common.ts';
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
import type { Dispatch, SetStateAction } from 'react';
import { StockMovementKindSchema } from '../../../../../shared/domain/purchasing.ts';
import type { OpsCommand } from '../../../../../shared/agendas.ts';
import type {
  PurchasingState,
  StockItem,
  StockPlannedIssue,
  StockRef,
} from '../../../../../shared/domain/purchasing.ts';
import { batchesInStock, onHandIn, serialsInStock } from '../../../../../shared/domain/purchasing-stock.ts';
import { usePropertyOptions } from '../../../../ui/property-options.ts';
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

const MovementKindSchema = Schema.Literals([...StockMovementKindSchema.literals, 'planned']);
export type MovementKind = typeof MovementKindSchema.Type;

const NONE = 'none';

interface Props {
  readonly item: StockItem;
  readonly kind: MovementKind;
  readonly onDone: () => void;
  /** Issue that fulfils a planned issue (prefilled quantity and refs). */
  readonly planned?: StockPlannedIssue;
  readonly run: RunCommand;
  readonly state: PurchasingState;
}

type SerialSelection = Record<string, true>;
const toggleSerial = (current: Readonly<SerialSelection>, serial: string, checked: boolean) => {
  if (checked) {
    return { ...current, [serial]: true } satisfies SerialSelection;
  }
  const next: SerialSelection = {};
  for (const [key, value] of Object.entries(current)) {
    if (key !== serial) {
      next[key] = value;
    }
  }
  return next;
};

interface TrackingFieldsProps {
  readonly batch: string;
  readonly batches: ReturnType<typeof batchesInStock>;
  readonly item: StockItem;
  readonly kind: MovementKind;
  readonly outgoing: boolean;
  readonly picked: Readonly<SerialSelection>;
  readonly quantity: string;
  readonly serials: readonly string[];
  readonly serialText: string;
  readonly setBatch: (value: string) => void;
  readonly setPicked: Dispatch<SetStateAction<SerialSelection>>;
  readonly setSerialText: (value: string) => void;
}
const MovementTrackingFields = ({
  batch,
  batches,
  item,
  kind,
  outgoing,
  picked,
  quantity,
  serials,
  serialText,
  setBatch,
  setPicked,
  setSerialText,
}: TrackingFieldsProps) => {
  const k = usePurchasingT();
  return (
    <>
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
                    onCheckedChange={(checked) => setPicked((current) => toggleSerial(current, serial, checked))}
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
    </>
  );
};

interface MovementDraft {
  readonly batch: string;
  readonly date: string;
  readonly kind: MovementKind;
  readonly picked: Readonly<SerialSelection>;
  readonly quantity: string;
  readonly reason: string;
  readonly serialText: string;
  readonly targetId: StockItem['warehouseId'];
  readonly warehouseId: StockItem['warehouseId'];
}
interface MovementSubmission {
  readonly available: number;
  readonly draft: MovementDraft;
  readonly feedback: {
    readonly onDone: () => void;
    readonly onSuccess: () => void;
    readonly setBusy: (busy: boolean) => void;
    readonly setError: (message: string | undefined) => void;
  };
  readonly item: StockItem;
  readonly labels: { readonly k: ReturnType<typeof usePurchasingT>; readonly t: ReturnType<typeof useModernI18n>['t'] };
  readonly plannedId?: StockPlannedIssue['id'];
  readonly refs: () => StockRef[];
  readonly run: RunCommand;
}
class MovementInputError extends Schema.TaggedError<MovementInputError>()('MovementInputError', {
  message: Schema.String,
}) {}
const readMovementTracking = (
  input: MovementSubmission,
  removing: boolean,
  units: number,
): Effect.Effect<
  Pick<Extract<OpsCommand, { readonly _tag: 'StockReceipt' }>, 'batch' | 'serialNumbers'>,
  MovementInputError
> => {
  const {
    draft: { batch, kind, picked, serialText },
    item,
    labels: { k },
  } = input;
  const invalid = (message: string) => Effect.fail(new MovementInputError({ message }));
  const serialList = removing ? Object.keys(picked) : parseSerials(serialText);
  if (kind !== 'planned' && item.tracking === 'serial' && serialList.length !== units) {
    return invalid(k('movement.serialCount', { count: units }));
  }
  const batchValue = batch.trim();
  if (kind !== 'planned' && item.tracking === 'batch' && batchValue === '') {
    return invalid(k('movement.batchRequired'));
  }
  return Effect.succeed({
    ...optionalField('batch', batchValue === '' ? undefined : batchValue),
    ...optionalField('serialNumbers', item.tracking === 'serial' && serialList.length > 0 ? serialList : undefined),
  });
};
interface ValidatedMovement {
  readonly amount: number;
  readonly tracking: Effect.Success<ReturnType<typeof readMovementTracking>>;
  readonly trimmedReason: string;
  readonly units: number;
}
const validateMovement = (input: MovementSubmission): Effect.Effect<ValidatedMovement, MovementInputError> => {
  const {
    available,
    draft,
    item,
    labels: { k, t },
  } = input;
  const { date, kind, quantity, reason, targetId, warehouseId } = draft;
  const amount = kind === 'adjustment' ? parseInteger(quantity) : parsePositiveInt(quantity);
  const trimmedReason = reason.trim();
  const invalid = (message: string) => Effect.fail(new MovementInputError({ message }));
  if (amount === undefined || amount === 0 || trimmedReason === '' || date === '') {
    return invalid(t('facility-operations.common.required'));
  }
  const removing = kind === 'issue' || kind === 'transfer' || (kind === 'adjustment' && amount < 0);
  const units = Math.abs(amount);
  if (removing && units > available) {
    return invalid(k('movement.insufficient', { available: formatQuantity(available, item.unit) }));
  }
  if (kind === 'transfer' && targetId === warehouseId) {
    return invalid(k('movement.sameWarehouse'));
  }
  return readMovementTracking(input, removing, units).pipe(
    Effect.map((tracking) => ({ amount, tracking, trimmedReason, units })),
  );
};
const makeMovementCommand = (
  input: MovementSubmission,
  values: Effect.Success<ReturnType<typeof validateMovement>>,
): OpsCommand => {
  const {
    draft: { date, kind, targetId, warehouseId },
    item,
    refs,
  } = input;
  const { amount, tracking, trimmedReason: reason, units } = values;
  return Match.value(kind).pipe(
    Match.when('receipt', (): OpsCommand => ({
      _tag: 'StockReceipt',
      date,
      itemId: item.id,
      quantity: units,
      reason,
      refs: refs(),
      warehouseId,
      ...tracking,
    })),
    Match.when('issue', (): OpsCommand => ({
      _tag: 'StockIssue',
      date,
      itemId: item.id,
      quantity: units,
      reason,
      refs: refs(),
      warehouseId,
      ...tracking,
      ...optionalField('plannedIssueId', input.plannedId),
    })),
    Match.when('transfer', (): OpsCommand => ({
      _tag: 'StockTransfer',
      date,
      fromWarehouseId: warehouseId,
      itemId: item.id,
      quantity: units,
      reason,
      toWarehouseId: targetId,
      ...tracking,
    })),
    Match.when('adjustment', (): OpsCommand => ({
      _tag: 'StockAdjustment',
      date,
      delta: amount,
      itemId: item.id,
      reason,
      warehouseId,
      ...tracking,
    })),
    Match.when('planned', (): OpsCommand => ({
      _tag: 'StockPlannedIssueCreate',
      date,
      itemId: item.id,
      quantity: units,
      reason,
      refs: refs(),
    })),
    Match.exhaustive,
  );
};
const submitMovementCommand = Effect.fn('FacilityOperations.Purchasing.submitMovement')(function* submitStockMovement(
  input: MovementSubmission,
) {
  input.feedback.setError(undefined);
  const values = yield* validateMovement(input);
  const command = makeMovementCommand(input, values);
  input.feedback.setBusy(true);
  const outcome = yield* input.run(command);
  input.feedback.setBusy(false);
  if (outcome.ok) {
    input.feedback.onSuccess();
    input.feedback.onDone();
  } else {
    input.feedback.setError(input.labels.t(failureKey(outcome.reason)));
  }
});
const submitMovement = (input: MovementSubmission) =>
  submitMovementCommand(input).pipe(
    Effect.catchTag('MovementInputError', ({ message }) => Effect.sync(() => input.feedback.setError(message))),
  );

interface MovementReferenceFieldsProps {
  readonly kind: MovementKind;
  readonly place: string;
  readonly properties: ReturnType<typeof usePropertyOptions>;
  readonly setPlace: (value: string) => void;
  readonly setTask: (value: string) => void;
  readonly task: string;
  readonly tasks: ReturnType<typeof useTaskOptions>;
}
const MovementReferenceFields = ({
  kind,
  place,
  properties,
  setPlace,
  setTask,
  task,
  tasks,
}: MovementReferenceFieldsProps) => {
  const k = usePurchasingT();
  return (
    (kind === 'issue' || kind === 'receipt' || kind === 'planned') && (
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
        <Select
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
          placeholder={k('placeholders.option')}
          size="md"
          value={[task]}
        />
        <Select
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
          placeholder={k('placeholders.option')}
          size="md"
          value={[place]}
        />
      </div>
    )
  );
};

const MovementEditor = ({ item, kind, onDone, planned, run, state }: Props) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const toast = useToast();
  const properties = usePropertyOptions();
  const tasks = useTaskOptions();
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<StockItem['warehouseId']>();
  const warehouseId = selectedWarehouseId ?? item.warehouseId;
  const [targetId, setTargetId] = useState<StockItem['warehouseId']>(
    () => state.warehouses.find((entry) => entry.id !== item.warehouseId)?.id ?? item.warehouseId,
  );
  const [quantity, setQuantity] = useState(planned === undefined ? '' : String(planned.quantity));
  const [date, setDate] = useState(kind === 'planned' ? '' : todayIso());
  const [reason, setReason] = useState(planned?.reason ?? '');
  const [batch, setBatch] = useState('');
  const [serialText, setSerialText] = useState('');
  const [picked, setPicked] = useState<SerialSelection>({});
  const [task, setTask] = useState(NONE);
  const [place, setPlace] = useState(NONE);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const outgoing = kind === 'issue' || kind === 'transfer';
  const sourceWarehouse = warehouseId;
  const available = onHandIn(state, item.id, sourceWarehouse);
  const serials = [...serialsInStock(state, item.id).entries()].flatMap(([serial, where]) =>
    where === sourceWarehouse ? [serial] : [],
  );
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

  const submit = () =>
    submitMovement({
      available,
      draft: { batch, date, kind, picked, quantity, reason, serialText, targetId, warehouseId },
      feedback: {
        onDone,
        onSuccess: () => {
          toast.create({ duration: 5000, title: k(`movement.done.${kind}`), type: 'success' });
        },
        setBusy,
        setError,
      },
      item,
      labels: { k, t },
      ...optionalField('plannedId', planned?.id),
      refs,
      run,
    });

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
              items={warehouseItems}
              label={kind === 'transfer' ? k('movement.fromWarehouse') : k('fields.warehouse')}
              name="warehouse"
              onValueChange={({ value }) => {
                const selected = state.warehouses.find((entry) => entry.id === value[0]);
                setSelectedWarehouseId(selected?.id);
                setPicked({});
                setBatch('');
              }}
              placeholder={k('placeholders.warehouse')}
              size="md"
              value={[warehouseId]}
            />
          )}
          {kind === 'transfer' && (
            <Select
              items={warehouseItems}
              label={k('movement.toWarehouse')}
              name="target"
              onValueChange={({ value }) => {
                const selected = state.warehouses.find((entry) => entry.id === value[0]);
                if (selected !== undefined) {
                  setTargetId(selected.id);
                }
              }}
              placeholder={k('placeholders.warehouse')}
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
        <MovementTrackingFields
          batch={batch}
          batches={batches}
          item={item}
          kind={kind}
          outgoing={outgoing}
          picked={picked}
          quantity={quantity}
          serials={serials}
          serialText={serialText}
          setBatch={setBatch}
          setPicked={setPicked}
          setSerialText={setSerialText}
        />
        <MovementReferenceFields
          kind={kind}
          place={place}
          properties={properties}
          setPlace={setPlace}
          setTask={setTask}
          task={task}
          tasks={tasks}
        />
        <div className="flex flex-wrap justify-end gap-100">
          <Button onClick={onDone} size="sm" theme="outlined" variant="secondary">
            {t('facility-operations.common.cancel')}
          </Button>
          <Button
            isLoading={busy}
            loadingText={t('facility-operations.common.saving')}
            onClick={() => {
              browserRuntime.runFork(submit());
            }}
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

export const MovementForm = (props: Props) => (
  <MovementEditor key={`${props.item.id}:${props.kind}:${props.planned?.id ?? ''}`} {...props} />
);
