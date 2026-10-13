import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import { EmptyState } from '@app/admin-ui';
import type { Tag } from '@app/tagging/contracts/records';
import { Schema } from 'effect';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import { productColumns } from './products-columns.tsx';
import { useTableTranslations } from './products-format.ts';

const ProductsTableStatusSchema = Schema.Literals(['loading', 'error', 'ready']);
export type ProductsTableStatus = typeof ProductsTableStatusSchema.Type;

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
  readonly tagsOf: (id: string) => readonly Tag[];
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
  tagsOf,
}: ProductsTableProps) => {
  const { t } = useModernI18n();
  const tableText = useTableTranslations();
  const label = (path: string) => t(`merchandise.pages.products.${path}`);

  return (
    <DataTable
      columns={productColumns(label, tagsOf)}
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
            <EmptyState
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
            <EmptyState
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
          <EmptyState
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
