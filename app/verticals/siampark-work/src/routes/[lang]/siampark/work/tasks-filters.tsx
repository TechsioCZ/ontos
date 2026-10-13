import { BulkActionBar } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import type { Employee } from '@app/workforce/contracts/records';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { Schema } from 'effect';
import { TaskPrioritySchema, TaskStateSchema } from '../../../../../shared/apis/records.ts';
import type { TaskFilters } from './tasks-model.ts';

const key = 'siampark-work.pages.records';
const ALL = 'all';
const NONE = 'none';
const STATE_OPTIONS = ['NEW', 'IN_PROGRESS', 'WAITING', 'DONE', 'CANCELLED'] as const;
const PRIORITY_OPTIONS = ['LOW', 'NORMAL', 'HIGH'] as const;

const employeeItems = (employees: readonly Employee[]) =>
  employees.map((employee) => ({ label: employee.fullName, value: employee.id }));

export const TaskFilterBar = ({
  employees,
  filters,
  onChange,
}: {
  readonly employees: readonly Employee[];
  readonly filters: TaskFilters;
  readonly onChange: (next: TaskFilters) => void;
}) => {
  const { t } = useModernI18n();
  return (
    <div className="flex flex-wrap items-end gap-150">
      <FormInput
        id="task-search"
        label={t(`${key}.filters.search`)}
        onChange={(event) => onChange({ ...filters, search: event.target.value })}
        value={filters.search}
      />
      <Select
        items={[
          { label: t(`${key}.filters.allAssignees`), value: ALL },
          { label: t(`${key}.unassigned`), value: NONE },
          ...employeeItems(employees),
        ]}
        label={t(`${key}.filters.assignee`)}
        onValueChange={({ value }) => {
          const [next] = value;
          if (next !== undefined) {
            onChange({ ...filters, assignee: next });
          }
        }}
        size="sm"
        value={[filters.assignee]}
      />
      <Select
        items={[
          { label: t(`${key}.filters.all`), value: ALL },
          ...STATE_OPTIONS.map((value) => ({ label: t(`${key}.states.${value}`), value })),
        ]}
        label={t(`${key}.filters.state`)}
        onValueChange={({ value }) => {
          const [next] = value;
          if (next === ALL) {
            onChange({ ...filters, state: ALL });
          } else if (Schema.is(TaskStateSchema)(next)) {
            onChange({ ...filters, state: next });
          }
        }}
        size="sm"
        value={[filters.state]}
      />
      <Select
        items={[
          { label: t(`${key}.filters.all`), value: ALL },
          ...PRIORITY_OPTIONS.map((value) => ({ label: t(`${key}.priorities.${value}`), value })),
        ]}
        label={t(`${key}.filters.priority`)}
        onValueChange={({ value }) => {
          const [next] = value;
          if (next === ALL) {
            onChange({ ...filters, priority: ALL });
          } else if (Schema.is(TaskPrioritySchema)(next)) {
            onChange({ ...filters, priority: next });
          }
        }}
        size="sm"
        value={[filters.priority]}
      />
    </div>
  );
};

export const TaskBulkBar = ({
  busy,
  count,
  employees,
  onAssign,
  onChangeState,
  onClear,
}: {
  readonly busy: boolean;
  readonly count: number;
  readonly employees: readonly Employee[];
  readonly onAssign: (value: string) => void;
  readonly onChangeState: (state: (typeof STATE_OPTIONS)[number]) => void;
  readonly onClear: () => void;
}) => {
  const { t } = useModernI18n();
  return (
    <BulkActionBar onClear={onClear} selectedCount={count}>
      <Select
        disabled={busy}
        items={STATE_OPTIONS.map((value) => ({ label: t(`${key}.states.${value}`), value }))}
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
      <Select
        disabled={busy}
        items={[{ label: t(`${key}.unassigned`), value: NONE }, ...employeeItems(employees)]}
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
    </BulkActionBar>
  );
};
