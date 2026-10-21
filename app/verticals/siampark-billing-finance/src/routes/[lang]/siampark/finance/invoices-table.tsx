import { EmptyState, formatDate, formatMoney, matchesSearch, StatusBadge, paginationTranslations } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Tooltip } from '@techsio/ui-kit/atoms/tooltip';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Menu } from '@techsio/ui-kit/molecules/menu';
import type { MenuItem } from '@techsio/ui-kit/molecules/menu';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { useState } from 'react';
import type { Row } from '@techsio/ui-kit/organisms/data-table';
import type { Invoice } from '../../../../../shared/apis/records.ts';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import {
  customerDisplayName,
  customerLoadingLabel,
  customerOf,
  invoiceLifecycle,
  invoiceStatusBadge,
  isVoidable,
  LIFECYCLE_PRESENTATION,
  opportunityTitle,
} from './invoice-view.ts';
import type { InvoiceColumn } from './invoice-table-types.ts';
import type { useFinanceRecords } from './use-finance-records.ts';

type FinanceViewModel = ReturnType<typeof useFinanceRecords>;
type Translate = FinanceViewModel['t'];

const ns = 'siampark-billing-finance.faktury';
const ALL = 'ALL';
const STATUS_FILTERS = ['DRAFT', 'PREPARED', 'HANDED_OVER', 'UNPAID', 'PARTIAL', 'PAID', 'OVERDUE', 'VOIDED'] as const;

/** Lifecycle filters (návrh, připraveno, předáno) read the lifecycle; the rest read the payment/business badge. */
const matchesStatusFilter = (
  invoice: Invoice,
  status: string,
  referenceDate: string,
  exports: Parameters<typeof invoiceLifecycle>[1],
) => {
  const lifecycle = invoiceLifecycle(invoice, exports);
  if (status === 'DRAFT' || status === 'PREPARED') {
    return lifecycle === status;
  }
  if (status === 'HANDED_OVER') {
    return lifecycle === 'HANDED_OVER' || lifecycle === 'ACCOUNTANT_CONFIRMED';
  }
  return invoiceStatusBadge(invoice, referenceDate).value === status;
};

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

/**
 * Column widths add up to 910 px, so the columns plus the row-actions column fit the ~980 px content area at a
 * 1280 px viewport without horizontal scroll (the fixed layout spreads any extra width proportionally).
 */
