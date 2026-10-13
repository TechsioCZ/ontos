import { StatusBadge } from '@app/admin-ui';
import type { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import type { ColumnDef } from '@techsio/ui-kit/organisms/data-table';
import type { Task } from '../../../../../shared/apis/records.ts';
import { formatDueDate, isOverdue } from './tasks-model.ts';

const key = 'siampark-work.pages.records';

type Translate = ReturnType<typeof useModernI18n>['t'];

/** The loaded name, or a muted placeholder when the id has no name in the loaded list. */
const nameCell = (id: string | undefined, names: ReadonlyMap<string, string>, unknownLabel: string) => {
  if (id === undefined) {
    return '—';
  }
  const name = names.get(id);
  return name === undefined ? (
    <span className="block truncate text-fg-secondary">{unknownLabel}</span>
  ) : (
    <span className="block truncate">{name}</span>
  );
};

export const buildTaskColumns = ({
  customerNames,
  employeeNames,
  opportunityTitles,
  t,
  today,
}: {
  readonly customerNames: ReadonlyMap<string, string>;
  readonly employeeNames: ReadonlyMap<string, string>;
  readonly opportunityTitles: ReadonlyMap<string, string>;
  readonly t: Translate;
  readonly today: string;
}): ColumnDef<Task>[] => [
  {
    accessorKey: 'title',
    cell: (info) => {
      const { opportunityId, title } = info.row.original;
      return (
        <span className="block min-w-0">
          <span className="block truncate font-medium">{title}</span>
          {opportunityId !== undefined && (
            <span className="block truncate text-xs text-fg-secondary">
              {opportunityTitles.get(opportunityId) ?? t(`${key}.unknownOpportunity`)}
            </span>
          )}
        </span>
      );
    },
    header: t(`${key}.columns.title`),
    meta: { width: 230 },
  },
  {
    accessorFn: (task) =>
      task.assigneeEmployeeId === undefined ? '' : (employeeNames.get(task.assigneeEmployeeId) ?? ''),
    cell: (info) => {
      const { assigneeEmployeeId } = info.row.original;
      if (assigneeEmployeeId === undefined) {
        return <span className="text-fg-secondary">{t(`${key}.unassigned`)}</span>;
      }
      return <span className="block truncate">{employeeNames.get(assigneeEmployeeId) ?? '—'}</span>;
    },
    header: t(`${key}.columns.assignee`),
    id: 'assignee',
    meta: { width: 140 },
  },
  {
    accessorFn: (task) => (task.partyId === undefined ? '' : (customerNames.get(task.partyId) ?? '')),
    cell: (info) => nameCell(info.row.original.partyId, customerNames, t(`${key}.unknownCustomer`)),
    header: t(`${key}.columns.party`),
    id: 'party',
    meta: { width: 150 },
  },
  {
    accessorKey: 'dueDate',
    cell: (info) => {
      const task = info.row.original;
      if (task.dueDate === undefined) {
        return '—';
      }
      const label = formatDueDate(task.dueDate);
      return isOverdue(task, today) ? (
        <span className="text-fg-accent-danger whitespace-nowrap tabular-nums">{label}</span>
      ) : (
        <span className="whitespace-nowrap tabular-nums">{label}</span>
      );
    },
    header: t(`${key}.columns.dueDate`),
    meta: { width: 110 },
  },
  {
    accessorKey: 'priority',
    cell: (info) => <StatusBadge kind="priority" value={info.row.original.priority} />,
    header: t(`${key}.columns.priority`),
    meta: { width: 95 },
  },
  {
    accessorKey: 'state',
    cell: (info) => <StatusBadge kind="task" value={info.row.original.state} />,
    header: t(`${key}.columns.state`),
    meta: { width: 120 },
  },
];
