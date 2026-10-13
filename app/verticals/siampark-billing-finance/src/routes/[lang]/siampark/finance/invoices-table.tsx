import { EmptyState, formatDate, formatMoney, StatusBadge } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Menu } from '@techsio/ui-kit/molecules/menu';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { useState } from 'react';
import type { Row } from '@techsio/ui-kit/organisms/data-table';
import type { Invoice } from '../../../../../shared/apis/records.ts';
import { customerDisplayName, customerOf, invoiceStatusBadge, opportunityTitle } from './invoice-view.ts';
import type { InvoiceColumn } from './invoice-table-types.ts';
import type { useFinanceRecords } from './use-finance-records.ts';

type FinanceViewModel = ReturnType<typeof useFinanceRecords>;
type Translate = FinanceViewModel['t'];

const ns = 'siampark-billing-finance.faktury';
const ALL = 'ALL';
const STATUS_FILTERS = ['DRAFT', 'UNPAID', 'PARTIAL', 'PAID', 'OVERDUE', 'VOIDED'] as const;

const tableTranslations = (t: Translate) => ({
  actionsLabel: '',
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

const buildColumns = (t: Translate, vm: FinanceViewModel): InvoiceColumn[] => {
  const { referenceDate, references } = vm;
  const unknownCustomer = t(`${ns}.unknownCustomer`);
  return [
    {
      accessorFn: (row) => row.number ?? row.documentNumber,
      cell: (info) => <span className="font-medium whitespace-nowrap">{info.getValue<string>()}</span>,
      header: t(`${ns}.columns.number`),
      id: 'number',
      meta: { width: 130 },
    },
    {
      accessorFn: (row) => customerDisplayName(customerOf(references.customerById, row), unknownCustomer),
      cell: (info) => {
        const customer = customerOf(references.customerById, info.row.original);
        const companyId = customer?.companyId ?? null;
        return (
          <span className="flex min-w-0 flex-col">
            <span className={customer === undefined ? 'truncate text-fg-secondary' : 'truncate'}>
              {customerDisplayName(customer, unknownCustomer)}
            </span>
            {companyId !== null && (
              <span className="truncate text-fg-secondary text-xs">
                {t(`${ns}.companyId`)} {companyId}
              </span>
            )}
          </span>
        );
      },
      header: t(`${ns}.columns.customer`),
      id: 'customer',
      meta: { width: 220 },
    },
    {
      accessorKey: 'issueDate',
      cell: (info) => formatDate(info.getValue<string>()),
      header: t(`${ns}.columns.issued`),
      meta: { width: 110 },
    },
    {
      accessorKey: 'dueDate',
      cell: (info) => formatDate(info.getValue<string>()),
      header: t(`${ns}.columns.due`),
      meta: { width: 110 },
    },
    {
      accessorKey: 'totalMinor',
      cell: (info) => <span className="tabular-nums">{formatMoney(info.getValue<number>())}</span>,
      header: t(`${ns}.columns.total`),
      meta: { align: 'end', type: 'number', width: 130 },
    },
    {
      accessorFn: (row) => invoiceStatusBadge(row, referenceDate).value,
      cell: (info) => <StatusBadge {...invoiceStatusBadge(info.row.original, referenceDate)} />,
      header: t(`${ns}.columns.status`),
      id: 'status',
      meta: { width: 180 },
    },
    {
      accessorFn: (row) => opportunityTitle(references.opportunityTitles, row) ?? '',
      cell: (info) => {
        if (info.row.original.opportunityId === undefined) {
          return '—';
        }
        const title = info.getValue<string>();
        const hiddenTitle = title === '' && references.opportunitiesForbidden;
        return (
          <span className="flex min-w-0 flex-col">
            <span>{t(`${ns}.sourceOpportunity`)}</span>
            {title !== '' && <span className="truncate text-fg-secondary text-xs">{title}</span>}
            {hiddenTitle && (
              <span className="truncate text-fg-secondary text-xs">{t(`${ns}.opportunityForbidden`)}</span>
            )}
          </span>
        );
      },
      enableSorting: false,
      header: t(`${ns}.columns.source`),
      id: 'source',
      meta: { width: 180 },
    },
  ];
};

/** Menu clicks and keys stop at the row menu so they do not open the invoice detail. */
const stopRowInteraction = (event: { stopPropagation: () => void }) => event.stopPropagation();

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
    references,
    reload,
    requestVoid,
    snapshot,
    t,
  } = vm;
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>(ALL);
  const loadFailed = snapshot === undefined && feedback !== 'loading';
  const filterActive = search.trim() !== '' || status !== ALL;
  const unknownCustomer = t(`${ns}.unknownCustomer`);

  const query = search.trim().toLowerCase();
  const visibleInvoices = invoices.filter((invoice) => {
    if (status !== ALL && invoiceStatusBadge(invoice, referenceDate).value !== status) {
      return false;
    }
    if (query === '') {
      return true;
    }
    const customerName = customerDisplayName(customerOf(references.customerById, invoice), unknownCustomer);
    return [invoice.number ?? invoice.documentNumber, customerName].some((value) =>
      value.toLowerCase().includes(query),
    );
  });

  const rowMenu = (invoice: Invoice) =>
    invoice.businessState === 'DRAFT' ? (
      <div
        aria-label={t(`${ns}.table.rowMenu`)}
        onClick={stopRowInteraction}
        onKeyDown={stopRowInteraction}
        role="toolbar"
        tabIndex={-1}
      >
        <Menu
          aria-label={t(`${ns}.table.rowMenu`)}
          customTrigger={
            <Button
              aria-label={t(`${ns}.table.rowMenu`)}
              disabled={busy}
              icon="icon-[mdi--dots-vertical]"
              size="sm"
              theme="borderless"
              variant="secondary"
            />
          }
          items={[
            {
              disabled: busy,
              icon: 'icon-[mdi--check-circle-outline]',
              label: t(`${ns}.confirm`),
              type: 'action',
              value: 'confirm',
            },
            {
              disabled: busy,
              icon: 'icon-[mdi--cancel]',
              label: t(`${ns}.void`),
              type: 'action',
              value: 'void',
            },
          ]}
          onSelect={({ value }) => {
            if (value === 'confirm') {
              confirmInvoice(invoice);
            } else if (value === 'void') {
              requestVoid(invoice);
            }
          }}
          size="sm"
        />
      </div>
    ) : null;

  return (
    <>
      <div className="flex flex-wrap items-end gap-150">
        <div className="w-64 min-w-0">
          <FormInput
            id="invoice-search"
            label={t(`${ns}.table.search`)}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t(`${ns}.table.searchPlaceholder`)}
            size="sm"
            value={search}
          />
        </div>
        <div className="w-48 min-w-0">
          <Select
            items={[
              { label: t(`${ns}.filters.all`), value: ALL },
              ...STATUS_FILTERS.map((value) => ({ label: t(`${ns}.filters.states.${value}`), value })),
            ]}
            label={t(`${ns}.filters.status`)}
            onValueChange={({ value }) => {
              const [next] = value;
              if (next !== undefined) {
                setStatus(next);
              }
            }}
            placeholder={t('siampark-billing-finance.selectPlaceholder')}
            size="sm"
            value={[status]}
          />
        </div>
      </div>
      <DataTable
        columns={buildColumns(t, vm)}
        data={visibleInvoices}
        enableColumnFilters={false}
        enablePagination
        enableSorting
        getRowId={(row) => row.ref.resourceId}
        getRowLabel={(row) => row.original.number ?? row.original.documentNumber}
        loading={snapshot === undefined && feedback === 'loading'}
        loadingRowCount={12}
        maxHeight="calc(100dvh - 24rem)"
        onRowClick={(row) => openDetail(row.original.ref.resourceId)}
        pageSizeOptions={[50, 100, 200]}
        renderEmpty={() => {
          if (loadFailed) {
            return (
              <EmptyState
                action={
                  <Button className="whitespace-nowrap" onClick={reload} size="sm" theme="outlined" variant="secondary">
                    {t(`${ns}.retry`)}
                  </Button>
                }
                description={t(`${ns}.loadErrorDescription`)}
                title={t(`${ns}.loadError`)}
              />
            );
          }
          if (filterActive) {
            return <EmptyState description={t(`${ns}.noMatchesDescription`)} title={t(`${ns}.noMatches`)} />;
          }
          return <EmptyState description={t(`${ns}.emptyFirstDescription`)} title={t(`${ns}.emptyFirstTitle`)} />;
        }}
        {...(canWrite ? { renderRowActions: (row: Row<Invoice>) => rowMenu(row.original) } : {})}
        size="sm"
        stickyHeader
        tableLayout="fixed"
        translations={tableTranslations(t)}
      />
    </>
  );
};
