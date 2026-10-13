import { Badge } from '@techsio/ui-kit/atoms/badge';
import type { ColumnDef } from '@techsio/ui-kit/organisms/data-table';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import type { ProductFormat } from './products-format.ts';

/** Product table columns. Numeric columns are end-aligned with tabular figures; the tags slot stays empty. */
export const productColumns = (fmt: ProductFormat, label: (path: string) => string): ColumnDef<ProductRecord>[] => [
  { accessorKey: 'sku', header: label('columns.sku'), meta: { type: 'string', width: 120 } },
  { accessorKey: 'name', header: label('columns.name'), meta: { type: 'string', width: 260 } },
  { accessorKey: 'category', header: label('columns.category'), meta: { type: 'string', width: 160 } },
  {
    accessorKey: 'currentPriceMinor',
    cell: (info) => <span className="tabular-nums">{fmt.money(info.getValue<number>())}</span>,
    header: label('columns.price'),
    meta: { align: 'end', type: 'number', width: 130 },
  },
  {
    accessorKey: 'vatRate',
    cell: (info) => <span className="tabular-nums">{fmt.vat(info.getValue<number>())}</span>,
    header: label('columns.vat'),
    meta: { align: 'end', type: 'number', width: 80 },
  },
  {
    accessorKey: 'stockOnHand',
    cell: (info) => (
      <span className="flex items-center justify-end gap-100 tabular-nums">
        {fmt.count(info.getValue<number>())}
        {info.row.original.lowStock && (
          <Badge size="sm" variant="warning">
            {label('status.lowStock')}
          </Badge>
        )}
      </span>
    ),
    header: label('columns.onHand'),
    meta: { align: 'end', type: 'number', width: 170 },
  },
  {
    accessorKey: 'stockValueMinor',
    cell: (info) => <span className="tabular-nums">{fmt.money(info.getValue<number>())}</span>,
    header: label('columns.stockValue'),
    meta: { align: 'end', type: 'number', width: 150 },
  },
  {
    accessorKey: 'active',
    cell: (info) =>
      info.getValue<boolean>() ? (
        <Badge size="sm" variant="success">
          {label('status.active')}
        </Badge>
      ) : (
        <Badge size="sm" variant="outline">
          {label('status.inactive')}
        </Badge>
      ),
    header: label('columns.status'),
    meta: { type: 'boolean', width: 120 },
  },
  { enableSorting: false, header: label('columns.tags'), id: 'tags', meta: { width: 160 } },
];
