import { SidePanel, comboboxTranslations, datePickerTranslations, dialogCloseLabel } from '@app/admin-ui';
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
import type { FocusEvent, KeyboardEvent } from 'react';
import {
  EmployeeIdSchema,
  OpportunityIdSchema,
  PartyIdSchema,
  TaskPrioritySchema,
} from '../../../../../shared/apis/records.ts';
import type { Task } from '../../../../../shared/apis/records.ts';
import { isClosedTaskState } from '../../../../../shared/actions/task-transitions.ts';
import { customerOptionItems, opportunityOptionItems, selectOption } from './tasks-model.ts';
import type { CustomerOption, OpportunityOption } from './tasks-model.ts';

const NONE = 'none';
const titleMaxLength = 200;
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

/**
 * An emptied field is rejected when the task already has a value: the update contract cannot clear it. The due date
 * is the exception (UpdateTask accepts null for it), so it has no such check.
 */
const clearedError = (hadValue: boolean, hasValue: boolean): FieldError | undefined =>
  hadValue && !hasValue ? 'clear' : undefined;

const idError = (text: string, hadValue: boolean, isValid: boolean): FieldError | undefined => {
  if (text.trim() !== '' && !isValid) {
    return 'id';
  }
  return clearedError(hadValue, isValid);
};

/**
 * An opportunity belongs to one customer, so a chosen customer that differs from its owner is inconsistent. Only a
 * pair the user changes is checked: a saved task keeps its pair, so an untouched one never blocks other edits.
 */
const mismatchError = (
  values: FormValues,
  task: Task | undefined,
  opportunityOwner: string | undefined,
): FieldError | undefined => {
  const pairChanged = values.partyId !== (task?.partyId ?? '') || values.opportunityId !== (task?.opportunityId ?? '');
  return pairChanged && values.partyId !== '' && opportunityOwner !== undefined && opportunityOwner !== values.partyId
    ? 'mismatch'
    : undefined;
};

