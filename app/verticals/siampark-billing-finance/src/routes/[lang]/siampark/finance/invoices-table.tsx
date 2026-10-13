import { EmptyState, formatDate, formatMoney, StatusBadge } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import { customerName, invoiceCustomerId, paymentKind } from './invoice-view.ts';
import type { InvoiceColumn } from './invoice-table-types.ts';
import type { useFinanceRecords } from './use-finance-records.ts';

type FinanceViewModel = ReturnType<typeof useFinanceRecords>;
type Translate = FinanceViewModel['t'];

const ns = 'siampark-billing-finance.faktury';

const tableTranslations = (t: Translate) => ({
  actionsLabel: t(`${ns}.table.actions`),
  clearSearchLabel: t(`${ns}.table.clearSearch`),
  columnsLabel: t(`${ns}.table.columns`),
  editingLabel: t(`${ns}.table.editing`),
  emptyDescription: t(`${ns}.table.emptyDescription`),
  emptyTitle: t(`${ns}.table.emptyTitle`),
  filtersLabel: t(`${ns}.table.filters`),
  loadingLabel: t(`${ns}.table.loading`),
  pageSizeLabel: t(`${ns}.table.pageSize`),
  rangeLabel: ({ end, start, total }: { end: number; start: number; total: number }) =>
    t(`${ns}.table.range`, { end, start, total }),
  reorderLabel: t(`${ns}.table.reorder`),
  requiredLabel: t(`${ns}.table.required`),
  searchButtonLabel: t(`${ns}.table.search`),
  searchLabel: t(`${ns}.table.search`),
  searchPlaceholder: t(`${ns}.table.searchPlaceholder`),
  selectAllLabel: t(`${ns}.table.selectAll`),
  selectionLabel: t(`${ns}.table.selection`),
});

const buildColumns = (t: Translate, referenceDate: string): InvoiceColumn[] => [
  {
    accessorFn: (row) => row.number ?? row.documentNumber,
    cell: (info) => <span className="font-medium whitespace-nowrap">{info.getValue<string>()}</span>,
    header: t(`${ns}.columns.number`),
    id: 'number',
    meta: { width: 150 },
  },
  {
    accessorFn: (row) => customerName(invoiceCustomerId(row)),
    header: t(`${ns}.columns.customer`),
    id: 'customer',
    meta: { width: 220 },
  },
  {
    accessorKey: 'issueDate',
    cell: (info) => formatDate(info.getValue<string>()),
    header: t(`${ns}.columns.issued`),
    meta: { width: 120 },
  },
  {
    accessorKey: 'dueDate',
    cell: (info) => formatDate(info.getValue<string>()),
    header: t(`${ns}.columns.due`),
    meta: { width: 120 },
  },
  {
    accessorKey: 'totalMinor',
    cell: (info) => <span className="tabular-nums">{formatMoney(info.getValue<number>())}</span>,
    header: t(`${ns}.columns.total`),
    meta: { align: 'end', type: 'number', width: 130 },
  },
  {
    accessorKey: 'businessState',
    cell: (info) => <StatusBadge kind="invoice" value={info.getValue<string>()} />,
    header: t(`${ns}.columns.status`),
    meta: { width: 130 },
  },
  {
    accessorFn: (row) => paymentKind(row, referenceDate),
    cell: (info) => <StatusBadge kind="payment" value={info.getValue<string>()} />,
    header: t(`${ns}.columns.payment`),
    id: 'payment',
    meta: { width: 170 },
  },
  {
    accessorFn: (row) => row.opportunityId,
    cell: (info) => (info.getValue<string | undefined>() === undefined ? '—' : t(`${ns}.sourceOpportunity`)),
    enableSorting: false,
    header: t(`${ns}.columns.source`),
    id: 'source',
    meta: { width: 130 },
  },
];

interface FinanceInvoiceTableProps {
  readonly vm: FinanceViewModel;
}

export const FinanceInvoiceTable = ({ vm }: FinanceInvoiceTableProps) => {
  const {
    busy,
    canWrite,
    confirmInvoice,
    feedback,
    invoices,
    openDetail,
    referenceDate,
    reload,
    requestVoid,
    snapshot,
    t,
  } = vm;
  const loadFailed = snapshot === undefined && feedback !== 'loading';

  return (
    <DataTable
      columns={buildColumns(t, referenceDate)}
      data={invoices}
      enablePagination
      enableSorting
      getRowId={(row) => row.ref.resourceId}
      getRowLabel={(row) => row.original.number ?? row.original.documentNumber}
      loading={snapshot === undefined && feedback === 'loading'}
      loadingRowCount={12}
      maxHeight="calc(100dvh - 22rem)"
      onRowClick={(row) => openDetail(row.original.ref.resourceId)}
      pageSizeOptions={[50, 100, 200]}
      renderEmpty={() =>
        loadFailed ? (
          <EmptyState
            action={
              <Button onClick={reload} size="sm" theme="outlined" variant="secondary">
                {t(`${ns}.retry`)}
              </Button>
            }
            description={t(`${ns}.loadErrorDescription`)}
            title={t(`${ns}.loadError`)}
          />
        ) : (
          <EmptyState description={t(`${ns}.emptyFirstDescription`)} title={t(`${ns}.emptyFirstTitle`)} />
        )
      }
      rowActions={
        canWrite
          ? [
              {
                disabled: () => busy,
                hidden: (row) => row.original.businessState !== 'DRAFT',
                icon: 'icon-[mdi--check-circle-outline]',
                id: 'confirm',
                label: t(`${ns}.confirm`),
                onAction: (row) => confirmInvoice(row.original),
              },
              {
                disabled: () => busy,
                hidden: (row) => row.original.businessState !== 'DRAFT',
                icon: 'icon-[mdi--cancel]',
                id: 'void',
                label: t(`${ns}.void`),
                onAction: (row) => requestVoid(row.original),
                tone: 'danger',
              },
            ]
          : []
      }
      size="sm"
      stickyHeader
      tableLayout="fixed"
      translations={tableTranslations(t)}
    />
  );
};
