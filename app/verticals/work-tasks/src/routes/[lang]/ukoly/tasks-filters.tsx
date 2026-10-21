import { BulkActionBar } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import type { Employee } from '@app/workforce/contracts/records';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { Schema } from 'effect';
import { TaskPrioritySchema, TaskStateSchema } from '../../../../shared/apis/records.ts';
import type { TaskState } from '../../../../shared/apis/records.ts';
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

const employeeItems = (employees: readonly Employee[]) =>
  employees.map((employee) => selectOption(employee.fullName, employee.id));

export const TaskFilterBar = ({
  active,
  employees,
  canAssign,
  filters,
  objects,
  onChange,
  onClear,
  onShowHiddenChange,
  showHidden,
}: {
  readonly active: boolean;
  readonly employees: readonly Employee[];
  readonly canAssign: boolean;
  readonly filters: TaskFilters;
  /** Properties and units for the Objekt filter; undefined when the property directory is not available. */
  readonly objects: readonly ObjectOption[] | undefined;
  readonly onChange: (next: TaskFilters) => void;
  readonly onClear: () => void;
  readonly onShowHiddenChange?: ((next: boolean) => void) | undefined;
  readonly showHidden: boolean;
}) => {
  const { t } = useModernI18n();
  const rangeInverted = filters.dueFrom !== '' && filters.dueTo !== '' && filters.dueFrom > filters.dueTo;
  return (
    <>
      <div className="flex flex-wrap items-end gap-150">
        <div className="w-64 min-w-0">
          <FormInput
            id="task-search"
            label={t(`${key}.filters.search`)}
            onChange={(event) => onChange({ ...filters, search: event.target.value })}
            size="sm"
            value={filters.search}
          />
        </div>
        {canAssign && (
          <div className="w-48 min-w-0">
            <Select
              items={[
                selectOption(t(`${key}.filters.allAssignees`), ALL),
                selectOption(t(`${key}.unassigned`), NONE),
                ...employeeItems(employees),
              ]}
              label={t(`${key}.filters.assignee`)}
              labelProps={filterLabelProps}
              onValueChange={({ value }) => {
                const [next] = value;
                if (next !== undefined) {
                  onChange({ ...filters, assignee: next });
                }
              }}
              placeholder={t(SELECT_PLACEHOLDER)}
              size="sm"
              value={[filters.assignee]}
            />
          </div>
        )}
        <div className="w-48 min-w-0">
          <Select
            items={[
              selectOption(t(`${key}.filters.all`), ALL),
              ...DUE_OPTIONS.map((value) => selectOption(t(`${key}.filters.dueOptions.${value}`), value)),
            ]}
            label={t(`${key}.filters.due`)}
            labelProps={filterLabelProps}
            onValueChange={({ value }) => {
              const [next] = value;
              if (Schema.is(DueFilterSchema)(next)) {
                onChange({ ...filters, due: next });
              }
            }}
            placeholder={t(SELECT_PLACEHOLDER)}
            size="sm"
            value={[filters.due]}
          />
        </div>
        <div className="w-48 min-w-0">
          <Select
            items={[
              selectOption(t(`${key}.filters.all`), ALL),
              ...TASK_STATE_ORDER.map((value) => selectOption(t(`${key}.states.${value}`), value)),
            ]}
            label={t(`${key}.filters.state`)}
            labelProps={filterLabelProps}
            onValueChange={({ value }) => {
              const [next] = value;
              if (next === ALL) {
                onChange({ ...filters, state: ALL });
              } else if (Schema.is(TaskStateSchema)(next)) {
                onChange({ ...filters, state: next });
              }
            }}
            placeholder={t(SELECT_PLACEHOLDER)}
            size="sm"
            value={[filters.state]}
          />
        </div>
        <div className="w-48 min-w-0">
          <Select
            items={[
              selectOption(t(`${key}.filters.all`), ALL),
              ...PRIORITY_OPTIONS.map((value) => selectOption(t(`${key}.priorities.${value}`), value)),
            ]}
            label={t(`${key}.filters.priority`)}
            labelProps={filterLabelProps}
            onValueChange={({ value }) => {
              const [next] = value;
              if (next === ALL) {
                onChange({ ...filters, priority: ALL });
              } else if (Schema.is(TaskPrioritySchema)(next)) {
                onChange({ ...filters, priority: next });
              }
            }}
            placeholder={t(SELECT_PLACEHOLDER)}
            size="sm"
            value={[filters.priority]}
          />
        </div>
        {objects !== undefined && (
          <div className="w-64 min-w-0">
            <Select
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
              onValueChange={({ value }) => {
                const [next] = value;
                if (next !== undefined) {
                  onChange({ ...filters, object: next });
                }
              }}
              placeholder={t(SELECT_PLACEHOLDER)}
              size="sm"
              value={[filters.object]}
            />
          </div>
        )}
        <div className="w-40 min-w-0">
          <FormInput
            id="task-due-from"
            label={t(`${key}.filters.dueFrom`)}
            max={filters.dueTo === '' ? undefined : filters.dueTo}
            onChange={(event) => onChange({ ...filters, dueFrom: event.target.value })}
            size="sm"
            type="date"
            value={filters.dueFrom}
          />
        </div>
        <div className="w-40 min-w-0">
          <FormInput
            id="task-due-to"
            label={t(`${key}.filters.dueTo`)}
            min={filters.dueFrom === '' ? undefined : filters.dueFrom}
            onChange={(event) => onChange({ ...filters, dueTo: event.target.value })}
            size="sm"
            type="date"
            value={filters.dueTo}
          />
        </div>
        {onShowHiddenChange !== undefined && (
          <label className="flex items-center gap-100 pb-100 text-sm">
            <input
              checked={showHidden}
              onChange={(event) => onShowHiddenChange(event.target.checked)}
              type="checkbox"
            />
            {t(`${key}.filters.showHidden`)}
          </label>
        )}
        {active && (
          <Button onClick={onClear} size="sm" theme="outlined" variant="secondary">
            {t(`${key}.filters.clear`)}
          </Button>
        )}
      </div>
      {rangeInverted && (
        <p className="text-sm text-fg-error" role="status">
          {t(`${key}.filters.rangeInverted`)}
        </p>
      )}
    </>
  );
};

