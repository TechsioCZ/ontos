import type { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import type { ColumnDef, DataTableTranslations } from '@techsio/ui-kit/organisms/data-table';
import { formatDateTime, formatNumber, StatusBadge, dataTableRowLabels } from '@app/admin-ui';
import type { Tag } from '@app/tagging/contracts/records';
import { DateTime } from 'effect';
import type { Order } from '../../../../../shared/apis/records.ts';
import { TagsCell, formatKc } from '../../../../list-cells.tsx';
import type { CustomerDirectory } from './customers-directory.ts';
import { orderCustomerName } from './order-eshop.ts';

type Translate = ReturnType<typeof useModernI18n>['t'];

const key = (path: string) => `merchandise.pages.orders.${path}`;

/** Order table columns: seven, fixed widths. The source opportunity lives in the detail dialog. */
export const ordersColumns = (
  t: Translate,
  customers: CustomerDirectory,
  tagsOf: (id: string) => readonly Tag[],
): ColumnDef<Order>[] => [
  {
    accessorKey: 'number',
    cell: (info) => <span className="whitespace-nowrap font-medium">{info.getValue<string>()}</span>,
    header: t(key('columns.number')),
    meta: { type: 'string', width: 140 },
  },
  {
    accessorFn: (order) => orderCustomerName(order, customers) ?? '',
    cell: (info) => {
      const name = info.getValue<string>();
      const storefront = info.row.original.channel === 'STOREFRONT';
      return (
        <span className="flex min-w-0 items-center gap-100">
          {name === '' ? (
            <span className="text-fg-secondary">{t(key('customers.unknown'))}</span>
          ) : (
            <span className="truncate">{name}</span>
          )}
          {storefront && (
            <Badge size="sm" variant="warning">
              E-shop DEMO
            </Badge>
          )}
        </span>
      );
    },
    header: t(key('columns.customer')),
    id: 'customer',
    meta: { type: 'string', width: 280 },
  },
  {
    accessorFn: (order) => DateTime.formatIso(order.createdAt),
    cell: (info) => <span className="whitespace-nowrap tabular-nums">{formatDateTime(info.getValue<string>())}</span>,
    header: t(key('columns.createdAt')),
    id: 'createdAt',
    meta: { type: 'date', width: 150 },
  },
  {
    accessorFn: (order) => order.lines.length,
    cell: (info) => <span className="tabular-nums">{formatNumber(info.getValue<number>())}</span>,
    header: t(key('columns.lines')),
    id: 'lines',
    meta: { align: 'end', type: 'number', width: 80 },
  },
  {
    accessorKey: 'totalMinor',
    cell: (info) => <span className="tabular-nums">{formatKc(info.getValue<number>())}</span>,
    header: t(key('columns.total')),
    meta: { align: 'end', type: 'number', width: 140 },
  },
  {
    accessorKey: 'status',
    cell: (info) => (
      <span className="whitespace-nowrap">
        <StatusBadge kind="order" value={info.getValue<string>()} />
      </span>
    ),
    header: t(key('columns.status')),
    meta: { type: 'string', width: 190 },
  },
  {
    cell: (info) => <TagsCell tags={tagsOf(info.row.original.id)} />,
    enableSorting: false,
    header: t(key('columns.tags')),
    id: 'tags',
    meta: { width: 190 },
  },
];

export const ordersTranslations = (t: Translate): DataTableTranslations => ({
  ...dataTableRowLabels,
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
