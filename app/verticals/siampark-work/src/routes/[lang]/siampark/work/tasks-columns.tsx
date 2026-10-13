import type { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import type { ColumnDef } from '@techsio/ui-kit/organisms/data-table';
import type { Task } from '../../../../../shared/apis/records.ts';
import { formatDueDate, isOverdue } from './tasks-model.ts';

const key = 'siampark-work.pages.records';
const stateVariant = {
  CANCELLED: 'outline',
  DONE: 'success',
  IN_PROGRESS: 'info',
  NEW: 'outline',
  WAITING: 'warning',
} as const;
const priorityVariant = { HIGH: 'danger', LOW: 'outline', NORMAL: 'outline' } as const;

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
  referenceDate,
  t,
}: {
  readonly customerNames: ReadonlyMap<string, string>;
  readonly employeeNames: ReadonlyMap<string, string>;
  readonly opportunityTitles: ReadonlyMap<string, string>;
  readonly referenceDate: string;
  readonly t: Translate;
}): ColumnDef<Task>[] => [
  {
    accessorKey: 'title',
    cell: (info) => <span className="block truncate font-medium">{info.row.original.title}</span>,
    header: t(`${key}.columns.title`),
    meta: { width: 300 },
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
    meta: { width: 180 },
  },
  {
    accessorFn: (task) => (task.partyId === undefined ? '' : (customerNames.get(task.partyId) ?? '')),
    cell: (info) => nameCell(info.row.original.partyId, customerNames, t(`${key}.unknownCustomer`)),
    header: t(`${key}.columns.party`),
    id: 'party',
    meta: { width: 170 },
  },
  {
    accessorFn: (task) => (task.opportunityId === undefined ? '' : (opportunityTitles.get(task.opportunityId) ?? '')),
    cell: (info) => nameCell(info.row.original.opportunityId, opportunityTitles, t(`${key}.unknownOpportunity`)),
    header: t(`${key}.columns.opportunity`),
    id: 'opportunity',
    meta: { width: 170 },
  },
  {
    accessorKey: 'dueDate',
    cell: (info) => {
      const task = info.row.original;
      if (task.dueDate === undefined) {
        return '—';
      }
      const label = formatDueDate(task.dueDate);
      return isOverdue(task, referenceDate) ? (
        <Badge size="sm" variant="danger">
          {label}
        </Badge>
      ) : (
        <span className="tabular-nums">{label}</span>
      );
    },
    header: t(`${key}.columns.dueDate`),
    meta: { width: 140 },
  },
  {
    accessorKey: 'priority',
    cell: (info) => (
      <Badge size="sm" variant={priorityVariant[info.row.original.priority]}>
        {t(`${key}.priorities.${info.row.original.priority}`)}
      </Badge>
    ),
    header: t(`${key}.columns.priority`),
    meta: { width: 130 },
  },
  {
    accessorKey: 'state',
    cell: (info) => (
      <Badge size="sm" variant={stateVariant[info.row.original.state]}>
        {t(`${key}.states.${info.row.original.state}`)}
      </Badge>
    ),
    header: t(`${key}.columns.state`),
    meta: { width: 150 },
  },
  {
    cell: () => null,
    enableSorting: false,
    header: t(`${key}.columns.labels`),
    id: 'labels',
    meta: { width: 140 },
  },
];
