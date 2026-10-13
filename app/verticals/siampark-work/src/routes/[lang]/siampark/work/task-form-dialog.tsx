import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import type { Employee } from '@app/workforce/contracts/records';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { Option, Schema } from 'effect';
import { useState } from 'react';
import {
  EmployeeIdSchema,
  OpportunityIdSchema,
  PartyIdSchema,
  TaskPrioritySchema,
} from '../../../../../shared/apis/records.ts';
import type { Task } from '../../../../../shared/apis/records.ts';

const NONE = 'none';
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

const FieldErrorSchema = Schema.Literals(['clear', 'id', 'title']);
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

const validate = (values: FormValues, task: Task | undefined, decoded: Decoded): FieldErrors => ({
  assigneeId: clearedError(task?.assigneeEmployeeId !== undefined, decoded.assigneeEmployeeId !== undefined),
  dueDate: clearedError(task?.dueDate !== undefined, decoded.dueDate !== undefined),
  opportunityId: idError(values.opportunityId, task?.opportunityId !== undefined, decoded.opportunityId !== undefined),
  partyId: idError(values.partyId, task?.partyId !== undefined, decoded.partyId !== undefined),
  title: values.title.trim() === '' ? 'title' : undefined,
});

/** Field error props, spread so `validateStatus` is absent (not undefined) when the field is valid. */
const invalidProps = (message: string | undefined) =>
  message === undefined ? {} : { helpText: message, validateStatus: 'error' as const };

export const TaskFormDialog = ({
  busy,
  employees,
  error,
  onClose,
  onSubmit,
  task,
}: {
  readonly busy: boolean;
  readonly employees: readonly Employee[];
  readonly error: string | undefined;
  readonly onClose: () => void;
  readonly onSubmit: (submission: TaskFormSubmission) => void;
  /** `undefined` creates a task. Mount this component only while it is open. */
  readonly task: Task | undefined;
}) => {
  const { t } = useModernI18n();
  const [values, setValues] = useState(() => initialValues(task));
  const [submitted, setSubmitted] = useState(false);
  const set = (patch: Partial<FormValues>) => setValues((current) => ({ ...current, ...patch }));

  const decoded: Decoded = {
    assigneeEmployeeId: decodeOptional(EmployeeIdSchema, values.assigneeId),
    dueDate: values.dueDate,
    opportunityId: decodeOptional(OpportunityIdSchema, values.opportunityId),
    partyId: decodeOptional(PartyIdSchema, values.partyId),
  };
  const errors = validate(values, task, decoded);
  const message = (field: FieldName) => {
    const code = errors[field];
    return submitted && code !== undefined ? t(`${key}.errors.${code}`) : undefined;
  };
  const hasErrors = Object.values(errors).some((code) => code !== undefined);

  const submit = () => {
    setSubmitted(true);
    if (hasErrors) {
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

  const priorityItems = (['LOW', 'NORMAL', 'HIGH'] as const).map((value) => ({
    label: t(`${key}.priorities.${value}`),
    value,
  }));
  const assigneeItems = [
    { label: t(`${key}.unassigned`), value: NONE },
    ...employees.map((employee) => ({ label: employee.fullName, value: employee.id })),
  ];
  const isEdit = task !== undefined;
  const assigneeMessage = message('assigneeId');

  return (
    <Dialog
      actions={
        <>
          <Button onClick={onClose} theme="outlined" variant="secondary">
            {t(`${key}.cancel`)}
          </Button>
          <Button disabled={busy} isLoading={busy} loadingText={t(`${key}.saving`)} onClick={submit} variant="primary">
            {t(isEdit ? `${key}.submitEdit` : `${key}.submitCreate`)}
          </Button>
        </>
      }
      customTrigger
      onOpenChange={({ open }) => {
        if (!open) {
          onClose();
        }
      }}
      open
      placement="right"
      size="md"
      title={t(isEdit ? `${key}.edit` : `${key}.create`)}
    >
      <div className="flex flex-col gap-200 py-200">
        {error !== undefined && (
          <StatusText showIcon status="error">
            {error}
          </StatusText>
        )}
        <FormInput
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
          <FormInput
            disabled={busy}
            id="task-due"
            label={t(`${key}.dueDate`)}
            onChange={(event) => set({ dueDate: event.target.value === '' ? undefined : event.target.value })}
            type="date"
            value={values.dueDate ?? ''}
            {...invalidProps(message('dueDate'))}
          />
          <Select
            disabled={busy}
            items={priorityItems}
            label={t(`${key}.priority`)}
            name="priority"
            onValueChange={({ value }) => {
              const [next] = value;
              if (Schema.is(TaskPrioritySchema)(next)) {
                set({ priority: next });
              }
            }}
            size="md"
            value={[values.priority]}
          />
        </div>
        <FormInput
          disabled={busy}
          id="task-party"
          label={t(`${key}.party`)}
          onChange={(event) => set({ partyId: event.target.value })}
          value={values.partyId}
          {...invalidProps(message('partyId'))}
        />
        <FormInput
          disabled={busy}
          id="task-opportunity"
          label={t(`${key}.opportunity`)}
          onChange={(event) => set({ opportunityId: event.target.value })}
          value={values.opportunityId}
          {...invalidProps(message('opportunityId'))}
        />
      </div>
    </Dialog>
  );
};