export const TaskBulkBar = ({
  busy,
  count,
  employees,
  canAssign,
  onAssign,
  onChangeState,
  onClear,
  targets,
}: {
  readonly busy: boolean;
  readonly count: number;
  readonly employees: readonly Employee[];
  readonly canAssign: boolean;
  readonly onAssign: (value: string) => void;
  readonly onChangeState: (state: TaskState) => void;
  readonly onClear: () => void;
  /** States every selected task can move to. Options outside this list are not offered. */
  readonly targets: readonly TaskState[];
}) => {
  const { t } = useModernI18n();
  const targetSet = new Set<TaskState>(targets);
  return (
    <BulkActionBar onClear={onClear} selectedCount={count}>
      {busy && <output className="text-fg-secondary text-sm">{t(`${key}.bulk.busy`)}</output>}
      <Select
        disabled={busy || targets.length === 0}
        items={TASK_STATE_ORDER.flatMap((value) =>
          targetSet.has(value) ? [selectOption(t(`${key}.states.${value}`), value)] : [],
        )}
        label={t(`${key}.bulk.changeState`)}
        labelProps={bulkLabelProps}
        onValueChange={({ value }) => {
          const [next] = value;
          if (Schema.is(TaskStateSchema)(next)) {
            onChangeState(next);
          }
        }}
        placeholder={t(`${key}.bulk.changeState`)}
        size="sm"
        value={[]}
      />
      {canAssign && (
        <Select
          disabled={busy}
          items={[selectOption(t(`${key}.unassigned`), NONE), ...employeeItems(employees)]}
          label={t(`${key}.bulk.assign`)}
          labelProps={bulkLabelProps}
          onValueChange={({ value }) => {
            const [next] = value;
            if (next !== undefined) {
              onAssign(next);
            }
          }}
          placeholder={t(`${key}.bulk.assign`)}
          size="sm"
          value={[]}
        />
      )}
    </BulkActionBar>
  );
};
