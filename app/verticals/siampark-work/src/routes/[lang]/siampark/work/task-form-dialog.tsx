import { SidePanel } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import type { Employee } from '@app/workforce/contracts/records';
import { CalendarDate } from '@internationalized/date';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import { DatePicker } from '@techsio/ui-kit/molecules/date-picker';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { Option, Schema } from 'effect';
import { useEffect, useRef, useState } from 'react';
import {
  EmployeeIdSchema,
  OpportunityIdSchema,
  PartyIdSchema,
  TaskPrioritySchema,
} from '../../../../../shared/apis/records.ts';
import type { Task } from '../../../../../shared/apis/records.ts';
import { customerOptionItems, selectOption } from './tasks-model.ts';
import type { CustomerOption, OpportunityOption } from './tasks-model.ts';

const NONE = 'none';
// Select labels take the dialog's label size, the same size FormInput, Combobox and DatePicker labels use.
const dialogLabelProps = { className: 'font-label text-label-md' };
const key = 'siampark-work.pages.records';

type TaskDueDate = NonNullable<Task['dueDate']>;
type Priority = Task['priority'];
type EmployeeId = typeof EmployeeIdSchema.Type;
type OpportunityId = typeof OpportunityIdSchema.Type;
type PartyId = typeof PartyIdSchema.Type;

export interface TaskFormSubmission {
  readonly assigneeEmployeeId: EmployeeId | undefined;
  readonly description: string;
  readonly dueDate: TaskDueDate | undefined;
  readonly opportunityId: OpportunityId | undefined;
  readonly partyId: PartyId | undefined;
  readonly priority: Priority;
  readonly title: string;
}

interface FormValues {
  readonly assigneeId: string;
  readonly description: string;
  readonly dueDate: TaskDueDate | undefined;
  readonly opportunityId: string;
  readonly partyId: string;
  readonly priority: Priority;
  readonly title: string;
}

interface Decoded {
  readonly assigneeEmployeeId: EmployeeId | undefined;
  readonly dueDate: TaskDueDate | undefined;
  readonly opportunityId: OpportunityId | undefined;
  readonly partyId: PartyId | undefined;
}

const FieldErrorSchema = Schema.Literals(['clear', 'id', 'mismatch', 'title']);
type FieldError = typeof FieldErrorSchema.Type;

interface FieldErrors {
  readonly assigneeId: FieldError | undefined;
  readonly dueDate: FieldError | undefined;
  readonly opportunityId: FieldError | undefined;
  readonly partyId: FieldError | undefined;
  readonly title: FieldError | undefined;
}

type FieldName = keyof FieldErrors;

const initialValues = (task: Task | undefined): FormValues => ({
  assigneeId: task?.assigneeEmployeeId ?? '',
  description: task?.description ?? '',
  dueDate: task?.dueDate,
  opportunityId: task?.opportunityId ?? '',
  partyId: task?.partyId ?? '',
  priority: task?.priority ?? 'NORMAL',
  title: task?.title ?? '',
});

const decodeOptional = <A, I>(schema: Schema.Codec<A, I>, value: string) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value.trim()));

/** An emptied field is rejected when the task already has a value: the update contract cannot clear it. */
const clearedError = (hadValue: boolean, hasValue: boolean): FieldError | undefined =>
  hadValue && !hasValue ? 'clear' : undefined;

const idError = (text: string, hadValue: boolean, isValid: boolean): FieldError | undefined => {
  if (text.trim() !== '' && !isValid) {
    return 'id';
  }
  return clearedError(hadValue, isValid);
};

/** An opportunity belongs to one customer, so a chosen customer that differs from its owner is inconsistent. */
const mismatchError = (partyId: string, opportunityOwner: string | undefined): FieldError | undefined =>
  partyId !== '' && opportunityOwner !== undefined && opportunityOwner !== partyId ? 'mismatch' : undefined;

