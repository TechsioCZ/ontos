import { StatusBadge } from '@app/admin-ui';
import type { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import type { ColumnDef } from '@techsio/ui-kit/organisms/data-table';
import type { LookupAccess, Task } from '../../../../shared/apis/records.ts';
import { PRIORITY_RANK, STATE_RANK, czechCollator, formatDueDate, isOverdue } from './tasks-model.ts';

const key = 'work-tasks.pages.records';

type Translate = ReturnType<typeof useModernI18n>['t'];

/** Which reference lists have settled (loaded or failed). Until then their cells show a loading label. */
export interface LookupState {
  readonly customers: boolean;
  readonly employees: boolean;
  readonly opportunities: boolean;
}

/** Czech text order for the name columns. Every text accessor below returns a string. */
const compareText = (left: string, right: string) => czechCollator.compare(left, right);

const loadingCell = (t: Translate) => <span className="text-fg-secondary">{t(`${key}.loadingNames`)}</span>;

/** The loaded name, a loading label while the list is pending, or a muted placeholder for an unknown id. */
const nameCell = (
  id: string | undefined,
  names: ReadonlyMap<string, string>,
  settled: boolean,
  t: Translate,
  unknownLabel: string,
) => {
  if (id === undefined) {
    return '—';
  }
  const name = names.get(id);
  if (name !== undefined) {
    return <span className="block truncate">{name}</span>;
  }
  return settled ? <span className="block truncate text-fg-secondary">{unknownLabel}</span> : loadingCell(t);
};

export const buildTaskColumns = ({
  customerNames,
  employeeNames,
  lookups,
  lookupAccess,
  opportunityTitles,
  t,
  today,
}: {
  readonly customerNames: ReadonlyMap<string, string>;
  readonly employeeNames: ReadonlyMap<string, string>;
  readonly lookups: LookupState;
  readonly lookupAccess: LookupAccess | undefined;
  readonly opportunityTitles: ReadonlyMap<string, string>;
  readonly t: Translate;
  readonly today: string;
}): ColumnDef<Task>[] => {
  const columns: ColumnDef<Task>[] = [
    // The widths total 760px: with the selection and sticky Akce columns they fit the 1280px layout, so Akce never
    // covers Stav.
    {
      accessorKey: 'title',
      cell: (info) => {
        const { opportunityId, title } = info.row.original;
        return (
          <span className="block min-w-0">
            <span className="block truncate font-medium">{title}</span>
            {opportunityId !== undefined && lookupAccess?.opportunities === 'allowed' && (
              <span className="block truncate text-xs text-fg-secondary">
                {opportunityTitles.get(opportunityId) ??
                  (lookups.opportunities ? t(`${key}.unknownOpportunity`) : t(`${key}.loadingNames`))}
              </span>
            )}
          </span>
        );
      },
      header: t(`${key}.columns.title`),
      meta: { width: 190 },
      sortFn: (rowA, rowB, columnId) => compareText(rowA.getValue<string>(columnId), rowB.getValue<string>(columnId)),
    },
    {
      accessorFn: (task) =>
        task.assigneeEmployeeId === undefined ? '' : (employeeNames.get(task.assigneeEmployeeId) ?? ''),
      cell: (info) => {
        const { assigneeEmployeeId } = info.row.original;
        if (assigneeEmployeeId === undefined) {
          return <span className="text-fg-secondary">{t(`${key}.unassigned`)}</span>;
        }
        if (!lookups.employees) {
          return loadingCell(t);
        }
        return <span className="block truncate">{employeeNames.get(assigneeEmployeeId) ?? '—'}</span>;
      },
      header: t(`${key}.columns.assignee`),
      id: 'assignee',
      meta: { width: 125 },
      sortFn: (rowA, rowB, columnId) => compareText(rowA.getValue<string>(columnId), rowB.getValue<string>(columnId)),
    },
    {
      accessorFn: (task) => (task.partyId === undefined ? '' : (customerNames.get(task.partyId) ?? '')),
      cell: (info) =>
        nameCell(info.row.original.partyId, customerNames, lookups.customers, t, t(`${key}.unknownCustomer`)),
      header: t(`${key}.columns.party`),
      id: 'party',
      meta: { width: 130 },
      sortFn: (rowA, rowB, columnId) => compareText(rowA.getValue<string>(columnId), rowB.getValue<string>(columnId)),
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
      meta: { width: 100 },
      // Tasks without a date sort last in both directions.
      sortUndefined: 'last',
    },
    {
      accessorFn: (task) => PRIORITY_RANK[task.priority],
      cell: (info) => <StatusBadge kind="priority" value={info.row.original.priority} />,
      header: t(`${key}.columns.priority`),
      id: 'priority',
      meta: { width: 95 },
    },
    {
      accessorFn: (task) => STATE_RANK[task.state],
      cell: (info) => <StatusBadge kind="task" value={info.row.original.state} />,
      header: t(`${key}.columns.state`),
      id: 'state',
      meta: { width: 120 },
    },
  ];
  return columns.filter(
    (column) =>
      (column.id !== 'assignee' || lookupAccess?.employees === 'allowed') &&
      (column.id !== 'party' || lookupAccess?.customers === 'allowed'),
  );
};
