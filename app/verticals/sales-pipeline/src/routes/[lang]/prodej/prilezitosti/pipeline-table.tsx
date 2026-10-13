import {
  EmptyState,
  formatDate,
  formatDateTime,
  formatNumber,
  formatPercent,
  StatusBadge,
  statusPresentation,
  dataTableRowLabels,
} from '@app/admin-ui';
import type { Tag } from '@app/tagging/contracts/records';
import { TagCell } from '@app/tagging/components/tag-controls';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import type { ColumnDef, DataTableTranslations } from '@techsio/ui-kit/organisms/data-table';
import { DateTime } from 'effect';
import type { ReactElement } from 'react';
import type { Opportunity } from '../../../../../shared/model/opportunity.ts';
import { formatWholeKc, opportunityStages, stageRank } from './pipeline-model.ts';
import type { EmployeeId } from './pipeline-model.ts';
import type { CustomerOption, EmployeeOption } from './pipeline-references.ts';

const K = 'sales-pipeline.pages.records';

type Translate = ReturnType<typeof useModernI18n>['t'];

/** Lookups the table needs to turn ids into names and tags. */
export interface PipelineLookups {
  readonly customerById: ReadonlyMap<string, CustomerOption>;
  readonly customersReady: boolean;
  readonly employeeById: ReadonlyMap<string, EmployeeOption>;
  readonly employeesReady: boolean;
  readonly tagsBySubject: ReadonlyMap<string, readonly Tag[]>;
}

const customerCell = (lookups: PipelineLookups, t: Translate, partyId: string): ReactElement => {
  const customer = lookups.customerById.get(partyId);
  if (customer === undefined) {
    return <span className="text-fg-secondary">{lookups.customersReady ? t(`${K}.create.unknownCustomer`) : '—'}</span>;
  }
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate">{customer.name ?? t(`${K}.create.unknownCustomer`)}</span>
      {customer.companyId !== null && (
        <span className="truncate text-fg-secondary text-xs">IČO {customer.companyId}</span>
      )}
    </span>
  );
};

const customerSortKey = (lookups: PipelineLookups, partyId: string): string =>
  lookups.customerById.get(partyId)?.name ?? '';

const ownerCell = (lookups: PipelineLookups, t: Translate, owner: EmployeeId | undefined): ReactElement => {
  if (owner === undefined) {
    return <span className="text-fg-secondary">{t(`${K}.owner.none`)}</span>;
  }
  const employee = lookups.employeeById.get(owner);
  if (employee === undefined) {
    return <span className="text-fg-secondary">{lookups.employeesReady ? t(`${K}.unknownOwner`) : '—'}</span>;
  }
  return <span className="block truncate">{employee.fullName}</span>;
};

const ownerSortKey = (lookups: PipelineLookups, owner: EmployeeId | undefined): string =>
  owner === undefined ? '' : (lookups.employeeById.get(owner)?.fullName ?? '');

const tagsCell = (lookups: PipelineLookups, opportunityId: string): ReactElement => (
  <TagCell tags={lookups.tagsBySubject.get(opportunityId) ?? []} />
);

const stageOptions = () =>
  opportunityStages.map((stage) => ({ label: statusPresentation('opportunity', stage).label, value: stage }));

/** Table columns. Cell renderers stay outside any component so they are plain functions of the lookups. */
export const buildColumns = (t: Translate, lookups: PipelineLookups): ColumnDef<Opportunity>[] => [
  {
    accessorKey: 'title',
    cell: (info) => <span className="block truncate font-medium">{info.row.original.title}</span>,
    header: t(`${K}.columns.title`),
    meta: { type: 'string', width: 190 },
  },
  {
    accessorFn: (row) => customerSortKey(lookups, row.partyId),
    cell: (info) => customerCell(lookups, t, info.row.original.partyId),
    header: t(`${K}.columns.customer`),
    id: 'customer',
    meta: { type: 'string', width: 170 },
  },
  {
    accessorFn: (row) => ownerSortKey(lookups, row.ownerEmployeeId),
    cell: (info) => ownerCell(lookups, t, info.row.original.ownerEmployeeId),
    header: t(`${K}.columns.owner`),
    id: 'owner',
    meta: { type: 'string', width: 130 },
  },
  {
    accessorKey: 'stage',
    cell: (info) => <StatusBadge kind="opportunity" value={info.row.original.stage} />,
    header: t(`${K}.columns.stage`),
    meta: { options: stageOptions(), type: 'enum', width: 120 },
    // The cell value stays the stage code for the enum options; sorting follows the pipeline order instead.
    sortFn: (left, right) => stageRank(left.original.stage) - stageRank(right.original.stage),
  },
  {
    accessorKey: 'probability',
    cell: (info) => <span className="tabular-nums">{formatPercent(info.getValue<number>() / 100)}</span>,
    header: t(`${K}.columns.probability`),
    id: 'probability',
    meta: { align: 'end', type: 'number', width: 120 },
  },
  {
    accessorKey: 'amountMinor',
    cell: (info) => <span className="tabular-nums">{formatWholeKc(info.getValue<number>())}</span>,
    header: t(`${K}.columns.amount`),
    meta: { align: 'end', type: 'number', width: 110 },
  },
  {
    accessorKey: 'expectedCloseDate',
    cell: (info) => formatDate(info.getValue<string>()),
    header: t(`${K}.columns.expectedClose`),
    meta: { type: 'date', width: 100 },
  },
  {
    accessorFn: (row) => DateTime.toEpochMillis(row.updatedAt),
    cell: (info) => formatDateTime(DateTime.formatIso(info.row.original.updatedAt)),
    header: t(`${K}.columns.updatedAt`),
    id: 'updatedAt',
    meta: { type: 'date', width: 150 },
  },
  {
    cell: (info) => tagsCell(lookups, info.row.original.id),
    enableSorting: false,
    header: t(`${K}.columns.tags`),
    id: 'tags',
    meta: { type: 'string', width: 110 },
  },
];

