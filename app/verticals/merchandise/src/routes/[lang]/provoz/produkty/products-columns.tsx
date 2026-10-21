import { formatMoney, formatNumber } from '@app/admin-ui';
import type { Tag } from '@app/tagging/contracts/records';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import type { ColumnDef } from '@techsio/ui-kit/organisms/data-table';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import { TagsCell, formatKc } from '../../../../list-cells.tsx';
import { AvailabilityBadge, imageUrl } from './product-eshop.tsx';

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
  {
    accessorKey: 'name',
    cell: (info) => {
      const product = info.row.original;
      const [image] = product.images ?? [];
      const variants = product.variantRecords?.length ?? 0;
      return (
        <span className="flex min-w-0 items-center gap-100">
          {image !== undefined && imageUrl(image) !== undefined && (
            <img
              alt=""
              className="shrink-0 rounded-sm border border-border-primary object-cover"
              height={32}
              style={{ height: 32, objectFit: 'cover', width: 32 }}
              width={32}
              loading="lazy"
              onError={(event) => {
                event.currentTarget.style.visibility = 'hidden';
              }}
              src={imageUrl(image)}
            />
          )}
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{product.name}</span>
            {(variants > 0 || product.published === false) && (
              <span className="truncate text-fg-secondary text-xs">
                {[
                  variants > 0
                    ? `${variants} ${variants === 1 ? 'varianta' : variants < 5 ? 'varianty' : 'variant'}`
                    : null,
                  product.published === false ? 'skryto v e-shopu' : null,
                ]
                  .filter((part) => part !== null)
                  .join(' · ')}
              </span>
            )}
          </span>
        </span>
      );
    },
    header: label('columns.name'),
    meta: { type: 'string', width: 240 },
  },
  { accessorKey: 'category', header: label('columns.category'), meta: { type: 'string', width: 110 } },
  {
    accessorKey: 'currentPriceMinor',
    cell: (info) => {
      const product = info.row.original;
      const fromVariants = (product.variantRecords?.length ?? 0) > 0;
      return (
        <span className="flex flex-col items-end tabular-nums">
          <span>{`${fromVariants ? 'od ' : ''}${formatMoney(product.grossPriceMinor ?? info.getValue<number>())}`}</span>
          <span className="text-fg-secondary text-xs">s DPH</span>
        </span>
      );
    },
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
    accessorFn: (product) => product.availability ?? 'UNKNOWN',
    cell: (info) => <AvailabilityBadge value={info.row.original.availability} />,
    header: 'Dostupnost',
    id: 'availability',
    meta: { type: 'string', width: 120 },
  },
  {
    accessorKey: 'stockValueMinor',
    cell: (info) => <span className="tabular-nums">{formatKc(info.getValue<number>())}</span>,
    header: label('columns.stockValue'),
    meta: { align: 'end', type: 'number', width: 140 },
  },
  {
    cell: (info) => <TagsCell tags={tagsOf(info.row.original.id)} />,
    enableSorting: false,
    header: label('columns.tags'),
    id: 'tags',
    meta: { width: 150 },
  },
];
