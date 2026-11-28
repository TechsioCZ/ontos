import { BulkActionBar } from '@app/admin-ui';
import {
  CheckboxField,
  FormBuilder,
  FormReact,
  FormRoot,
  SelectTemplateField,
  TextField,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { assignmentOptions } from './assignment-options.ts';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Effect, Option, Schema } from 'effect';
import { useEffect, useRef } from 'react';
import { TaskPrioritySchema, TaskStateSchema } from '../../../../shared/apis/records.ts';
import type { AssignmentPrincipal, TaskState } from '../../../../shared/apis/records.ts';
import { browserAtomRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { DueFilterSchema, TASK_STATE_ORDER, selectOption } from './tasks-model.ts';
import type { ObjectOption, TaskFilters } from './tasks-model.ts';

const SELECT_PLACEHOLDER = 'work-tasks.selectPlaceholder';

const key = 'work-tasks.pages.records';
const ALL = 'all';
const NONE = 'none';
const DUE_OPTIONS = ['overdue', 'today', 'none'] as const;
const PRIORITY_OPTIONS = ['LOW', 'NORMAL', 'HIGH'] as const;
// Select labels take the filter row's label size, the same size FormInput uses for "Hledat úkol".
const filterLabelProps = { className: 'font-label text-label-sm' };
// The bulk bar shows placeholders only; its Select labels exist for screen readers, so each trigger has a name.
const bulkLabelProps = { className: 'sr-only' };

/** The filters of the task list: they narrow what the list shows and are never submitted. */
const filterForm = FormReact.make(
  FormBuilder.empty
    .addField('assignee', Schema.String)
    .addField('due', Schema.String)
    .addField('dueFrom', Schema.String)
    .addField('dueTo', Schema.String)
    .addField('object', Schema.String)
    .addField('priority', Schema.String)
    .addField('search', Schema.String)
    .addField('showHidden', Schema.Boolean)
    .addField('state', Schema.String),
  {
    fields: {
      assignee: SelectTemplateField,
      due: SelectTemplateField,
      dueFrom: TextField,
      dueTo: TextField,
      object: SelectTemplateField,
      priority: SelectTemplateField,
      search: TextField,
      showHidden: CheckboxField,
      state: SelectTemplateField,
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);
type FilterValues = typeof filterForm.schema.Encoded;

const isDue = Schema.is(DueFilterSchema);
const isPriority = Schema.is(Schema.Union([Schema.Literal(ALL), TaskPrioritySchema]));
const isState = Schema.is(Schema.Union([Schema.Literal(ALL), TaskStateSchema]));

/** The filters the form asks for; a choice the list does not know, or a cleared list, keeps the current one. */
const filtersOf = (values: FilterValues, current: TaskFilters): TaskFilters => ({
  assignee: values.assignee === '' ? current.assignee : values.assignee,
  due: isDue(values.due) ? values.due : current.due,
  dueFrom: values.dueFrom,
  dueTo: values.dueTo,
  object: values.object === '' ? current.object : values.object,
  priority: isPriority(values.priority) ? values.priority : current.priority,
  search: values.search,
  state: isState(values.state) ? values.state : current.state,
});

const sameValues = (left: FilterValues, right: FilterValues): boolean =>
  left.assignee === right.assignee &&
  left.due === right.due &&
  left.dueFrom === right.dueFrom &&
  left.dueTo === right.dueTo &&
  left.object === right.object &&
  left.priority === right.priority &&
  left.search === right.search &&
  left.showHidden === right.showHidden &&
  left.state === right.state;

/**
 * Keeps the form and the page's filters together: a change in the form asks the page for it, and filters the page
 * sets by itself (Vymazat filtry, a task opened by its link, the saved view) show in the form.
 */
const FilterSync = ({
  filters,
  onChange,
  onShowHiddenChange,
  shown,
}: {
  readonly filters: TaskFilters;
  readonly onChange: (next: TaskFilters) => void;
  readonly onShowHiddenChange: ((next: boolean) => void) | undefined;
  readonly shown: FilterValues;
}) => {
  const values = useAtomValue(filterForm.values);
  const setValues = useAtomSet(filterForm.setValues);
  useAtomSubscribe(
    filterForm.values,
    (next) => {
      if (Option.isNone(next)) {
        return;
      }
      const asked = filtersOf(next.value, filters);
      if (!sameValues({ ...asked, showHidden: shown.showHidden }, shown)) {
        onChange(asked);
      }
      if (next.value.showHidden !== shown.showHidden) {
        onShowHiddenChange?.(next.value.showHidden);
      }
    },
    { immediate: false },
  );
  const page = useRef(shown);
  useEffect(() => {
    if (sameValues(page.current, shown)) {
      return;
    }
    page.current = shown;
    if (Option.exists(values, (current) => !sameValues(current, shown))) {
      setValues(shown);
    }
  }, [setValues, shown, values]);
  return null;
};

export const TaskFilterBar = ({
  active,
  canAssign,
  filters,
  objects,
  onChange,
  onClear,
  onShowHiddenChange,
  principals,
  showHidden,
}: {
  readonly active: boolean;
  readonly canAssign: boolean;
  readonly filters: TaskFilters;
  /** Properties and units for the Objekt filter; undefined when the property directory is not available. */
  readonly objects: readonly ObjectOption[] | undefined;
  readonly onChange: (next: TaskFilters) => void;
  readonly onClear: () => void;
  readonly onShowHiddenChange?: ((next: boolean) => void) | undefined;
  readonly principals: readonly AssignmentPrincipal[];
  readonly showHidden: boolean;
}) => {
  const { t } = useModernI18n();
  const rangeInverted = filters.dueFrom !== '' && filters.dueTo !== '' && filters.dueFrom > filters.dueTo;
  const shown: FilterValues = { ...filters, showHidden };
  return (
    // `contents`: the filter row and its range message stay laid out by the page, as before the form.
    <FormRoot className="contents" defaultValues={shown} form={filterForm} translateMessage={t}>
      <FilterSync filters={filters} onChange={onChange} onShowHiddenChange={onShowHiddenChange} shown={shown} />
      <div className="flex flex-wrap items-end gap-150">
        <div className="w-64 min-w-0">
          <filterForm.search id="task-search" label={t(`${key}.filters.search`)} size="sm" />
        </div>
        {canAssign && (
          <div className="w-48 min-w-0">
            <filterForm.assignee
              items={[
                selectOption(t(`${key}.filters.allAssignees`), ALL),
                selectOption(t(`${key}.unassigned`), NONE),
                ...assignmentOptions(principals),
              ]}
              label={t(`${key}.filters.assignee`)}
              labelProps={filterLabelProps}
              placeholder={t(SELECT_PLACEHOLDER)}
              size="sm"
            />
          </div>
        )}
        <div className="w-48 min-w-0">
          <filterForm.due
            items={[
              selectOption(t(`${key}.filters.all`), ALL),
              ...DUE_OPTIONS.map((value) => selectOption(t(`${key}.filters.dueOptions.${value}`), value)),
            ]}
            label={t(`${key}.filters.due`)}
            labelProps={filterLabelProps}
            placeholder={t(SELECT_PLACEHOLDER)}
            size="sm"
          />
        </div>
        <div className="w-48 min-w-0">
          <filterForm.state
            items={[
              selectOption(t(`${key}.filters.all`), ALL),
              ...TASK_STATE_ORDER.map((value) => selectOption(t(`${key}.states.${value}`), value)),
            ]}
            label={t(`${key}.filters.state`)}
            labelProps={filterLabelProps}
            placeholder={t(SELECT_PLACEHOLDER)}
            size="sm"
          />
        </div>
        <div className="w-48 min-w-0">
          <filterForm.priority
            items={[
              selectOption(t(`${key}.filters.all`), ALL),
              ...PRIORITY_OPTIONS.map((value) => selectOption(t(`${key}.priorities.${value}`), value)),
            ]}
            label={t(`${key}.filters.priority`)}
            labelProps={filterLabelProps}
            placeholder={t(SELECT_PLACEHOLDER)}
            size="sm"
          />
        </div>
        {objects !== undefined && (
          <div className="w-64 min-w-0">
            <filterForm.object
              items={[
                selectOption(t(`${key}.filters.allObjects`), ALL),
                ...objects.map((item) => selectOption(item.label, item.id)),
                // A saved view can name an object the directory no longer lists; keep it selectable to clear it.
                ...(filters.object === ALL || objects.some((item) => item.id === filters.object)
                  ? []
                  : [selectOption(t(`${key}.savedContext`), filters.object)]),
              ]}
              label={t(`${key}.filters.object`)}
              labelProps={filterLabelProps}
              placeholder={t(SELECT_PLACEHOLDER)}
              size="sm"
            />
          </div>
        )}
        <div className="w-40 min-w-0">
          <filterForm.dueFrom
            id="task-due-from"
            label={t(`${key}.filters.dueFrom`)}
            max={filters.dueTo === '' ? undefined : filters.dueTo}
            size="sm"
            type="date"
          />
        </div>
        <div className="w-40 min-w-0">
          <filterForm.dueTo
            id="task-due-to"
            label={t(`${key}.filters.dueTo`)}
            min={filters.dueFrom === '' ? undefined : filters.dueFrom}
            size="sm"
            type="date"
          />
        </div>
        {onShowHiddenChange !== undefined && (
          <div className="pb-100 text-sm">
            <filterForm.showHidden label={t(`${key}.filters.showHidden`)} />
          </div>
        )}
        {active && (
          <Button appearance="outline" onClick={onClear} severity="secondary" size="sm" type="button">
            {t(`${key}.filters.clear`)}
          </Button>
        )}
      </div>
      {rangeInverted && <output className="text-sm text-danger">{t(`${key}.filters.rangeInverted`)}</output>}
    </FormRoot>
  );
};

/** The bulk bar's choices act at once: each sends its command and the list shows its placeholder again. */
const bulkForm = FormReact.make(
  FormBuilder.empty.addField('assignee', Schema.String).addField('state', Schema.String),
  {
    fields: { assignee: SelectTemplateField, state: SelectTemplateField },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);
const noBulkChoice = { assignee: '', state: '' };
const bulkAssignee = bulkForm.getFieldAtoms(bulkForm.fields.assignee);
const bulkState = bulkForm.getFieldAtoms(bulkForm.fields.state);
const isTaskState = Schema.is(TaskStateSchema);

const BulkChoices = ({
  busy,
  canAssign,
  onAssign,
  onChangeState,
  principals,
  targets,
}: {
  readonly busy: boolean;
  readonly canAssign: boolean;
  readonly onAssign: (value: string) => void;
  readonly onChangeState: (state: TaskState) => void;
  readonly principals: readonly AssignmentPrincipal[];
  readonly targets: readonly TaskState[];
}) => {
  const { t } = useModernI18n();
  const setAssignee = useAtomSet(bulkAssignee.setValue);
  const setState = useAtomSet(bulkState.setValue);
  useAtomSubscribe(
    bulkState.value,
    (next) => {
      if (Option.isSome(next) && next.value !== '') {
        setState('');
        if (isTaskState(next.value)) {
          onChangeState(next.value);
        }
      }
    },
    { immediate: false },
  );
  useAtomSubscribe(
    bulkAssignee.value,
    (next) => {
      if (Option.isSome(next) && next.value !== '') {
        setAssignee('');
        onAssign(next.value);
      }
    },
    { immediate: false },
  );
  const targetSet = new Set<TaskState>(targets);
  return (
    <>
      <bulkForm.state
        disabled={busy || targets.length === 0}
        items={TASK_STATE_ORDER.flatMap((value) =>
          targetSet.has(value) ? [selectOption(t(`${key}.states.${value}`), value)] : [],
        )}
        label={t(`${key}.bulk.changeState`)}
        labelProps={bulkLabelProps}
        placeholder={t(`${key}.bulk.changeState`)}
        size="sm"
      />
      {canAssign && (
        <bulkForm.assignee
          disabled={busy}
          items={[selectOption(t(`${key}.unassigned`), NONE), ...assignmentOptions(principals)]}
          label={t(`${key}.bulk.assign`)}
          labelProps={bulkLabelProps}
          placeholder={t(`${key}.bulk.assign`)}
          size="sm"
        />
      )}
    </>
  );
};

export const TaskBulkBar = ({
  busy,
  canAssign,
  count,
  onAssign,
  onChangeState,
  onClear,
  principals,
  targets,
}: {
  readonly busy: boolean;
  readonly canAssign: boolean;
  readonly count: number;
  readonly onAssign: (value: string) => void;
  readonly onChangeState: (state: TaskState) => void;
  readonly onClear: () => void;
  readonly principals: readonly AssignmentPrincipal[];
  /** States every selected task can move to. Options outside this list are not offered. */
  readonly targets: readonly TaskState[];
}) => {
  const { t } = useModernI18n();
  return (
    <BulkActionBar onClear={onClear} selectedCount={count}>
      {busy && <output className="text-fg-secondary text-sm">{t(`${key}.bulk.busy`)}</output>}
      <FormRoot className="contents" defaultValues={noBulkChoice} form={bulkForm} translateMessage={t}>
        <BulkChoices
          busy={busy}
          canAssign={canAssign}
          onAssign={onAssign}
          onChangeState={onChangeState}
          principals={principals}
          targets={targets}
        />
      </FormRoot>
    </BulkActionBar>
  );
};
