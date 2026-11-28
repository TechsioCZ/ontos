import {
  DocumentTitle,
  SaveBar,
  SidePanel,
  UnsavedChangesDialog,
  comboboxTranslations,
  datePickerTranslations,
  requiredLabelFor,
  saveLabelsFor,
  surfaceTileClassName,
  useDraftSave,
  useRecordDraft,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { RevisionedSaveResult, SaveOutcome, UnsavedChangesGuard } from '@app/admin-ui';
import {
  ChoiceLensField,
  ComboboxField,
  DateField,
  FormReact,
  FormRoot,
  SubmitButton,
  TextAreaField,
  TextField,
  SelectTemplateField,
  fromPayload,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { browserAtomRuntime, browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { assignmentLabel, principalKey } from '../../../../shared/assignment.ts';
import { assignmentOptions, selectedPrincipal } from './assignment-options.ts';
import { CalendarDate } from '@internationalized/date';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { DateTime, Effect, Match, Option, Schema, Struct } from 'effect';
import { constVoid } from 'effect/Function';
import { AsyncResult, Atom } from 'effect/reactivity';
import { useEffect, useRef, useState } from 'react';
import type { FocusEvent, ReactNode } from 'react';
import { ContextRefSchema, OpportunityIdSchema, PartyIdSchema } from '../../../../shared/apis/records.ts';
import { TaskContextPickers } from './task-context-pickers.tsx';
import { ChangeHistory } from './change-history.tsx';
import type {
  AssignmentPrincipal,
  ContextRef,
  LookupAccess,
  Task,
  WorkProject,
} from '../../../../shared/apis/records.ts';
import { isClosedTaskState } from '../../../../shared/actions/task-transitions.ts';
import {
  CreateTaskCommandSchema,
  PlanningCommandSchema,
  isPlausibleDueDate,
} from '../../../../shared/actions/apply-command.ts';
import {
  customerOptionItems,
  formatDueDate,
  opportunityOptionItems,
  selectOption,
  taskContextHref,
} from './tasks-model.ts';
import type { CustomerOption, OpportunityOption } from './tasks-model.ts';
import { initialValues, sameFormValues, taskFormSubmission } from './task-form-values.ts';
import type { Decoded, FormValues, TaskFormSubmission } from './task-form-values.ts';
import { Link } from '@techsio/ui-kit/atoms/link';

export type { TaskFormSubmission } from './task-form-values.ts';

/**
 * The task panel's draft. The title is the CreateTask payload's own; the other fields hold what their controls show
 * (ids as chosen, '' for none), which the panel decodes when it sends the draft. Uložit sends it through the panel's
 * one save, so the form itself only holds it.
 */
const taskForm = FormReact.make(
  fromPayload(CreateTaskCommandSchema.mapFields(Struct.pick(['title'])))
    .addField('assigneeId', Schema.String)
    .addField('contextRefs', Schema.Array(ContextRefSchema))
    .addField('description', Schema.String)
    .addField('dueDate', Schema.String)
    .addField('opportunityId', Schema.String)
    .addField('partyId', Schema.String)
    .addField('plannedHours', Schema.String)
    .addField('priority', Schema.String)
    .addField('projectId', Schema.String),
  {
    fields: {
      // Řešitel and Projekt offer "none" as an item of their own; the form keeps '' for it.
      assigneeId: ChoiceLensField<string>,
      // Each context picker reads and writes its own kind of reference.
      contextRefs: ChoiceLensField<readonly ContextRef[]>,
      description: TextAreaField,
      dueDate: DateField,
      opportunityId: ComboboxField,
      partyId: ComboboxField,
      plannedHours: TextField,
      priority: SelectTemplateField,
      projectId: ChoiceLensField<string>,
      title: TextField,
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);

const emptyContextLabels: ReadonlyMap<string, string> = new Map();
const emptyProjects: readonly WorkProject[] = [];
const NONE = 'none';
const titleMaxLength = 200;
// Select labels take the dialog's label size, the same size FormInput, Combobox and DatePicker labels use.
const dialogLabelProps = { className: 'font-label text-label-md' };
const key = 'work-tasks.pages.records';

const FieldErrorSchema = Schema.Literals(['clear', 'dueDate', 'id', 'mismatch']);
type FieldError = typeof FieldErrorSchema.Type;

/** The checks that depend on the task and the lists on screen; the title is checked by the payload's own schema. */
interface FieldErrors {
  readonly assigneeId: FieldError | undefined;
  readonly dueDate: FieldError | undefined;
  readonly opportunityId: FieldError | undefined;
  readonly partyId: FieldError | undefined;
}

type FieldName = keyof FieldErrors;

const decodeOptional = <A, I>(schema: Schema.Codec<A, I>, value: string) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value.trim()));

/**
 * Customer and opportunity references cannot be cleared by UpdateTask. Other nullable fields use its explicit
 * clear contract instead.
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
  assigneeId: idError(values.assigneeId, false, decoded.ownerPrincipalRef !== undefined),
  // A typed year such as 0026 is a valid calendar date but not a real deadline. Only a changed date is checked.
  dueDate:
    values.dueDate !== '' && values.dueDate !== (task?.dueDate ?? '') && !isPlausibleDueDate(values.dueDate)
      ? 'dueDate'
      : undefined,
  opportunityId:
    idError(values.opportunityId, task?.opportunityId !== undefined, decoded.opportunityId !== undefined) ??
    mismatchError(values, task, opportunityOwner),
  partyId: idError(values.partyId, task?.partyId !== undefined, decoded.partyId !== undefined),
});

/** Calendar value for the date picker. `YYYY-MM-DD` strings are the form's storage format. */
const toCalendarDate = (isoDate: string) =>
  new CalendarDate(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)), Number(isoDate.slice(8, 10)));

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

/** A field error of the module's own checks, spread so `helpText` is absent (not undefined) when the field is valid. */
const invalidProps = (message: string | undefined) =>
  message === undefined ? {} : { helpText: message, invalid: true };

/** Řešitel and Projekt offer "none" as an item of their own; the form keeps '' for it. */
const readNone = (value: string) => (value === '' ? NONE : value);
const writeNone = (_value: string, choice: string) => (choice === NONE ? '' : choice);

/** Zákazník and Příležitost pickers. Each keeps its typed query and its open state. */
const ReferencePickers = ({
  customers,
  customersLoading,
  disabled,
  isEdit,
  lookupAccess,
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
  readonly lookupAccess: LookupAccess | undefined;
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
      {lookupAccess?.customers === 'allowed' && (
        <div onFocus={() => setCustomerOpen(true)}>
          <taskForm.partyId
            clearable={!isEdit}
            disabled={disabled}
            filterBehavior="external"
            items={customerItems}
            // The kit fills the input text from the item list when it mounts. A panel opened by a link before the
            // list arrived kept an empty input, so the field remounts once the names are there.
            key={customersLoading ? 'party-loading' : 'party-ready'}
            label={t(`${key}.party`)}
            // The lists load with the page; a panel opened before they settle says so instead of an empty popup.
            loading={customersLoading}
            loadingMessage={t(`${key}.loadingNames`)}
            name="party"
            noResultsMessage={t(`${key}.comboboxEmpty`)}
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
            {...invalidProps(partyMessage)}
          />
        </div>
      )}
      {lookupAccess?.opportunities === 'allowed' && (
        <div onFocus={() => setOpportunityOpen(true)}>
          <taskForm.opportunityId
            clearable={!isEdit}
            disabled={disabled}
            filterBehavior="external"
            footer={opportunityFooter}
            items={opportunityItems}
            key={opportunitiesLoading ? 'opportunity-loading' : 'opportunity-ready'}
            label={t(`${key}.opportunity`)}
            loading={opportunitiesLoading}
            loadingMessage={t(`${key}.loadingNames`)}
            name="opportunity"
            noResultsMessage={t(`${key}.comboboxEmpty`)}
            onInputValueChange={setOpportunityQuery}
            onOpenChange={setOpportunityOpen}
            open={opportunityOpen}
            placeholder={t(`${key}.pickOpportunity`)}
            size="md"
            translations={comboboxTranslations}
            {...invalidProps(opportunityMessage)}
          />
        </div>
      )}
    </>
  );
};

interface TaskFormDialogProps {
  readonly actorName: (principalId: string, displayName?: string) => string;
  readonly assignmentAvailable: boolean;
  readonly busy: boolean;
  /** Names of properties, units and contracts by resourceId, for the change history. */
  readonly contextLabels?: ReadonlyMap<string, string>;
  readonly customers: readonly CustomerOption[];
  readonly customersLoading: boolean;
  readonly error: string | undefined;
  readonly lookupAccess: LookupAccess | undefined;
  /** Hides a closed task from the lists (true) or lists it again (false); absent without write access. */
  readonly onArchive?: ((archived: boolean) => void) | undefined;
  readonly onClose: () => void;
  readonly onComment?: (text: string) => void;
  /**
   * Creates the task (the Save button). `saved` and `proposed` close the panel; `failed` keeps the draft, and the
   * page's message shows in `error`.
   */
  readonly onCreate: (submission: TaskFormSubmission) => Effect.Effect<SaveOutcome>;
  /** Saves an edit of an existing task (the Save button) against the revision its draft builds on. */
  readonly onSaveEdit: (
    submission: TaskFormSubmission,
    expectedRevision: number,
  ) => Effect.Effect<RevisionedSaveResult>;
  readonly opportunities: readonly OpportunityOption[];
  readonly opportunitiesLoading: boolean;
  readonly principalNames: ReadonlyMap<string, string>;
  readonly principals: readonly AssignmentPrincipal[];
  readonly projects?: readonly WorkProject[];
  readonly readOnly?: boolean;
  /** Revision of the task list the panel's task comes from. */
  readonly revision: number;
  /** `undefined` creates a task. Mount this component only while it is open. */
  readonly task: Task | undefined;
}
type ResolvedTaskFormProps = Omit<TaskFormDialogProps, 'contextLabels' | 'projects' | 'readOnly'> &
  Required<Pick<TaskFormDialogProps, 'contextLabels' | 'projects' | 'readOnly'>>;

const hoursFormatter = new Intl.NumberFormat('cs-CZ');
const commentDateFormatter = new Intl.DateTimeFormat('cs-CZ', { dateStyle: 'medium', timeStyle: 'short' });
const contextFallback = (type: string) =>
  Match.value(type).pipe(
    Match.when('legal.agreements.contract', () => 'smlouva'),
    Match.when('property.portfolio.unit', () => 'jednotka'),
    Match.when('property.portfolio.asset', () => 'majetek'),
    Match.orElse(() => 'nemovitost'),
  );
const contextLinkKey = (ref: ContextRef) => {
  if (ref.moduleId === 'legal.agreements') {
    return 'openContract';
  }
  if (ref.resourceType === 'property.portfolio.unit') {
    return 'openUnit';
  }
  if (ref.resourceType === 'property.portfolio.asset') {
    return 'openAsset';
  }
  return 'openProperty';
};

/** The decoded references and field errors of one draft. */
const assess = (
  values: FormValues,
  { opportunities, principals, task }: Pick<ResolvedTaskFormProps, 'opportunities' | 'principals' | 'task'>,
) => {
  const decoded: Decoded = {
    dueDate: values.dueDate === '' ? undefined : values.dueDate,
    opportunityId: decodeOptional(OpportunityIdSchema, values.opportunityId),
    ownerPrincipalRef:
      selectedPrincipal(principals, values.assigneeId) ??
      (task?.ownerPrincipalRef !== undefined && principalKey(task.ownerPrincipalRef) === values.assigneeId
        ? task.ownerPrincipalRef
        : undefined),
    partyId: decodeOptional(PartyIdSchema, values.partyId),
  };
  const opportunityOwner = opportunities.find((opportunity) => opportunity.id === values.opportunityId)?.partyId;
  const errors = validate(values, task, decoded, opportunityOwner);
  return { decoded, errors, hasErrors: Object.values(errors).some((code) => code !== undefined) };
};

/** What the form sends for a draft; None while a field is invalid. */
const submissionOf = (values: FormValues, props: ResolvedTaskFormProps) => {
  const { decoded, hasErrors } = assess(values, props);
  return hasErrors ? Option.none() : taskFormSubmission(values, decoded);
};

/** The form's values for this panel once FormRoot initialized them; until then the values it opens with. */
const useTaskValues = (opened: FormValues) => {
  const [ready, setReady] = useState(false);
  const values = Option.getOrElse(
    Option.filter(useAtomValue(taskForm.values), () => ready),
    () => opened,
  );
  return { ready, setReady, values };
};

/**
 * Rendered inside FormRoot, which renders its children only once this panel initialized the form: until then the
 * form's atoms can still hold what an earlier panel left, so the values are read only after `onReady`.
 */
const FormReady = ({ onReady }: { readonly onReady: (ready: boolean) => void }) => {
  useEffect(() => onReady(true), [onReady]);
  return null;
};

/** Field messages show once the draft is held back by them, as the save bar says. Only Uložit sends the draft. */
const useFieldMessages = (invalid: boolean) => {
  const checkFields = useAtomSet(taskForm.validate);
  useEffect(() => {
    if (invalid) {
      checkFields();
    }
  }, [checkFields, invalid]);
};

interface TaskDraftState {
  /** Called once FormRoot initialized the form for this panel. */
  readonly onReady: (ready: boolean) => void;
  /** The values the form starts with. */
  readonly opened: FormValues;
  /** Asks to close the panel: unsaved input asks Uložit / Zahodit změny / Zůstat first. */
  readonly requestClose: () => void;
  /** Field errors show once a create draft is held back by them, and always while editing. */
  readonly showErrors: boolean;
  readonly values: FormValues;
}

const useTaskForm = (props: ResolvedTaskFormProps, draft: TaskDraftState) => {
  const { busy, readOnly, task } = props;
  const { t } = useModernI18n();
  const { showErrors, values } = draft;
  // A done or cancelled task cannot change, so its panel shows the values read-only.
  const locked = readOnly || (task !== undefined && isClosedTaskState(task.state));
  const fieldsDisabled = busy || locked;
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

  const { errors } = assess(values, props);
  const message = (field: FieldName) => {
    const code = errors[field];
    return showErrors && code !== undefined ? t(`${key}.errors.${code}`) : undefined;
  };

  return {
    fieldsDisabled,
    isEdit: task !== undefined,
    locked,
    message,
    onListOpenChange,
    rememberListField,
    requestClose: draft.requestClose,
    values,
  };
};
type TaskFormController = ReturnType<typeof useTaskForm>;

const useTaskHistory = ({
  contextLabels,
  customers,
  opportunities,
  principalNames,
  projects,
}: ResolvedTaskFormProps) => {
  const { t } = useModernI18n();
  const fieldLabels = new Map(
    Object.entries({
      contextRefs: 'Objekt a smlouva',
      description: t(`${key}.description`),
      dueDate: t(`${key}.dueDate`),
      opportunityId: t(`${key}.opportunity`),
      ownerPrincipalRef: t(`${key}.assignee`),
      partyId: t(`${key}.party`),
      plannedHours: t(`${key}.plannedHours`),
      priority: t(`${key}.priority`),
      projectId: t(`${key}.project`),
      state: 'Stav',
      title: t(`${key}.taskTitle`),
    }),
  );
  const formatValue = (field: string, value: string | undefined): string => {
    if (value === undefined) {
      return '—';
    }
    return Match.value(field).pipe(
      Match.when('state', () => t(`${key}.states.${value}`)),
      Match.when('priority', () => t(`${key}.priorities.${value}`)),
      Match.when('dueDate', () => formatDueDate(value)),
      Match.when('ownerPrincipalRef', () => principalNames.get(value) ?? 'Účet mimo seznam'),
      Match.when(
        'partyId',
        () => customers.find((customer) => customer.partyId === value)?.displayName ?? 'zákazník bez přístupu',
      ),
      Match.when(
        'opportunityId',
        () => opportunities.find((opportunity) => opportunity.id === value)?.title ?? 'příležitost bez přístupu',
      ),
      Match.when('projectId', () => projects.find((project) => project.id === value)?.title ?? 'projekt'),
      Match.when('plannedHours', () => `${hoursFormatter.format(Number(value))} h`),
      Match.when('contextRefs', () =>
        value
          .split(',')
          .map((entry) => {
            const [type = '', id = ''] = entry.split(':');
            return contextLabels.get(id) ?? contextFallback(type);
          })
          .join(', '),
      ),
      Match.when('description', () => (value.length > 140 ? `${value.slice(0, 140)}…` : value)),
      Match.orElse(() => value),
    );
  };
  return { fieldLabel: (field: string) => fieldLabels.get(field) ?? field, formatValue };
};

const hasAssignmentHistory = (task: Task) =>
  task.ownerPrincipalRef !== undefined ||
  task.assignmentNeedsReassignment === true ||
  task.assignmentWithoutLogin === true;

const assigneeField = taskForm.getFieldAtoms(taskForm.fields.assigneeId);
const projectField = taskForm.getFieldAtoms(taskForm.fields.projectId);

/**
 * Řešitel and Projekt clear a choice their list no longer offers (an account that left the assignable people, a
 * project no longer listed), as the kit select reports it.
 */
const useClearUnoffered = (
  values: FormValues,
  assigneeItems: readonly { readonly value: string }[] | undefined,
  projectItems: readonly { readonly value: string }[],
) => {
  const setAssignee = useAtomSet(assigneeField.setValue);
  const setProject = useAtomSet(projectField.setValue);
  const assigneeGone =
    assigneeItems !== undefined &&
    values.assigneeId !== '' &&
    !assigneeItems.some((item) => item.value === values.assigneeId);
  const projectGone = values.projectId !== '' && !projectItems.some((item) => item.value === values.projectId);
  useEffect(() => {
    if (assigneeGone) {
      setAssignee('');
    }
  }, [assigneeGone, setAssignee]);
  useEffect(() => {
    if (projectGone) {
      setProject('');
    }
  }, [projectGone, setProject]);
};

const TaskFormFields = ({
  assignmentAvailable,
  customers,
  customersLoading,
  form,
  lookupAccess,
  opportunities,
  opportunitiesLoading,
  principalNames,
  principals,
  projects,
  readOnly,
  task,
}: ResolvedTaskFormProps & { readonly form: TaskFormController }) => {
  const { language, t } = useModernI18n();
  const { fieldsDisabled, isEdit, message, onListOpenChange, rememberListField, values } = form;
  const priorityItems = (['LOW', 'NORMAL', 'HIGH'] as const).map((value) =>
    selectOption(t(`${key}.priorities.${value}`), value),
  );
  const assigneeItems = [selectOption(t(`${key}.unassigned`), NONE), ...assignmentOptions(principals)];
  const projectItems = [
    selectOption(t(`${key}.noProject`), NONE),
    ...projects.map((project) => selectOption(project.title, project.id)),
  ];
  useClearUnoffered(values, assignmentAvailable ? assigneeItems : undefined, projectItems);
  const assigneeMessage = message('assigneeId');
  const dueDateMessage = message('dueDate');

  return (
    <>
      <taskForm.title
        autoComplete="off"
        disabled={fieldsDisabled}
        // The length hint sits where the error would go; the title's error replaces it.
        helpText={t(`${key}.titleLength`, { length: values.title.length, max: titleMaxLength })}
        id="task-title"
        label={t(`${key}.taskTitle`)}
        maxLength={titleMaxLength}
        required
        requiredLabel={requiredLabelFor(language)}
      />
      <taskForm.description
        autoComplete="off"
        disabled={fieldsDisabled}
        id="task-description"
        label={t(`${key}.description`)}
        maxLength={2000}
      />
      {task?.partyId !== undefined && !readOnly && lookupAccess?.customers === 'allowed' && (
        <Link href={`/cs/finance?partyId=${encodeURIComponent(task.partyId)}`} size="current">
          Faktury klienta
        </Link>
      )}
      {/* The pickers sit high in the panel so their long lists open downward. Placed last, the list flipped up
              over Řešitel, Termín and Priorita. */}
      <ReferencePickers
        customers={customers}
        customersLoading={customersLoading}
        disabled={fieldsDisabled}
        isEdit={isEdit}
        lookupAccess={lookupAccess}
        opportunities={opportunities}
        opportunitiesLoading={opportunitiesLoading}
        opportunityId={values.opportunityId}
        opportunityMessage={message('opportunityId')}
        partyId={values.partyId}
        partyMessage={message('partyId')}
      />
      {task !== undefined && hasAssignmentHistory(task) && (
        <p className="text-sm text-fg-secondary">
          {assignmentLabel(
            task.ownerPrincipalRef,
            principalNames,
            task.assignmentNeedsReassignment,
            task.assignmentWithoutLogin,
          )}
        </p>
      )}
      {assignmentAvailable && (
        <div className="flex flex-col gap-50" onFocus={rememberListField}>
          <taskForm.assigneeId
            disabled={fieldsDisabled}
            items={assigneeItems}
            label={t(`${key}.assignee`)}
            labelProps={dialogLabelProps}
            name="assignee"
            onOpenChange={onListOpenChange}
            placeholder={t(`${key}.unassigned`)}
            read={readNone}
            size="md"
            write={writeNone}
          />
          {assigneeMessage !== undefined && <StatusText status="error">{assigneeMessage}</StatusText>}
        </div>
      )}
      <taskForm.plannedHours
        disabled={fieldsDisabled}
        helpText={t(`${key}.plannedHoursHint`)}
        id="task-planned-hours"
        label={t(`${key}.plannedHours`)}
        max={10_000}
        min={0}
        step={0.5}
        type="number"
      />
      <taskForm.projectId
        disabled={fieldsDisabled}
        items={projectItems}
        label={t(`${key}.project`)}
        labelProps={dialogLabelProps}
        read={readNone}
        write={writeNone}
      />
      {!readOnly && (
        <TaskContextPickers
          disabled={fieldsDisabled}
          lookupAccess={lookupAccess}
          refs={values.contextRefs}
          renderPicker={(picker) => (
            <taskForm.contextRefs
              disabled={picker.disabled}
              id={picker.id}
              items={[...picker.items]}
              label={picker.label}
              labelProps={dialogLabelProps}
              read={picker.read}
              write={picker.write}
            />
          )}
        />
      )}
      {task !== undefined && task.contextRefs.length > 0 && (
        <div className="flex flex-col gap-100">
          <h3 className="font-semibold">{t(`${key}.sourceRecords`)}</h3>
          {task.contextRefs.map((ref) => (
            <Link href={taskContextHref(ref)} key={ref.resourceId} size="current">
              {t(`${key}.${contextLinkKey(ref)}`)}
            </Link>
          ))}
        </div>
      )}
      {/* Termín takes the full width: beside Priorita its year segment was clipped. */}
      <div onFocus={rememberListField}>
        <taskForm.dueDate
          clearable
          contentClassName={datePickerContentClass}
          disabled={fieldsDisabled}
          error={dueDateMessage}
          label={t(`${key}.dueDate`)}
          locale="cs-CZ"
          // No min/max here: the picker would show a clamped year (2000) while keeping the typed 0026, so the
          // field shows what was typed and the form explains the allowed years instead.
          onOpenChange={onListOpenChange}
          segmentsClassName={dateSegmentsClass}
          shouldForceLeadingZeros
          size="md"
          toDateValue={toCalendarDate}
          translations={datePickerTranslations}
        />
      </div>
      <div onFocus={rememberListField}>
        <taskForm.priority
          disabled={fieldsDisabled}
          items={priorityItems}
          label={t(`${key}.priority`)}
          labelProps={dialogLabelProps}
          name="priority"
          onOpenChange={onListOpenChange}
          placeholder={t('work-tasks.selectPlaceholder')}
          size="md"
        />
      </div>
      {task !== undefined && (
        <Link
          className="text-sm"
          href={`/cs/provoz/dokumenty?taskId=${encodeURIComponent(task.ref.resourceId)}`}
          size="current"
        >
          {t(`${key}.taskDocuments`)}
        </Link>
      )}
    </>
  );
};

const AddTaskCommentSchema = PlanningCommandSchema.pipe(Schema.toTaggedUnion('_tag')).cases.AddTaskComment;

/** A new comment, checked by the AddTaskComment payload's own text: Přidat komentář sends it trimmed. */
const commentForm = FormReact.make(fromPayload(AddTaskCommentSchema.mapFields(Struct.pick(['text']))), {
  fields: { text: TextAreaField },
  onSubmit: (_submit, { decoded }) => Effect.succeed(decoded.text),
  runtime: browserAtomRuntime,
});
const emptyComment = { text: '' };
const commentText = commentForm.getFieldAtoms(commentForm.fields.text).value.pipe(Atom.map(Option.getOrElse(() => '')));
const sendableComment = (text: string) => Option.isSome(Schema.decodeUnknownOption(commentForm.schema)({ text }));

/** Přidat komentář sends the comment once and empties the field for the next one. */
const CommentEntry = ({ busy, onComment }: { readonly busy: boolean; readonly onComment: (text: string) => void }) => {
  const { t } = useModernI18n();
  const text = useAtomValue(commentText);
  const setValues = useAtomSet(commentForm.setValues);
  useAtomSubscribe(
    commentForm.submit,
    (result) => {
      if (AsyncResult.isSuccess(result) && !result.waiting) {
        onComment(result.value);
        setValues(emptyComment);
      }
    },
    { immediate: false },
  );
  return (
    <FormRoot className="flex flex-col gap-100" defaultValues={emptyComment} form={commentForm} translateMessage={t}>
      <commentForm.text disabled={busy} id="task-comment" label={t(`${key}.newComment`)} maxLength={2000} />
      <SubmitButton disabled={busy || !sendableComment(text)} severity="secondary" size="sm">
        {t(`${key}.addComment`)}
      </SubmitButton>
    </FormRoot>
  );
};

const TaskComments = ({
  busy,
  onComment,
  principalNames,
  readOnly,
  task,
}: ResolvedTaskFormProps & { readonly task: Task }) => {
  const { t } = useModernI18n();
  return (
    <section className="flex flex-col gap-100 border-t border-border-primary pt-200">
      <h3 className="font-semibold">{t(`${key}.comments`)}</h3>
      {(task.comments ?? []).length === 0 && <p className="text-sm text-fg-secondary">{t(`${key}.noComments`)}</p>}
      {(task.comments ?? []).map((entry) => (
        <div className={`${surfaceTileClassName} p-150`} key={entry.id}>
          <p className="text-sm text-fg-secondary">
            {entry.authorDisplayName ??
              principalNames.get(principalKey(entry.authorPrincipalRef)) ??
              t(`${key}.teamMember`)}{' '}
            · {commentDateFormatter.format(DateTime.toDateUtc(entry.createdAt))}
          </p>
          <p className="whitespace-pre-wrap">{entry.text}</p>
        </div>
      ))}
      {!readOnly && onComment !== undefined && <CommentEntry busy={busy} onComment={onComment} />}
    </section>
  );
};

const TaskArchiveControl = ({ busy, onArchive, task }: ResolvedTaskFormProps) => {
  const { t } = useModernI18n();
  if (task === undefined || !isClosedTaskState(task.state) || onArchive === undefined) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-150">
      <Button
        appearance="outline"
        disabled={busy}
        onClick={() => onArchive(task.archivedAt === undefined)}
        severity="secondary"
        size="sm"
      >
        {t(task.archivedAt === undefined ? `${key}.archive` : `${key}.unarchive`)}
      </Button>
      {task.archivedAt === undefined && <span className="text-sm text-fg-secondary">{t(`${key}.archiveHint`)}</span>}
    </div>
  );
};

