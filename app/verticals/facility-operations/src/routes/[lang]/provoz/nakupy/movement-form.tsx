import { Effect, Match, Option, Schema } from 'effect';
import { Atom } from 'effect/reactivity';
import { optionalField } from '../../../../../shared/domain/common.ts';
// Stock movement form (S05): příjem, výdej, přesun, korekce, plánovaný výdej. ops-purchasing lane.
import { SectionCard, requiredLabelFor } from '@app/admin-ui';
import {
  ChoiceField,
  FormBuilder,
  FormReact,
  FormRoot,
  MemberCheckboxField,
  TextAreaField,
  TextField,
  useAtomSet,
  useAtomSubscribe,
} from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { useState } from 'react';
import { browserAtomRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { StockMovementKindSchema } from '../../../../../shared/domain/purchasing.ts';
import type { OpsCommand } from '../../../../../shared/agendas.ts';
import type {
  PurchasingState,
  StockItem,
  StockPlannedIssue,
  StockRef,
} from '../../../../../shared/domain/purchasing.ts';
import { batchesInStock, onHandIn, serialsInStock } from '../../../../../shared/domain/purchasing-stock.ts';
import { useFormValues } from '../../../../ui/form-values.tsx';
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
import { FormSaveFooter, refusedOutcome, submitDone, useFormSave } from '../../../../ui/form-save.tsx';
import type { FormSubmitResult } from '../../../../ui/form-save.tsx';

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

/**
 * The values of one movement. Uložit sends them through the form save, so the form only holds them and Enter sends
 * nothing. A batch is typed for stock coming in (`batch`) and picked from the batches in stock for stock going out
 * (`batchPick`); `picked` holds the serial numbers chosen to go out. One item panel shows one movement at a time.
 */
const movementForm = FormReact.make(
  FormBuilder.empty
    .addField('batch', Schema.String)
    .addField('batchPick', Schema.String)
    .addField('date', Schema.String)
    .addField('picked', Schema.Array(Schema.String))
    .addField('place', Schema.String)
    .addField('quantity', Schema.String)
    .addField('reason', Schema.String)
    .addField('serialText', Schema.String)
    .addField('targetId', Schema.String)
    .addField('task', Schema.String)
    .addField('warehouseId', Schema.String),
  {
    fields: {
      batch: TextField,
      batchPick: ChoiceField,
      date: TextField,
      picked: MemberCheckboxField,
      place: ChoiceField,
      quantity: TextField,
      reason: TextField,
      serialText: TextAreaField,
      targetId: ChoiceField,
      task: ChoiceField,
      warehouseId: ChoiceField,
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);
type MovementValues = typeof movementForm.schema.Encoded;

/** The source warehouse as a plain string, which changes only when the pick does. */
const pickedWarehouse = movementForm
  .getFieldAtoms(movementForm.fields.warehouseId)
  .value.pipe(Atom.map(Option.getOrElse(() => '')));

/** Stock leaves the warehouse: its batch and serial numbers are picked from what is there. */
const picksFromStock = (kind: MovementKind, quantity: string) =>
  kind === 'issue' || kind === 'transfer' || (kind === 'adjustment' && quantity.trim().startsWith('-'));

interface TrackingFieldsProps {
  readonly batches: ReturnType<typeof batchesInStock>;
  readonly item: StockItem;
  readonly kind: MovementKind;
  readonly picking: boolean;
  readonly serials: readonly string[];
}
const MovementTrackingFields = ({ batches, item, kind, picking, serials }: TrackingFieldsProps) => {
  const k = usePurchasingT();
  const { language } = useModernI18n();
  return (
    <>
      {kind !== 'planned' &&
        item.tracking === 'batch' &&
        (picking ? (
          <movementForm.batchPick
            items={batches.map((entry) => ({
              label: `${entry.batch} (${formatQuantity(entry.quantity, item.unit)})`,
              value: entry.batch,
            }))}
            label={k('fields.batch')}
            placeholder={k('movement.pickBatch')}
          />
        ) : (
          <movementForm.batch
            id="movement-batch"
            label={k('fields.batch')}
            maxLength={100}
            required
            requiredLabel={requiredLabelFor(language)}
          />
        ))}
      {kind !== 'planned' &&
        item.tracking === 'serial' &&
        (picking ? (
          <fieldset className="flex flex-col gap-100">
            <legend className="mb-100 text-fg-secondary text-sm">{k('movement.pickSerials')}</legend>
            {serials.length === 0 ? (
              <p className="text-fg-secondary text-sm">{k('movement.noSerials')}</p>
            ) : (
              <div className="flex flex-wrap gap-150">
                {serials.map((serial) => (
                  <movementForm.picked key={serial} label={serial} member={serial} />
                ))}
              </div>
            )}
          </fieldset>
        ) : (
          <movementForm.serialText
            helpText={k('movement.serialHelp')}
            id="movement-serials"
            label={k('fields.serialNumbers')}
            rows={3}
          />
        ))}
    </>
  );
};

interface MovementDraft {
  readonly batch: string;
  readonly date: string;
  readonly kind: MovementKind;
  readonly picked: readonly string[];
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
  const serialList = removing ? [...picked] : parseSerials(serialText);
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
  const outcome = yield* input.run(command);
  if (!outcome.ok) {
    input.feedback.setError(input.labels.t(failureKey(outcome.reason)));
    return refusedOutcome(outcome);
  }
  return submitDone(() => {
    input.feedback.onSuccess();
    input.feedback.onDone();
  });
});
const submitMovement = (input: MovementSubmission) =>
  submitMovementCommand(input).pipe(
    Effect.catchTag('MovementInputError', ({ message }) =>
      Effect.sync((): FormSubmitResult => {
        input.feedback.setError(message);
        return 'failed';
      }),
    ),
  );

interface MovementReferenceFieldsProps {
  readonly kind: MovementKind;
  readonly properties: ReturnType<typeof usePropertyOptions>;
  readonly tasks: ReturnType<typeof useTaskOptions>;
}
const MovementReferenceFields = ({ kind, properties, tasks }: MovementReferenceFieldsProps) => {
  const k = usePurchasingT();
  return (
    (kind === 'issue' || kind === 'receipt' || kind === 'planned') && (
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
        <movementForm.task
          items={[
            { label: k('refs.noTask'), value: NONE },
            ...(tasks.status === 'ready'
              ? tasks.options.map((option) => ({ label: option.ref.label, value: option.value }))
              : []),
          ]}
          label={k('refs.task')}
          placeholder={k('placeholders.option')}
        />
        <movementForm.place
          items={[
            { label: k('refs.noPlace'), value: NONE },
            ...(properties.status === 'ready'
              ? properties.options.map((option) => ({ label: option.ref.label, value: option.value }))
              : []),
          ]}
          label={k('refs.place')}
          placeholder={k('placeholders.option')}
        />
      </div>
    )
  );
};

const MovementEditor = ({ item, kind, onDone, planned, run, state }: Props) => {
  const k = usePurchasingT();
  const { language, t } = useModernI18n();
  const toast = useToast();
  const properties = usePropertyOptions();
  const tasks = useTaskOptions();
  const defaultTarget = state.warehouses.find((entry) => entry.id !== item.warehouseId)?.id ?? item.warehouseId;
  const opened: MovementValues = {
    batch: '',
    batchPick: '',
    date: kind === 'planned' ? '' : todayIso(),
    picked: [],
    place: NONE,
    quantity: planned === undefined ? '' : String(planned.quantity),
    reason: planned?.reason ?? '',
    serialText: '',
    targetId: defaultTarget,
    task: NONE,
    warehouseId: item.warehouseId,
  };
  const shown = useFormValues(movementForm, opened);
  const { values } = shown;
  const [error, setError] = useState<string | undefined>();
  // Another source warehouse has other batches and serial numbers: the picks of the previous one are dropped.
  const setPicked = useAtomSet(movementForm.getFieldAtoms(movementForm.fields.picked).setValue);
  const setBatch = useAtomSet(movementForm.getFieldAtoms(movementForm.fields.batch).setValue);
  const setBatchPick = useAtomSet(movementForm.getFieldAtoms(movementForm.fields.batchPick).setValue);
  useAtomSubscribe(
    pickedWarehouse,
    () => {
      if (shown.initialized) {
        setPicked([]);
        setBatch('');
        setBatchPick('');
      }
    },
    { immediate: false },
  );

  const warehouseOf = (id: string) => state.warehouses.find((entry) => entry.id === id)?.id;
  const warehouseId = warehouseOf(values.warehouseId) ?? item.warehouseId;
  const targetId = warehouseOf(values.targetId) ?? defaultTarget;
  const outgoing = kind === 'issue' || kind === 'transfer';
  const picking = picksFromStock(kind, values.quantity);
  const available = onHandIn(state, item.id, warehouseId);
  const serials = [...serialsInStock(state, item.id).entries()].flatMap(([serial, where]) =>
    where === warehouseId ? [serial] : [],
  );
  const batches = batchesInStock(state, item.id).filter((entry) => entry.warehouseId === warehouseId);
  const warehouseItems = state.warehouses.map((entry) => ({ label: `${entry.code} · ${entry.name}`, value: entry.id }));

  const refs = (): StockRef[] => {
    const result: StockRef[] = [];
    const taskRef =
      tasks.status === 'ready' ? tasks.options.find((option) => option.value === values.task)?.ref : undefined;
    if (taskRef !== undefined) {
      result.push(taskRef);
    }
    const placeRef =
      properties.status === 'ready'
        ? properties.options.find((option) => option.value === values.place)?.ref
        : undefined;
    if (placeRef !== undefined) {
      result.push({ id: placeRef.id, kind: placeRef.kind, label: placeRef.label });
    }
    return result;
  };

  const draft: MovementDraft = {
    batch: picking ? values.batchPick : values.batch,
    date: values.date,
    kind,
    picked: values.picked,
    quantity: values.quantity,
    reason: values.reason,
    serialText: values.serialText,
    targetId,
    warehouseId,
  };
  // The movement is recorded on Uložit only; one issued from a plan opens filled in and can be sent as it is.
  const form = useFormSave({
    savableAtOnce: planned !== undefined,
    submit: () =>
      submitMovement({
        available,
        draft,
        feedback: {
          onDone,
          onSuccess: () => {
            toast.create({ duration: 5000, title: k(`movement.done.${kind}`), type: 'success' });
          },
          setError,
        },
        item,
        labels: { k, t },
        ...optionalField('plannedId', planned?.id),
        refs,
        run,
      }),
    value: values,
  });
  const requiredLabel = requiredLabelFor(language);

  return (
    <SectionCard title={k(`movement.title.${kind}`)}>
      <FormRoot
        className="flex flex-col gap-200"
        defaultValues={opened}
        form={movementForm}
        translateMessage={(message) => t(message)}
      >
        {shown.ready}
        {error !== undefined && (
          <StatusText showIcon status="error">
            {error}
          </StatusText>
        )}
        <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
          {kind !== 'planned' && (
            <movementForm.warehouseId
              items={warehouseItems}
              label={kind === 'transfer' ? k('movement.fromWarehouse') : k('fields.warehouse')}
              placeholder={k('placeholders.warehouse')}
            />
          )}
          {kind === 'transfer' && (
            <movementForm.targetId
              items={warehouseItems}
              label={k('movement.toWarehouse')}
              placeholder={k('placeholders.warehouse')}
            />
          )}
          <movementForm.quantity
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
            required
            requiredLabel={requiredLabel}
          />
          <movementForm.date
            id="movement-date"
            label={kind === 'planned' ? k('movement.plannedDate') : k('fields.date')}
            required
            requiredLabel={requiredLabel}
            type="date"
          />
        </div>
        <movementForm.reason
          helpText={kind === 'adjustment' ? k('movement.reasonRequired') : undefined}
          id="movement-reason"
          label={k('fields.reason')}
          maxLength={500}
          required
          requiredLabel={requiredLabel}
        />
        <MovementTrackingFields batches={batches} item={item} kind={kind} picking={picking} serials={serials} />
        <MovementReferenceFields kind={kind} properties={properties} tasks={tasks} />
        <FormSaveFooter
          cancelLabel={t('facility-operations.common.cancel')}
          error={error}
          form={form}
          onCancel={onDone}
        />
      </FormRoot>
    </SectionCard>
  );
};

export const MovementForm = (props: Props) => (
  <MovementEditor key={`${props.item.id}:${props.kind}:${props.planned?.id ?? ''}`} {...props} />
);