/** Probability and last-updated stay in the column menu; the default view keeps the table to seven data columns. */
export const defaultColumnVisibility = { probability: false, updatedAt: false } satisfies Record<string, boolean>;

export const buildTableTranslations = (t: Translate): DataTableTranslations => ({
  ...dataTableRowLabels,
  actionsLabel: t('sales-pipeline.table.actionsLabel'),
  clearSearchLabel: t('sales-pipeline.table.clearSearchLabel'),
  columnsLabel: t('sales-pipeline.table.columnsLabel'),
  editingLabel: t('sales-pipeline.table.editingLabel'),
  emptyDescription: t('sales-pipeline.table.emptyDescription'),
  emptyTitle: t('sales-pipeline.table.emptyTitle'),
  filtersLabel: t('sales-pipeline.table.filtersLabel'),
  loadingLabel: t('sales-pipeline.table.loadingLabel'),
  pageSizeLabel: t('sales-pipeline.table.pageSizeLabel'),
  // An empty list says so instead of `0–0 z 0`.
  rangeLabel: ({ end, start, total }) =>
    total === 0
      ? t('sales-pipeline.table.rangeEmpty')
      : t('sales-pipeline.table.rangeLabel', {
          end: formatNumber(end),
          start: formatNumber(start),
          total: formatNumber(total),
        }),
  reorderLabel: t('sales-pipeline.table.reorderLabel'),
  requiredLabel: t('sales-pipeline.table.requiredLabel'),
  searchButtonLabel: t('sales-pipeline.table.searchButtonLabel'),
  searchLabel: t('sales-pipeline.table.searchLabel'),
  searchPlaceholder: t('sales-pipeline.table.searchPlaceholder'),
  selectAllLabel: t('sales-pipeline.table.selectAllLabel'),
  selectionLabel: t('sales-pipeline.table.selectionLabel'),
});

/**
 * Pagination labels for ui-kit's Pagination. Its defaults are English ("previous page", "last page, page 2").
 * Labels follow zag's item shape: `{ page, totalPages }`.
 */
export const buildPaginationProps = (t: Translate) => ({
  translations: {
    firstTriggerLabel: t('sales-pipeline.table.pagination.first'),
    itemLabel: ({ page, totalPages }: { page: number; totalPages: number }) =>
      totalPages > 1 && page === totalPages
        ? t('sales-pipeline.table.pagination.lastPage', { page })
        : t('sales-pipeline.table.pagination.page', { page }),
    lastTriggerLabel: t('sales-pipeline.table.pagination.last'),
    nextTriggerLabel: t('sales-pipeline.table.pagination.next'),
    prevTriggerLabel: t('sales-pipeline.table.pagination.previous'),
    rootLabel: t('sales-pipeline.table.pagination.root'),
  },
});

interface PipelineEmptyStateProps {
  readonly canWrite: boolean;
  /** Owner and "Jen nepřiřazené" are both set; they cannot match the same opportunity. */
  readonly conflictingFilters: boolean;
  readonly filtersActive: boolean;
  readonly hasResponse: boolean;
  readonly loadError: 'forbidden' | 'unavailable' | undefined;
  readonly onClearFilters: () => void;
  readonly onCreate: () => void;
  readonly onRetry: () => void;
}

/** Load error, no results and first use each get their own message and next step. */
export const PipelineEmptyState = ({
  canWrite,
  conflictingFilters,
  filtersActive,
  hasResponse,
  loadError,
  onClearFilters,
  onCreate,
  onRetry,
}: PipelineEmptyStateProps) => {
  const { t } = useModernI18n();
  if (loadError !== undefined) {
    return (
      <EmptyState
        action={
          <Button onClick={onRetry} size="sm" theme="outlined" variant="secondary">
            {t(`${K}.retry`)}
          </Button>
        }
        description={t(`${K}.retryDescription`)}
        title={t(loadError === 'forbidden' ? `${K}.forbidden` : `${K}.unavailable`)}
      />
    );
  }
  if (!hasResponse) {
    return null;
  }
  if (filtersActive) {
    return (
      <EmptyState
        action={
          <Button onClick={onClearFilters} size="sm" theme="outlined" variant="secondary">
            {t(`${K}.clearFilters`)}
          </Button>
        }
        description={conflictingFilters ? t(`${K}.noResultsConflict`) : undefined}
        title={t(`${K}.noResults`)}
      />
    );
  }
  return (
    <EmptyState
      action={
        canWrite ? (
          <Button onClick={onCreate} size="sm" theme="outlined" variant="secondary">
            {t(`${K}.newOpportunity`)}
          </Button>
        ) : undefined
      }
      description={t(`${K}.emptyDescription`)}
      title={t(`${K}.emptyTitle`)}
    />
  );
};