/** What the panel opens with for a new task. */
const emptyValues = initialValues();

/**
 * A new task's draft. Typing changes only the draft on screen; the Save button sends it once, and leaving with typed
 * input asks Uložit / Zahodit změny / Zůstat. An untouched panel closes without asking.
 */
const useCreateDraft = (props: ResolvedTaskFormProps) => {
  const { onClose, onCreate } = props;
  const { setReady, values } = useTaskValues(emptyValues);
  const record = useDraftSave<FormValues, never>({
    equals: sameFormValues,
    initial: emptyValues,
    isValid: (value) => Option.isSome(submissionOf(value, props)),
    runtime: browserRuntime,
    save: (value) =>
      Option.match(submissionOf(value, props), {
        onNone: () => Effect.succeed<SaveOutcome>('failed'),
        onSome: onCreate,
      }),
    value: values,
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: constVoid });
  const save = () => {
    record.save();
    // A created task, or one waiting for approval, leaves the panel; a failure keeps the draft.
    record.afterSave((status) => {
      if (status === 'saved' || status === 'proposed') {
        onClose();
      }
    });
  };
  useFieldMessages(record.status === 'invalid');
  const draft: TaskDraftState = {
    onReady: setReady,
    opened: emptyValues,
    requestClose: () => {
      guard.request(onClose);
    },
    showErrors: record.status === 'invalid',
    values,
  };
  return { draft, guard, record, save };
};

