import { formatMoney, formatNumber } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import type { ColumnDef } from '@techsio/ui-kit/organisms/data-table';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import type { ProductId } from '../../../../../shared/domain/merchandise-model.ts';
import { TagsCell } from '../../../../list-cells.tsx';
import { formatKc } from '../../../../list-format.ts';
import type { TagsOf } from '../../../../tags/subject-tags.ts';
import { AvailabilityBadge } from './product-eshop.tsx';
import { useImageSource } from './product-image-source.ts';
import { listPriceOf } from './product-list-price.ts';
import { StorefrontStatusCell, storefrontListNote } from './storefront-status.tsx';
import { ErpCodeLine, SymmyImportedBadge, isSymmyImported } from './symmy-provenance.tsx';

/** The product's main image as a small list thumbnail; nothing while it loads or when nothing can serve it. */
const ProductThumbnail = ({ image, productId }: { readonly image: string; readonly productId: ProductId }) => {
  const source = useImageSource(productId, image, 'thumbnail');
  return source.status === 'ready' ? (
    <img
      alt=""
      className="shrink-0 rounded-sm border border-border-primary object-cover"
      height={32}
      loading="lazy"
      onError={(event) => {
        event.currentTarget.style.visibility = 'hidden';
      }}
      src={source.src}
      style={{ height: 32, objectFit: 'cover', width: 32 }}
      width={32}
    />
  ) : (
    <span aria-hidden="true" className="inline-block size-8 shrink-0 rounded-sm bg-fg-secondary/10" />
  );
};

/** Czech plural of „varianta“ for a count. */
const variantNoun = (count: number) => {
  if (count === 1) {
    return 'varianta';
  }
  return count < 5 ? 'varianty' : 'variant';
};

/**
 * Product table columns over summary rows (no variants, only their `variantCount`). VAT, the active flag and the
 * variants themselves live in the detail.
 * Numbers are end-aligned, fixed widths.
 */
export const productColumns = (label: (path: string) => string, tagsOf: TagsOf): ColumnDef<ProductRecord>[] => [
  {
    accessorKey: 'sku',
    cell: (info) => (
      <span className="flex min-w-0 flex-col">
        <span className="whitespace-nowrap">{info.getValue<string>()}</span>
        <ErpCodeLine product={info.row.original} />
      </span>
    ),
    header: label('columns.sku'),
    meta: { type: 'string', width: 120 },
  },
  {
    accessorKey: 'name',
    cell: (info) => {
      const product = info.row.original;
      const [image] = product.images ?? [];
      const variants = product.variantCount ?? 0;
      const variantsLabel = variants > 0 ? `${formatNumber(variants)} ${variantNoun(variants)}` : null;
      const note = storefrontListNote(product);
      return (
        <span className="flex min-w-0 items-center gap-100">
          {image !== undefined && <ProductThumbnail image={image} productId={product.id} />}
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{product.name}</span>
            {(variants > 0 || note !== null) && (
              <span className="truncate text-fg-secondary text-xs">
                {[variantsLabel, note]
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
  {
    accessorFn: (product) =>
      product.storefrontVisibility === undefined ? '' : product.storefrontVisibility.published ? 'ano' : 'ne',
    cell: (info) => <StorefrontStatusCell product={info.row.original} />,
    enableSorting: false,
    header: 'E-shop',
    id: 'storefront',
    meta: { align: 'center', type: 'string', width: 72 },
  },
  { accessorKey: 'category', header: label('columns.category'), meta: { type: 'string', width: 110 } },
  {
    accessorKey: 'currentPriceMinor',
    cell: (info) => {
      const price = listPriceOf(info.row.original);
      const amount = formatMoney(price.minor);
      return (
        <span className="flex flex-col items-end tabular-nums">
          <span>{price.fromVariants ? `${label('columns.priceFrom')} ${amount}` : amount}</span>
          <span className="text-fg-secondary text-xs">
            {label(price.withVat ? 'columns.priceWithVat' : 'columns.priceWithoutVat')}
          </span>
        </span>
      );
    },
    header: label('columns.price'),
    meta: { align: 'end', type: 'number', width: 100 },
  },
  {
    accessorKey: 'stockOnHand',
    cell: (info) => (
      <span className="flex items-center justify-end gap-100 whitespace-nowrap">
        {info.row.original.lowStock && (
          <Badge severity="warning" size="sm">
            {label('status.lowStock')}
          </Badge>
        )}
        <span className="tabular-nums">{formatNumber(info.getValue<number>())}</span>
      </span>
    ),
    header: label('columns.onHand'),
    meta: { align: 'end', type: 'number', width: 180 },
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
  // Always present: a Symmy mark shows here even for a role that may not read tags (`tagsOf` is `null`).
  {
    cell: (info) => {
      const product = info.row.original;
      return (
        <TagsCell
          lead={<SymmyImportedBadge product={product} />}
          maxChips={isSymmyImported(product) ? 1 : 2}
          tags={tagsOf === null ? [] : tagsOf(product.id)}
        />
      );
    },
    enableSorting: false,
    header: label('columns.tags'),
    id: 'tags',
    meta: { width: 280 },
  },
];
