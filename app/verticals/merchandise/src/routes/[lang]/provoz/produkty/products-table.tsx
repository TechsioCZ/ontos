import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import { Schema } from 'effect';
import type { ReactNode } from 'react';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import { productColumns } from './products-columns.tsx';
import { useProductFormat, useTableTranslations } from './products-format.ts';

const ProductsTableStatusSchema = Schema.Literals(['loading', 'error', 'ready']);
export type ProductsTableStatus = typeof ProductsTableStatusSchema.Type;

const EmptyBlock = ({
  action,
  description,
  title,
}: {
  readonly action?: ReactNode;
  readonly description?: string;
  readonly title: string;
}) => (
  <div className="flex flex-col items-center gap-150 p-450 text-center">
    <div className="flex flex-col gap-50">
      <p className="font-semibold text-md">{title}</p>
      {description !== undefined && <p className="max-w-prose text-fg-secondary text-sm">{description}</p>}
    </div>
    {action}
  </div>
);

export interface ProductsTableProps {
  readonly canWrite: boolean;
  readonly filtersActive: boolean;
  readonly onClearFilters: () => void;
  readonly onCreate: () => void;
  readonly onOpen: (id: ProductRecord['id']) => void;
  readonly onRetry: () => void;
  readonly onSelectionChange: (next: Record<string, true>) => void;
  readonly rows: readonly ProductRecord[];
  readonly selection: Record<string, true>;
  readonly status: ProductsTableStatus;
}

/** Products DataTable with the three empty states: load error, no filter results, first use. */
export const ProductsTable = ({
  canWrite,
  filtersActive,
  onClearFilters,
  onCreate,
  onOpen,
  onRetry,
  onSelectionChange,
  rows,
  selection,
  status,
}: ProductsTableProps) => {
  const { t } = useModernI18n();
  const fmt = useProductFormat();
  const tableText = useTableTranslations();
  const label = (path: string) => t(`merchandise.pages.products.${path}`);

  return (
    <DataTable
      columns={productColumns(fmt, label)}
      data={status === 'ready' ? [...rows] : []}
      enablePagination
      enableRowSelection
      enableSorting
      getRowId={(row) => row.id}
      getRowLabel={(row) => row.original.name}
      loading={status === 'loading'}
      loadingRowCount={12}
      maxHeight="calc(100dvh - 15rem)"
      onRowClick={(row) => onOpen(row.original.id)}
      onRowSelectionChange={onSelectionChange}
      pageSizeOptions={[50, 100, 200]}
      renderEmpty={() => {
        if (status === 'error') {
          return (
            <EmptyBlock
              action={
                <Button onClick={onRetry} size="sm" theme="outlined" variant="secondary">
                  {label('common.retry')}
                </Button>
              }
              description={label('states.errorDescription')}
              title={label('states.error')}
            />
          );
        }
        if (filtersActive) {
          return (
            <EmptyBlock
              action={
                <Button onClick={onClearFilters} size="sm" theme="outlined" variant="secondary">
                  {label('common.clearFilters')}
                </Button>
              }
              title={label('states.noResults')}
            />
          );
        }
        return (
          <EmptyBlock
            action={
              canWrite ? (
                <Button onClick={onCreate} size="sm" theme="outlined" variant="secondary">
                  {label('actions.newProduct')}
                </Button>
              ) : undefined
            }
            description={label('states.emptyDescription')}
            title={label('states.empty')}
          />
        );
      }}
      rowSelection={selection}
      size="sm"
      stickyHeader
      tableLayout="fixed"
      translations={tableText}
    />
  );
};