/**
 * An existing task's draft. Editing changes only the draft on screen; the Save button (or Enter in the title) sends
 * it against the revision it builds on, and a task that someone else changed meanwhile ends in a conflict that offers
 * the current version. Every way out of the panel asks first while something is unsaved.
 */
const useEditDraft = (props: ResolvedTaskFormProps & { readonly task: Task }) => {
  const { onClose, onSaveEdit, revision, task } = props;
  const record = useRecordDraft<FormValues, never>({
    equals: sameFormValues,
    isValid: (value) => Option.isSome(submissionOf(value, props)),
    revision,
    runtime: browserRuntime,
    save: (value, expectedRevision) =>
      Option.match(submissionOf(value, props), {
        onNone: () => Effect.succeed<RevisionedSaveResult>('failed'),
        onSome: (submission) => onSaveEdit(submission, expectedRevision),
      }),
    server: initialValues(task),
  });
  const { ready, setReady, values } = useTaskValues(record.draft);
  const setValues = useAtomSet(taskForm.setValues);
  const { setDraft } = record;
  // What the form shows is the draft.
  useAtomSubscribe(
    taskForm.values,
    (next) => {
      if (ready && Option.isSome(next)) {
        setDraft(next.value);
      }
    },
    { immediate: false },
  );
  // The draft also moves without typing (a live reread, Zahodit změny, the current version): the form follows it.
  const shown = useRef(record.draft);
  useEffect(() => {
    if (!ready || shown.current === record.draft) {
      return;
    }
    shown.current = record.draft;
    if (!sameFormValues(values, record.draft)) {
      setValues(record.draft);
    }
  }, [ready, record.draft, setValues, values]);
  // Browser Back and links ask the same question as Zavřít and the panel's own close button.
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: record.discard });
  useFieldMessages(record.status === 'invalid');
  const draft: TaskDraftState = {
    onReady: setReady,
    opened: record.draft,
    requestClose: () => {
      guard.request(onClose);
    },
    showErrors: true,
    values,
  };
  return { draft, guard, record };
};