const validate = (
  values: FormValues,
  task: Task | undefined,
  decoded: Decoded,
  opportunityOwner: string | undefined,
): FieldErrors => ({
  assigneeId: clearedError(task?.assigneeEmployeeId !== undefined, decoded.assigneeEmployeeId !== undefined),
  dueDate: clearedError(task?.dueDate !== undefined, decoded.dueDate !== undefined),
  opportunityId:
    idError(values.opportunityId, task?.opportunityId !== undefined, decoded.opportunityId !== undefined) ??
    mismatchError(values.partyId, opportunityOwner),
  partyId: idError(values.partyId, task?.partyId !== undefined, decoded.partyId !== undefined),
  title: values.title.trim() === '' ? 'title' : undefined,
});

/** Calendar value for the date picker. `YYYY-MM-DD` strings are the form's storage format. */
const toCalendarDate = (isoDate: string | undefined) =>
  isoDate === undefined
    ? null
    : new CalendarDate(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)), Number(isoDate.slice(8, 10)));

/**
 * The calendar is portalled to <body>, outside the drawer. Its content has no z-index of its own, so it would sit
 * under the dialog (z 20) where clicks land on the form instead of a day. Lift it to the shared popup layer and give
 * it the opaque popup surface (the kit surface token resolves to a translucent overlay in this theme).
 */
const datePickerContentClass = 'z-(--z-popup) bg-(--color-popup-bg)';

/** Combobox values are arrays; the form keeps one id, or '' for none. */
const singleValue = (value: string) => (value === '' ? [] : [value]);
const firstValue = (next: string | string[]) => (Array.isArray(next) ? next[0] : next) ?? '';

/** Field error props, spread so `validateStatus` is absent (not undefined) when the field is valid. */
const invalidProps = (message: string | undefined) =>
  message === undefined ? {} : { helpText: message, validateStatus: 'error' as const };

/** True when a field differs from the saved task (or from the empty form), so closing would lose input. */
const hasUnsavedInput = (values: FormValues, task: Task | undefined) => {
  const initial = initialValues(task);
  return (
    values.assigneeId !== initial.assigneeId ||
    values.description !== initial.description ||
    values.dueDate !== initial.dueDate ||
    values.opportunityId !== initial.opportunityId ||
    values.partyId !== initial.partyId ||
    values.priority !== initial.priority ||
    values.title !== initial.title
  );
};

const DiscardDialog = ({
  finalFocusEl,
  onDiscard,
  onKeep,
  open,
  task,
}: {
  readonly finalFocusEl: () => HTMLElement | null;
  readonly onDiscard: () => void;
  readonly onKeep: () => void;
  readonly open: boolean;
  readonly task: Task | undefined;
}) => {
  const { t } = useModernI18n();
  return (
    <Dialog
      actions={
        <>
          <Button onClick={onKeep} theme="outlined" variant="secondary">
            {t(`${key}.discard.keep`)}
          </Button>
          <Button onClick={onDiscard} variant="danger">
            {t(`${key}.discard.confirm`)}
          </Button>
        </>
      }
      customTrigger
      description={t(`${key}.discard.description`)}
      finalFocusEl={finalFocusEl}
      onOpenChange={({ open: next }) => {
        if (!next) {
          onKeep();
        }
      }}
      open={open}
      role="alertdialog"
      size="sm"
      title={
        task === undefined ? t(`${key}.discard.createTitle`) : t(`${key}.discard.editTitle`, { title: task.title })
      }
    />
  );
};

