import { formatMoney, formatNumber } from '@app/admin-ui';
import type { Tag } from '@app/tagging/contracts/records';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import type { ColumnDef } from '@techsio/ui-kit/organisms/data-table';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import { TagsCell, formatKc } from '../../../../list-cells.tsx';

/** Product table columns. VAT and the active flag live in the detail dialog. Numbers are end-aligned, fixed widths. */
export const productColumns = (
  label: (path: string) => string,
  tagsOf: (id: string) => readonly Tag[],
): ColumnDef<ProductRecord>[] => [
  {
    accessorKey: 'sku',
    cell: (info) => <span className="whitespace-nowrap">{info.getValue<string>()}</span>,
    header: label('columns.sku'),
    meta: { type: 'string', width: 120 },
  },
  { accessorKey: 'name', header: label('columns.name'), meta: { type: 'string', width: 180 } },
  { accessorKey: 'category', header: label('columns.category'), meta: { type: 'string', width: 110 } },
  {
    accessorKey: 'currentPriceMinor',
    cell: (info) => <span className="tabular-nums">{formatMoney(info.getValue<number>())}</span>,
    header: label('columns.price'),
    meta: { align: 'end', type: 'number', width: 100 },
  },
  {
    accessorKey: 'stockOnHand',
    cell: (info) => (
      <span className="flex items-center justify-end gap-100 tabular-nums">
        {formatNumber(info.getValue<number>())}
        {info.row.original.lowStock && (
          <Badge size="sm" variant="warning">
            {label('status.lowStock')}
          </Badge>
        )}
      </span>
    ),
    header: label('columns.onHand'),
    meta: { align: 'end', type: 'number', width: 140 },
  },
  {
    accessorKey: 'stockValueMinor',
    cell: (info) => <span className="tabular-nums">{formatKc(info.getValue<number>())}</span>,
    header: label('columns.stockValue'),
    meta: { align: 'end', type: 'number', width: 110 },
  },
  {
    cell: (info) => <TagsCell tags={tagsOf(info.row.original.id)} />,
    enableSorting: false,
    header: label('columns.tags'),
    id: 'tags',
    meta: { width: 150 },
  },
];