/** The task panel around a draft; `status` is its save bar, last in the footer. */
const TaskPanel = ({
  draft,
  guard,
  props,
  status,
}: {
  readonly draft: TaskDraftState;
  /** The unsaved-changes guard: Escape, the close button and a click outside ask it first. */
  readonly guard: UnsavedChangesGuard;
  readonly props: ResolvedTaskFormProps;
  readonly status: ReactNode;
}) => {
  const { error, onClose, readOnly, task } = props;
  const { t } = useModernI18n();
  const form = useTaskForm(props, draft);
  const history = useTaskHistory(props);
  const { isEdit, locked, requestClose } = form;
  const handleReady = draft.onReady;
  // The title is the form's one payload check, so a message of the payload schema reads as the title's.
  const translateMessage = (message: string) => t(message, { defaultValue: t(`${key}.errors.title`) });
  return (
    <SidePanel
      actions={
        <>
          <Button appearance="outline" onClick={requestClose} severity="secondary">
            {t(isEdit || locked ? `${key}.close` : `${key}.cancel`)}
          </Button>
          {!locked && status}
        </>
      }
      guard={guard}
      // The first field takes focus, so typing starts at once.
      initialFocusEl={() => globalThis.document.querySelector<HTMLElement>('#task-title')}
      onOpenChange={(next) => {
        // The guard has already asked.
        if (!next) {
          onClose();
        }
      }}
      open
      resizeLabel={t('work-tasks.sidePanel.resize')}
      size="lg"
      title={readOnly ? 'Detail úkolu' : t(isEdit ? `${key}.edit` : `${key}.create`)}
    >
      <DocumentTitle title={task?.title} />
      <div className="flex flex-col gap-200 py-200">
        {error !== undefined && (
          <StatusText showIcon status="error">
            {error}
          </StatusText>
        )}
        {locked && <StatusText status="warning">{t(readOnly ? `${key}.readOnly` : `${key}.closedTask`)}</StatusText>}
        {task?.archivedAt !== undefined && <StatusText status="default">{t(`${key}.archivedNotice`)}</StatusText>}
        <TaskArchiveControl {...props} />
        <FormRoot
          className="flex flex-col gap-200"
          defaultValues={draft.opened}
          form={taskForm}
          translateMessage={translateMessage}
        >
          <FormReady onReady={handleReady} />
          <TaskFormFields {...props} form={form} />
        </FormRoot>
        {task !== undefined && <TaskComments {...props} task={task} />}
        {task !== undefined && (
          <ChangeHistory
            actorName={props.actorName}
            createdAt={task.createdAt}
            entries={task.history}
            fieldLabel={history.fieldLabel}
            formatValue={history.formatValue}
            updatedAt={task.updatedAt}
          />
        )}
      </div>
    </SidePanel>
  );
};

