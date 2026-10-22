import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import { EmptyState } from '@app/admin-ui';
import type { Tag } from '@app/tagging/contracts/records';
import { Schema } from 'effect';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import { paginationProps } from '../../../../form-number.ts';
import { productColumns } from './products-columns.tsx';
import { useTableTranslations } from './products-format.ts';

const ProductsTableStatusSchema = Schema.Literals(['loading', 'error', 'ready']);
export type ProductsTableStatus = typeof ProductsTableStatusSchema.Type;

export interface ProductsPage {
  readonly pageIndex: number;
  readonly pageSize: number;
}

export interface ProductsTableProps {
  readonly canWrite: boolean;
  readonly filtersActive: boolean;
  readonly onClearFilters: () => void;
  readonly onCreate: () => void;
  readonly onOpen: (id: ProductRecord['id']) => void;
  readonly onPaginationChange: (next: ProductsPage) => void;
  readonly onRetry: () => void;
  readonly onSelectionChange: (next: Record<string, true>) => void;
  /** The page the server returned; `rowCount` is the number of all matching products. */
  readonly pagination: ProductsPage;
  readonly rowCount: number;
  readonly rows: readonly ProductRecord[];
  readonly selection: Record<string, true>;
  readonly status: ProductsTableStatus;
  readonly tagsOf: (id: string) => readonly Tag[];
}

/**
 * Products DataTable over one server page: paging asks the server for the next page, sorting is the page's sort
 * control. Three empty states: load error, no filter results, first use.
 */
export const ProductsTable = ({
  canWrite,
  filtersActive,
  onClearFilters,
  onCreate,
  onOpen,
  onPaginationChange,
  onRetry,
  onSelectionChange,
  pagination,
  rowCount,
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
      enableSorting={false}
      enableVirtualization
      getRowId={(row) => row.id}
      getRowLabel={(row) => row.original.name}
      loading={status === 'loading'}
      loadingRowCount={12}
      manualPagination
      maxHeight="calc(100dvh - 15rem)"
      onPaginationChange={onPaginationChange}
      onRowClick={(row) => onOpen(row.original.id)}
      onRowSelectionChange={onSelectionChange}
      pageSizeOptions={[50, 100, 200]}
      pagination={pagination}
      paginationProps={paginationProps(t)}
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
      rowCount={rowCount}
      rowSelection={selection}
      size="sm"
      stickyHeader
      tableLayout="fixed"
      translations={tableText}
    />
  );
};