export const TaskFormDialog = ({
  busy,
  customers,
  employees,
  error,
  onClose,
  onSubmit,
  opportunities,
  task,
}: {
  readonly busy: boolean;
  readonly customers: readonly CustomerOption[];
  readonly employees: readonly Employee[];
  readonly error: string | undefined;
  readonly onClose: () => void;
  readonly onSubmit: (submission: TaskFormSubmission) => void;
  readonly opportunities: readonly OpportunityOption[];
  /** `undefined` creates a task. Mount this component only while it is open. */
  readonly task: Task | undefined;
}) => {
  const { t } = useModernI18n();
  const [values, setValues] = useState(() => initialValues(task));
  const [submitted, setSubmitted] = useState(false);
  const [submitAttempts, setSubmitAttempts] = useState(0);
  const [customerQuery, setCustomerQuery] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);
  // The field focused when closing was asked for (the Řešitel trigger after Escape); "keep editing" returns there.
  const closeRequester = useRef<HTMLElement | null>(null);
  const set = (patch: Partial<FormValues>) => setValues((current) => ({ ...current, ...patch }));
  // Escape, the close button and Zrušit keep the draft behind a confirmation while it holds unsaved input.
  const requestClose = () => {
    if (hasUnsavedInput(values, task)) {
      closeRequester.current = globalThis.document.querySelector<HTMLElement>(':focus');
      setConfirmDiscard(true);
    } else {
      onClose();
    }
  };

  // A failed submit moves focus to the first invalid field. The error state renders after this submit, so the
  // effect waits for it.
  useEffect(() => {
    if (submitAttempts > 0) {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    }
  }, [submitAttempts]);

  const decoded: Decoded = {
    assigneeEmployeeId: decodeOptional(EmployeeIdSchema, values.assigneeId),
    dueDate: values.dueDate,
    opportunityId: decodeOptional(OpportunityIdSchema, values.opportunityId),
    partyId: decodeOptional(PartyIdSchema, values.partyId),
  };
  const opportunityOwner = opportunities.find((opportunity) => opportunity.id === values.opportunityId)?.partyId;
  const errors = validate(values, task, decoded, opportunityOwner);
  const message = (field: FieldName) => {
    const code = errors[field];
    return submitted && code !== undefined ? t(`${key}.errors.${code}`) : undefined;
  };
  const hasErrors = Object.values(errors).some((code) => code !== undefined);

  const submit = () => {
    setSubmitted(true);
    if (hasErrors) {
      setSubmitAttempts((count) => count + 1);
      return;
    }
    onSubmit({
      assigneeEmployeeId: decoded.assigneeEmployeeId,
      description: values.description.trim(),
      dueDate: decoded.dueDate,
      opportunityId: decoded.opportunityId,
      partyId: decoded.partyId,
      priority: values.priority,
      title: values.title.trim(),
    });
  };

  const priorityItems = (['LOW', 'NORMAL', 'HIGH'] as const).map((value) =>
    selectOption(t(`${key}.priorities.${value}`), value),
  );
  const assigneeItems = [
    selectOption(t(`${key}.unassigned`), NONE),
    ...employees.map((employee) => selectOption(employee.fullName, employee.id)),
  ];
  // Filtered here, not by the kit: its local filter ignores diacritics ("plzen" misses "Plzeň") and resets on open.
  // The input shows the chosen customer's name until the user edits it; that text alone must not narrow the list.
  const selectedCustomerName = customers.find((customer) => customer.partyId === values.partyId)?.displayName;
  const customerItems = customerOptionItems(customers, customerQuery === selectedCustomerName ? '' : customerQuery);
  const companyIds = new Map(customers.map((customer) => [customer.partyId, customer.companyId] as const));
  // With a customer chosen, only that customer's opportunities are offered.
  const opportunityItems = opportunities.flatMap((opportunity) =>
    values.partyId === '' || opportunity.partyId === values.partyId
      ? [{ label: opportunity.title, value: opportunity.id }]
      : [],
  );
  const isEdit = task !== undefined;
  const assigneeMessage = message('assigneeId');
  const dueMessage = message('dueDate');

  return (
    <>
      <SidePanel
        actions={
          <>
            <Button onClick={requestClose} theme="outlined" variant="secondary">
              {t(`${key}.cancel`)}
            </Button>
            <Button
              disabled={busy}
              isLoading={busy}
              loadingText={t(`${key}.saving`)}
              onClick={submit}
              variant="primary"
            >
              {t(isEdit ? `${key}.submitEdit` : `${key}.submitCreate`)}
            </Button>
          </>
        }
        // The form holds unsaved input; a stray pointer or focus move outside must not discard it.
        closeOnInteractOutside={false}
        onOpenChange={(next) => {
          if (!next) {
            requestClose();
          }
        }}
        open
        size="md"
        title={t(isEdit ? `${key}.edit` : `${key}.create`)}
      >
        <div className="flex flex-col gap-200 py-200" ref={formRef}>
          {error !== undefined && (
            <StatusText showIcon status="error">
              {error}
            </StatusText>
          )}
          <FormInput
            autoComplete="off"
            disabled={busy}
            id="task-title"
            label={t(`${key}.taskTitle`)}
            maxLength={200}
            onChange={(event) => set({ title: event.target.value })}
            required
            value={values.title}
            {...invalidProps(message('title'))}
          />
          <FormTextarea
            autoComplete="off"
            disabled={busy}
            id="task-description"
            label={t(`${key}.description`)}
            maxLength={2000}
            onChange={(event) => set({ description: event.target.value })}
            value={values.description}
          />
          <div className="flex flex-col gap-50">
            <Select
              disabled={busy}
              items={assigneeItems}
              label={t(`${key}.assignee`)}
              labelProps={dialogLabelProps}
              name="assignee"
              onValueChange={({ value }) => {
                const [next] = value;
                set({ assigneeId: next === undefined || next === NONE ? '' : next });
              }}
              placeholder={t(`${key}.unassigned`)}
              size="md"
              value={[values.assigneeId === '' ? NONE : values.assigneeId]}
            />
            {assigneeMessage !== undefined && <StatusText status="error">{assigneeMessage}</StatusText>}
          </div>
          <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
            <div className="flex flex-col gap-50">
              <DatePicker.Root
                defaultValue={toCalendarDate(values.dueDate)}
                locale="cs-CZ"
                onValueChange={(details) =>
                  set({ dueDate: details.value === null ? undefined : details.valueAsString })
                }
                size="md"
              >
                <DatePicker.Label>{t(`${key}.dueDate`)}</DatePicker.Label>
                <DatePicker.Control>
                  <DatePicker.Segments />
                  <DatePicker.IndicatorGroup>
                    {!isEdit && <DatePicker.ClearTrigger />}
                    <DatePicker.Trigger />
                  </DatePicker.IndicatorGroup>
                </DatePicker.Control>
                <DatePicker.Positioner>
                  <DatePicker.Content className={datePickerContentClass}>
                    <DatePicker.Calendar />
                  </DatePicker.Content>
                </DatePicker.Positioner>
              </DatePicker.Root>
              {dueMessage !== undefined && <StatusText status="error">{dueMessage}</StatusText>}
            </div>
            <Select
              disabled={busy}
              items={priorityItems}
              label={t(`${key}.priority`)}
              labelProps={dialogLabelProps}
              name="priority"
              onValueChange={({ value }) => {
                const [next] = value;
                if (Schema.is(TaskPrioritySchema)(next)) {
                  set({ priority: next });
                }
              }}
              placeholder={t('siampark-work.selectPlaceholder')}
              size="md"
              value={[values.priority]}
            />
          </div>
          <Combobox
            clearable={!isEdit}
            disabled={busy}
            filterBehavior="external"
            items={customerItems}
            label={t(`${key}.party`)}
            name="party"
            noResultsMessage={t(`${key}.comboboxEmpty`)}
            onChange={(next) => set({ partyId: firstValue(next) })}
            // No reset on open: typing into a closed list reports the text first and opens second, so a reset
            // there would drop the first query and list every customer.
            onInputValueChange={setCustomerQuery}
            placeholder={t(`${key}.pickCustomer`)}
            renderItem={(item) => {
              const companyId = companyIds.get(item.value) ?? '';
              return (
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{item.label}</span>
                  {companyId !== '' && (
                    <span className="text-fg-secondary text-xs">{t(`${key}.companyId`, { id: companyId })}</span>
                  )}
                </span>
              );
            }}
            size="md"
            value={singleValue(values.partyId)}
            {...invalidProps(message('partyId'))}
          />
          <Combobox
            clearable={!isEdit}
            disabled={busy}
            items={opportunityItems}
            label={t(`${key}.opportunity`)}
            name="opportunity"
            noResultsMessage={t(`${key}.comboboxEmpty`)}
            onChange={(next) => set({ opportunityId: firstValue(next) })}
            placeholder={t(`${key}.pickOpportunity`)}
            size="md"
            value={singleValue(values.opportunityId)}
            {...invalidProps(message('opportunityId'))}
          />
        </div>
      </SidePanel>
      <DiscardDialog
        finalFocusEl={() => (closeRequester.current?.isConnected === true ? closeRequester.current : null)}
        onDiscard={onClose}
        onKeep={() => setConfirmDiscard(false)}
        open={confirmDiscard}
        task={task}
      />
    </>
  );
};