const buildColumns = (t: Translate, vm: FinanceViewModel): InvoiceColumn[] => {
  const { referenceDate, references } = vm;
  const exports = vm.snapshot?.state.accountingExports ?? [];
  const unknownCustomer = references.customersLoading ? customerLoadingLabel : t(`${ns}.unknownCustomer`);
  return [
    {
      accessorFn: (row) => row.number ?? row.documentNumber,
      cell: (info) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium whitespace-nowrap">{info.getValue<string>()}</span>
          <span className="truncate text-fg-secondary text-xs">
            {info.row.original.direction === 'INCOMING'
              ? 'přijatá'
              : info.row.original.documentKind === 'RECURRING'
                ? 'vydaná · opakovaná'
                : 'vydaná'}
          </span>
        </span>
      ),
      header: t(`${ns}.columns.number`),
      id: 'number',
      meta: { width: 125 },
    },
    {
      accessorFn: (row) =>
        customerDisplayName(customerOf(references.customerById, row), row.counterpartyName ?? unknownCustomer),
      cell: (info) => {
        const customer = customerOf(references.customerById, info.row.original);
        const companyId = customer?.companyId ?? info.row.original.counterpartyCompanyId ?? null;
        const fallback = info.row.original.counterpartyName;
        return (
          <span className="flex min-w-0 flex-col">
            <span
              className={customer === undefined && fallback === undefined ? 'truncate text-fg-secondary' : 'truncate'}
            >
              {customerDisplayName(customer, fallback ?? unknownCustomer)}
            </span>
            {companyId !== null && (
              <span className="truncate text-fg-secondary text-xs">
                {t(`${ns}.companyId`)} {companyId}
              </span>
            )}
          </span>
        );
      },
      header: 'Odběratel / dodavatel',
      id: 'customer',
      meta: { width: 185 },
    },
    {
      accessorKey: 'issueDate',
      cell: (info) => formatDate(info.getValue<string>()),
      header: t(`${ns}.columns.issued`),
      meta: { width: 105 },
    },
    {
      accessorKey: 'dueDate',
      cell: (info) => formatDate(info.getValue<string>()),
      header: t(`${ns}.columns.due`),
      meta: { width: 105 },
    },
    {
      accessorKey: 'totalMinor',
      cell: (info) => <span className="tabular-nums">{formatMoney(info.getValue<number>())}</span>,
      header: t(`${ns}.columns.total`),
      meta: { align: 'end', type: 'number', width: 125 },
    },
    {
      accessorFn: (row) => invoiceLifecycle(row, exports),
      cell: (info) => {
        const presentation = LIFECYCLE_PRESENTATION[invoiceLifecycle(info.row.original, exports)];
        const confirmed = info.row.original.businessState === 'CONFIRMED';
        return (
          <span className="flex min-w-0 flex-col items-start gap-50">
            <Badge className="max-w-full truncate" size="sm" variant={presentation.variant}>
              {presentation.label}
            </Badge>
            {confirmed && <StatusBadge {...invoiceStatusBadge(info.row.original, referenceDate)} />}
          </span>
        );
      },
      header: t(`${ns}.columns.status`),
      id: 'status',
      meta: { width: 150 },
    },
    {
      accessorFn: (row) => opportunityTitle(references.opportunityTitles, row) ?? '',
      cell: (info) => {
        if (info.row.original.recurringTemplateId !== undefined) {
          return `Opakovaná · ${info.row.original.recurringPeriod ?? 'bez období'}`;
        }
        if (info.row.original.sourceOrder !== undefined) {
          return `Objednávka ${info.row.original.sourceOrder.number}`;
        }
        if (info.row.original.opportunityId === undefined) {
          return t(`${ns}.sourceManual`);
        }
        const title = info.getValue<string>();
        const hiddenTitle = title === '' && references.opportunitiesForbidden;
        return (
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{t(`${ns}.sourceOpportunity`)}</span>
            {title !== '' && (
              <Tooltip content={title}>
                <span className="truncate text-fg-secondary text-xs">{title}</span>
              </Tooltip>
            )}
            {hiddenTitle && (
              <span className="truncate text-fg-secondary text-xs">{t(`${ns}.opportunityForbidden`)}</span>
            )}
          </span>
        );
      },
      enableSorting: false,
      header: t(`${ns}.columns.source`),
      id: 'source',
      meta: { width: 115 },
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
  const [direction, setDirection] = useState<string>(ALL);
  const loadFailed = snapshot === undefined && feedback !== 'loading';
  const filterActive = search.trim() !== '' || status !== ALL || direction !== ALL;
  const unknownCustomer = references.customersLoading ? customerLoadingLabel : t(`${ns}.unknownCustomer`);

  const visibleInvoices = invoices.filter((invoice) => {
    if (status !== ALL && !matchesStatusFilter(invoice, status, referenceDate, snapshot?.state.accountingExports ?? [])) {
      return false;
    }
    if (direction !== ALL && invoice.direction !== direction) {
      return false;
    }
    if (search.trim() === '') {
      return true;
    }
    const customer = customerOf(references.customerById, invoice);
    // The row shows the customer's IČO under the name, so the search matches it too.
    const searched = [
      invoice.number ?? invoice.documentNumber,
      customerDisplayName(customer, invoice.counterpartyName ?? unknownCustomer),
      customer?.companyId ?? invoice.counterpartyCompanyId ?? '',
      invoice.documentNumber,
    ];
    return searched.some((value) => matchesSearch(value, search));
  });

  // Drafts offer confirm and void; a confirmed invoice the owner would still void offers only void.
  const rowMenuItems = (invoice: Invoice): MenuItem[] => {
    const voidItem: MenuItem = {
      disabled: busy,
      icon: 'icon-[mdi--cancel]',
      label: t(`${ns}.void`),
      type: 'action',
      value: 'void',
    };
    if (invoice.businessState !== 'DRAFT') {
      return [voidItem];
    }
    if (invoice.reviewState !== 'PREPARED') {
      return [
        {
          disabled: busy,
          icon: 'icon-[mdi--clipboard-check-outline]',
          label: 'Připravit ke schválení',
          type: 'action',
          value: 'prepare',
        },
        voidItem,
      ];
    }
    const confirmItem: MenuItem = {
      disabled: busy,
      icon: 'icon-[mdi--check-circle-outline]',
      label: t(`${ns}.confirm`),
      type: 'action',
      value: 'confirm',
    };
    return [
      confirmItem,
      { disabled: busy, icon: 'icon-[mdi--undo]', label: 'Vrátit do návrhu', type: 'action', value: 'return' },
      voidItem,
    ];
  };
  const rowMenu = (invoice: Invoice) =>
    isVoidable(invoice) ? (
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
          items={rowMenuItems(invoice)}
          onSelect={({ value }) => {
            if (value === 'confirm') {
              confirmInvoice(invoice);
            } else if (value === 'prepare') {
              void vm.execute(
                {
                  _tag: 'MarkInvoicesPrepared',
                  ...(vm.actorLabel === undefined ? {} : { actorLabel: vm.actorLabel }),
                  invoiceRefs: [invoice.ref],
                },
                'Doklad připraven ke schválení',
              );
            } else if (value === 'return') {
              void vm.execute({ _tag: 'ReturnInvoiceToDraft', invoiceRef: invoice.ref }, 'Doklad vrácen do návrhu');
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
        <div className="w-40 min-w-0">
          <Select
            items={[
              { displayValue: 'Vydané i přijaté', label: 'Vydané i přijaté', value: ALL },
              { displayValue: 'Vydané', label: 'Vydané', value: 'OUTGOING' },
              { displayValue: 'Přijaté', label: 'Přijaté', value: 'INCOMING' },
            ]}
            label="Druh"
            labelProps={{ className: 'font-label text-label-sm' }}
            onValueChange={({ value }) => {
              const [next] = value;
              if (next !== undefined) {
                setDirection(next);
              }
            }}
            size="sm"
            value={[direction]}
          />
        </div>
        <div className="w-48 min-w-0">
          <Select
            items={[
              // `displayValue` names the hidden native option too; without it the option reads ALL, DRAFT, UNPAID.
              { displayValue: t(`${ns}.filters.all`), label: t(`${ns}.filters.all`), value: ALL },
              ...STATUS_FILTERS.map((value) => {
                const label = t(`${ns}.filters.states.${value}`);
                return { displayValue: label, label, value };
              }),
            ]}
            label={t(`${ns}.filters.status`)}
            labelProps={{ className: 'font-label text-label-sm' }}
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
        paginationProps={{ translations: paginationTranslations }}
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