const TaskCreatePanel = ({ props }: { readonly props: ResolvedTaskFormProps }) => {
  const { language } = useModernI18n();
  const { draft, guard, record, save } = useCreateDraft(props);
  const labels = saveLabelsFor(language);
  const handleSave = save;
  const handleReloadLatest = constVoid;
  return (
    <>
      <TaskPanel
        draft={draft}
        guard={guard}
        props={props}
        status={
          <SaveBar labels={labels} onReloadLatest={handleReloadLatest} onSave={handleSave} status={record.status} />
        }
      />
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};

const TaskEditPanel = ({ props }: { readonly props: ResolvedTaskFormProps & { readonly task: Task } }) => {
  const { language } = useModernI18n();
  const { draft, guard, record } = useEditDraft(props);
  const labels = saveLabelsFor(language);
  const handleSave = record.save;
  const handleReloadLatest = record.reloadLatest;
  return (
    <>
      <TaskPanel
        draft={draft}
        guard={guard}
        props={props}
        status={
          <SaveBar labels={labels} onReloadLatest={handleReloadLatest} onSave={handleSave} status={record.status} />
        }
      />
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};

/** Create (`task` undefined) or edit one task in a right-hand panel; an edit is sent by its Save button only. */
export const TaskFormDialog = (input: TaskFormDialogProps) => {
  const { contextLabels = emptyContextLabels, projects = emptyProjects, readOnly = false, task } = input;
  const props = { ...input, contextLabels, projects, readOnly };
  return task === undefined ? <TaskCreatePanel props={props} /> : <TaskEditPanel props={{ ...props, task }} />;
};
