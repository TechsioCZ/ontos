import { BulkActionBar } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import type { Employee } from '@app/workforce/contracts/records';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { Schema } from 'effect';
import { TaskPrioritySchema, TaskStateSchema } from '../../../../../shared/apis/records.ts';
import type { TaskState } from '../../../../../shared/apis/records.ts';
import { DueFilterSchema, TASK_STATE_ORDER, selectOption } from './tasks-model.ts';
import type { TaskFilters } from './tasks-model.ts';

const SELECT_PLACEHOLDER = 'siampark-work.selectPlaceholder';

const key = 'siampark-work.pages.records';
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
  onChange,
  onClear,
}: {
  readonly active: boolean;
  readonly employees: readonly Employee[];
  readonly canAssign: boolean;
  readonly filters: TaskFilters;
  readonly onChange: (next: TaskFilters) => void;
  readonly onClear: () => void;
}) => {
  const { t } = useModernI18n();
  return (
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
      {active && (
        <Button onClick={onClear} size="sm" theme="outlined" variant="secondary">
          {t(`${key}.filters.clear`)}
        </Button>
      )}
    </div>
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