const validate = (
  values: FormValues,
  task: Task | undefined,
  decoded: Decoded,
  opportunityOwner: string | undefined,
): FieldErrors => ({
  assigneeId: clearedError(task?.assigneeEmployeeId !== undefined, decoded.assigneeEmployeeId !== undefined),
  opportunityId:
    idError(values.opportunityId, task?.opportunityId !== undefined, decoded.opportunityId !== undefined) ??
    mismatchError(values, task, opportunityOwner),
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

/**
 * Select and calendar lists are portalled to <body>. Choosing a value closes the list and focus falls to <body>, so
 * the next Tab left the panel. Return it to the field's trigger once zag has finished closing.
 */
const returnFocusTo = (field: HTMLElement | null) => {
  globalThis.requestAnimationFrame(() => {
    const active = globalThis.document.activeElement;
    if (field?.isConnected === true && (active === null || active === globalThis.document.body)) {
      field.querySelector<HTMLElement>('[data-part="trigger"]')?.focus({ preventScroll: true });
    }
  });
};

/**
 * Day and month keep two digits and the segments sit tight around the dots, so the field reads 24.09.2026 like the
 * table's Termín column, not "24. 9 .2026" (the kit pads each segment and centres one digit in a two-digit cell).
 */
const dateSegmentsClass = '[&>[data-type]]:min-w-0 [&>[data-type]]:px-px';

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
          <Button id="task-discard-keep" onClick={onKeep} theme="outlined" variant="secondary">
            {t(`${key}.discard.keep`)}
          </Button>
          <Button onClick={onDiscard} variant="danger">
            {t(`${key}.discard.confirm`)}
          </Button>
        </>
      }
      closeLabel={dialogCloseLabel}
      customTrigger
      description={t(`${key}.discard.description`)}
      finalFocusEl={finalFocusEl}
      // The safe choice gets focus: a stray Enter keeps the draft.
      initialFocusEl={() => globalThis.document.querySelector<HTMLElement>('#task-discard-keep')}
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

/** Zákazník and Příležitost pickers. Each keeps its typed query and its open state. */
const ReferencePickers = ({
  customers,
  customersLoading,
  disabled,
  isEdit,
  onChange,
  opportunities,
  opportunitiesLoading,
  opportunityId,
  opportunityMessage,
  partyId,
  partyMessage,
}: {
  readonly customers: readonly CustomerOption[];
  readonly customersLoading: boolean;
  readonly disabled: boolean;
  readonly isEdit: boolean;
  readonly onChange: (patch: Partial<FormValues>) => void;
  readonly opportunities: readonly OpportunityOption[];
  readonly opportunitiesLoading: boolean;
  readonly opportunityId: string;
  readonly opportunityMessage: string | undefined;
  readonly partyId: string;
  readonly partyMessage: string | undefined;
}) => {
  const { t } = useModernI18n();
  const [customerQuery, setCustomerQuery] = useState('');
  const [opportunityQuery, setOpportunityQuery] = useState('');
  // The pickers open on focus or click, not only on typing; zag's own open state is kept by these flags.
  const [customerOpen, setCustomerOpen] = useState(false);
  const [opportunityOpen, setOpportunityOpen] = useState(false);
  // Filtered here, not by the kit: its local filter ignores diacritics ("plzen" misses "Plzeň") and resets on open.
  // The input shows the chosen customer's name until the user edits it; that text alone must not narrow the list.
  const selectedCustomerName = customers.find((customer) => customer.partyId === partyId)?.displayName;
  const customerItems = customerOptionItems(customers, customerQuery === selectedCustomerName ? '' : customerQuery);
  const companyIds = new Map(customers.map((customer) => [customer.partyId, customer.companyId] as const));
  // With a customer chosen, only that customer's opportunities are offered. Filtered here like customers: the kit's
  // local filter is reset when typing opens the list, so a no-match query used to list every opportunity.
  const selectedOpportunityTitle = opportunities.find((opportunity) => opportunity.id === opportunityId)?.title;
  const opportunityNeedle = opportunityQuery === selectedOpportunityTitle ? '' : opportunityQuery;
  const opportunityItems = opportunityOptionItems(opportunities, {
    partyId,
    query: opportunityNeedle,
    selectedId: opportunityId,
  });
  // The kit shows its empty message only for typed text, so an empty list opened by focus looked like a dead field.
  // The footer says why nothing is offered: the chosen customer has no opportunity, or there is none at all.
  const opportunityFooter =
    !opportunitiesLoading && opportunityItems.length === 0 && opportunityNeedle.trim() === ''
      ? t(partyId === '' ? `${key}.noOpportunities` : `${key}.noCustomerOpportunities`)
      : undefined;
  return (
    <>
      {/* Focus or click opens the list: the kit only opens it on typing, so an empty field looked dead. */}
      <div onFocus={() => setCustomerOpen(true)}>
        <Combobox
          clearable={!isEdit}
          disabled={disabled}
          filterBehavior="external"
          items={customerItems}
          label={t(`${key}.party`)}
          // The lists load with the page; a panel opened before they settle says so instead of an empty popup.
          loading={customersLoading}
          loadingMessage={t(`${key}.loadingNames`)}
          name="party"
          noResultsMessage={t(`${key}.comboboxEmpty`)}
          onChange={(next) => onChange({ partyId: firstValue(next) })}
          // No reset on open: typing into a closed list reports the text first and opens second, so a reset
          // there would drop the first query and list every customer.
          onInputValueChange={setCustomerQuery}
          onOpenChange={setCustomerOpen}
          open={customerOpen}
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
          translations={comboboxTranslations}
          value={singleValue(partyId)}
          {...invalidProps(partyMessage)}
        />
      </div>
      <div onFocus={() => setOpportunityOpen(true)}>
        <Combobox
          clearable={!isEdit}
          disabled={disabled}
          filterBehavior="external"
          footer={opportunityFooter}
          items={opportunityItems}
          label={t(`${key}.opportunity`)}
          loading={opportunitiesLoading}
          loadingMessage={t(`${key}.loadingNames`)}
          name="opportunity"
          noResultsMessage={t(`${key}.comboboxEmpty`)}
          onChange={(next) => onChange({ opportunityId: firstValue(next) })}
          onInputValueChange={setOpportunityQuery}
          onOpenChange={setOpportunityOpen}
          open={opportunityOpen}
          placeholder={t(`${key}.pickOpportunity`)}
          size="md"
          translations={comboboxTranslations}
          value={singleValue(opportunityId)}
          {...invalidProps(opportunityMessage)}
        />
      </div>
    </>
  );
};

export const TaskFormDialog = ({
  busy,
  customers,
  customersLoading,
  employees,
  error,
  onClose,
  onSubmit,
  opportunities,
  opportunitiesLoading,
  task,
}: {
  readonly busy: boolean;
  readonly customers: readonly CustomerOption[];
  readonly customersLoading: boolean;
  readonly employees: readonly Employee[];
  readonly error: string | undefined;
  readonly onClose: () => void;
  readonly onSubmit: (submission: TaskFormSubmission) => void;
  readonly opportunities: readonly OpportunityOption[];
  readonly opportunitiesLoading: boolean;
  /** `undefined` creates a task. Mount this component only while it is open. */
  readonly task: Task | undefined;
}) => {
  const { t } = useModernI18n();
  const [values, setValues] = useState(() => initialValues(task));
  const [submitted, setSubmitted] = useState(false);
  const [submitAttempts, setSubmitAttempts] = useState(0);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // A done or cancelled task cannot change, so its panel shows the values read-only.
  const locked = task !== undefined && isClosedTaskState(task.state);
  const fieldsDisabled = busy || locked;
  const formRef = useRef<HTMLDivElement>(null);
  // The Řešitel, Termín or Priorita field focused last (its list content too: React focus events cross portals).
  const listField = useRef<HTMLElement | null>(null);
  const rememberListField = (event: FocusEvent<HTMLElement>) => {
    listField.current = event.currentTarget;
  };
  const onListOpenChange = ({ open }: { readonly open: boolean }) => {
    if (!open) {
      returnFocusTo(listField.current);
    }
  };
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
    if (locked) {
      return;
    }
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
  const isEdit = task !== undefined;
  const assigneeMessage = message('assigneeId');
  const titleMessage = message('title');

  return (
    <>
      <SidePanel
        actions={
          <>
            <Button onClick={requestClose} theme="outlined" variant="secondary">
              {t(`${key}.cancel`)}
            </Button>
            <Button
              disabled={fieldsDisabled}
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
        // The first field takes focus, so typing starts at once.
        initialFocusEl={() => globalThis.document.querySelector<HTMLElement>('#task-title')}
        onOpenChange={(next) => {
          if (!next) {
            requestClose();
          }
        }}
        open
        resizeLabel={t('siampark-work.sidePanel.resize')}
        size="lg"
        title={t(isEdit ? `${key}.edit` : `${key}.create`)}
      >
        <div className="flex flex-col gap-200 py-200" ref={formRef}>
          {error !== undefined && (
            <StatusText showIcon status="error">
              {error}
            </StatusText>
          )}
          {locked && <StatusText status="warning">{t(`${key}.closedTask`)}</StatusText>}
          <FormInput
            autoComplete="off"
            disabled={fieldsDisabled}
            // The length hint sits where the error would go; a field error replaces it, as invalidProps does.
            helpText={titleMessage ?? t(`${key}.titleLength`, { length: values.title.length, max: titleMaxLength })}
            id="task-title"
            label={t(`${key}.taskTitle`)}
            maxLength={titleMaxLength}
            onChange={(event) => set({ title: event.target.value })}
            // Enter submits, so an empty title gets the same field message as the button.
            onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
            required
            validateStatus={titleMessage === undefined ? 'default' : 'error'}
            value={values.title}
          />
          <FormTextarea
            autoComplete="off"
            disabled={fieldsDisabled}
            id="task-description"
            label={t(`${key}.description`)}
            maxLength={2000}
            onChange={(event) => set({ description: event.target.value })}
            value={values.description}
          />
          {/* The pickers sit high in the panel so their long lists open downward. Placed last, the list flipped up
              over Řešitel, Termín and Priorita. */}
          <ReferencePickers
            customers={customers}
            customersLoading={customersLoading}
            disabled={fieldsDisabled}
            isEdit={isEdit}
            onChange={set}
            opportunities={opportunities}
            opportunitiesLoading={opportunitiesLoading}
            opportunityId={values.opportunityId}
            opportunityMessage={message('opportunityId')}
            partyId={values.partyId}
            partyMessage={message('partyId')}
          />
          <div className="flex flex-col gap-50" onFocus={rememberListField}>
            <Select
              disabled={fieldsDisabled}
              items={assigneeItems}
              label={t(`${key}.assignee`)}
              labelProps={dialogLabelProps}
              name="assignee"
              onOpenChange={onListOpenChange}
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
          {/* Termín takes the full width: beside Priorita its year segment was clipped. */}
          <div onFocus={rememberListField}>
            <DatePicker.Root
              defaultValue={toCalendarDate(values.dueDate)}
              disabled={fieldsDisabled}
              locale="cs-CZ"
              onOpenChange={onListOpenChange}
              onValueChange={(details) => set({ dueDate: details.value === null ? undefined : details.valueAsString })}
              shouldForceLeadingZeros
              size="md"
              translations={datePickerTranslations}
            >
              <DatePicker.Label>{t(`${key}.dueDate`)}</DatePicker.Label>
              <DatePicker.Control>
                <DatePicker.Segments className={dateSegmentsClass} />
                <DatePicker.IndicatorGroup>
                  {/* An edit can remove the due date too, so the clear control shows in both modes. */}
                  <DatePicker.ClearTrigger />
                  <DatePicker.Trigger />
                </DatePicker.IndicatorGroup>
              </DatePicker.Control>
              <DatePicker.Positioner>
                <DatePicker.Content className={datePickerContentClass}>
                  <DatePicker.Calendar />
                </DatePicker.Content>
              </DatePicker.Positioner>
            </DatePicker.Root>
          </div>
          <div onFocus={rememberListField}>
            <Select
              disabled={fieldsDisabled}
              items={priorityItems}
              label={t(`${key}.priority`)}
              labelProps={dialogLabelProps}
              name="priority"
              onOpenChange={onListOpenChange}
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
