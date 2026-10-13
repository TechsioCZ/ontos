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

/** Customer and opportunity show the stored id until their name sources are wired into this page. */
const idCell = (id: string | undefined) =>
  id === undefined ? '—' : <span className="block truncate text-fg-secondary text-xs">{id}</span>;

export const buildTaskColumns = ({
  employeeNames,
  referenceDate,
  t,
}: {
  readonly employeeNames: ReadonlyMap<string, string>;
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
    accessorKey: 'partyId',
    cell: (info) => idCell(info.row.original.partyId),
    header: t(`${key}.columns.party`),
    meta: { width: 170 },
  },
  {
    accessorKey: 'opportunityId',
    cell: (info) => idCell(info.row.original.opportunityId),
    header: t(`${key}.columns.opportunity`),
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
