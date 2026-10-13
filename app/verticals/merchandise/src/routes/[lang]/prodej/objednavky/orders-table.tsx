import type { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Link } from '@techsio/ui-kit/atoms/link';
import type { ColumnDef, DataTableTranslations } from '@techsio/ui-kit/organisms/data-table';
import { formatDate, formatMoney, formatNumber, StatusBadge, statusPresentation } from '@app/admin-ui';
import { TagCell } from '@app/tagging/components/tag-controls';
import type { Tag } from '@app/tagging/contracts/records';
import { DateTime } from 'effect';
import type { Order } from '../../../../../shared/apis/records.ts';
import type { CustomerDirectory } from './customers-directory.ts';
import { orderStatuses } from './orders-model.ts';

type Translate = ReturnType<typeof useModernI18n>['t'];

const key = (path: string) => `merchandise.pages.orders.${path}`;

const statusOptions = orderStatuses.map((value) => ({ label: statusPresentation('order', value).label, value }));

export const ordersColumns = (
  t: Translate,
  language: string,
  customers: CustomerDirectory,
  tagsOf: (id: string) => readonly Tag[],
): ColumnDef<Order>[] => [
  {
    accessorKey: 'number',
    cell: (info) => <span className="font-medium">{info.getValue<string>()}</span>,
    header: t(key('columns.number')),
    meta: { type: 'string', width: 150 },
  },
  {
    accessorFn: (order) => customers.nameOf(order.partyId) ?? '',
    cell: (info) => {
      const name = info.getValue<string>();
      return name === '' ? (
        <span className="text-fg-secondary">{t(key('customers.unknown'))}</span>
      ) : (
        <span className="truncate">{name}</span>
      );
    },
    header: t(key('columns.customer')),
    id: 'customer',
    meta: { type: 'string', width: 240 },
  },
  {
    accessorFn: (order) => DateTime.formatIso(order.createdAt),
    cell: (info) => formatDate(info.getValue<string>()),
    header: t(key('columns.createdAt')),
    id: 'createdAt',
    meta: { type: 'date', width: 130 },
  },
  {
    accessorFn: (order) => order.lines.length,
    cell: (info) => <span className="tabular-nums">{formatNumber(info.getValue<number>())}</span>,
    header: t(key('columns.lines')),
    id: 'lines',
    meta: { align: 'end', type: 'number', width: 100 },
  },
  {
    accessorKey: 'totalMinor',
    cell: (info) => <span className="tabular-nums">{formatMoney(info.getValue<number>())}</span>,
    header: t(key('columns.total')),
    meta: { align: 'end', type: 'number', width: 160 },
  },
  {
    accessorKey: 'status',
    cell: (info) => <StatusBadge kind="order" value={info.getValue<string>()} />,
    header: t(key('columns.status')),
    meta: { options: statusOptions, type: 'enum', width: 150 },
  },
  {
    accessorFn: (order) => order.opportunityId ?? '',
    cell: (info) => {
      if (info.row.original.opportunityId === undefined) {
        return '—';
      }
      return (
        <Link href={`/${language}/prodej/prilezitosti`} onClick={(event) => event.stopPropagation()}>
          {t(key('source.opportunity'))}
        </Link>
      );
    },
    enableSorting: false,
    header: t(key('columns.source')),
    id: 'source',
    meta: { type: 'string', width: 140 },
  },
  {
    cell: (info) => <TagCell tags={tagsOf(info.row.original.id)} />,
    enableSorting: false,
    header: t(key('columns.tags')),
    id: 'tags',
    meta: { width: 160 },
  },
];

export const ordersTranslations = (t: Translate): DataTableTranslations => ({
  actionsLabel: t(key('table.actionsLabel')),
  clearSearchLabel: t(key('table.clearSearchLabel')),
  columnsLabel: t(key('table.columnsLabel')),
  editingLabel: t(key('table.editingLabel')),
  emptyDescription: t(key('table.emptyDescription')),
  emptyTitle: t(key('table.emptyTitle')),
  filtersLabel: t(key('table.filtersLabel')),
  loadingLabel: t(key('table.loadingLabel')),
  pageSizeLabel: t(key('table.pageSizeLabel')),
  rangeLabel: ({ end, start, total }) => t(key('table.range'), { end, start, total }),
  requiredLabel: t(key('table.requiredLabel')),
  searchButtonLabel: t(key('table.searchButtonLabel')),
  searchLabel: t(key('table.searchLabel')),
  searchPlaceholder: t(key('table.searchPlaceholder')),
  selectAllLabel: t(key('table.selectAllLabel')),
  selectionLabel: t(key('table.selectionLabel')),
});
