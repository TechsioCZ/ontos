import { formatDate } from '@app/admin-ui';
import type { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import type { ColumnDef } from '@techsio/ui-kit/organisms/data-table';
import { orderDateText } from '../../../../../shared/domain/imports.ts';
import type { ClientRow, ContactRow } from './client-filters.ts';
import { segmentLabel } from './clients-model.ts';
import { SalespersonChip } from './salesperson-chip.tsx';

type ClientTranslation = ReturnType<typeof useModernI18n>['t'];
const noContactKey = 'crm.clientFilters.table.noContact';
export const clientColumns = (
  t: ClientTranslation,
  options: { readonly manager: boolean; readonly showStatus: boolean },
): ColumnDef<ClientRow>[] => {
  const columns: ColumnDef<ClientRow>[] = [
    {
      accessorFn: (row) => row.client.name,
      cell: (info) => {
        const row = info.row.original;
        const segment = segmentLabel(row.client.segment);
        return (
          <div className="flex min-w-0 flex-col py-50">
            <span className="flex min-w-0 items-center gap-100">
              <span className="truncate font-medium">{row.client.name}</span>
              {options.showStatus && row.client.status === 'archived' && (
                <Badge size="sm" variant="outline">
                  {t('crm.clientFilters.table.archived')}
                </Badge>
              )}
            </span>
            <span className="truncate text-fg-secondary text-xs">
              {[segment, row.city].filter((part) => part !== undefined).join(' · ')}
            </span>
          </div>
        );
      },
      header: t('crm.clientFilters.table.client'),
      id: 'name',
      meta: { type: 'string', width: 300 },
    },
    {
      accessorFn: (row) => row.client.regNo ?? '',
      cell: (info) => {
        const value = info.getValue<string>();
        return value === '' ? (
          <span className="text-fg-secondary">—</span>
        ) : (
          <span className="tabular-nums">{value}</span>
        );
      },
      header: t('crm.clientFilters.table.regNo'),
      id: 'regNo',
      meta: { type: 'string', width: 110 },
    },
    {
      accessorFn: (row) => row.primaryContact?.name ?? '',
      cell: (info) => {
        const row = info.row.original;
        if (row.primaryContact === undefined) {
          return <span className="text-fg-secondary">{t(noContactKey)}</span>;
        }
        return (
          <div className="flex min-w-0 flex-col">
            <span className="truncate">{row.primaryContact.name}</span>
            <span className="truncate text-fg-secondary text-xs">
              {[row.primaryContact.role, row.contactCount > 1 ? `+${String(row.contactCount - 1)}` : undefined]
                .filter((part) => part !== undefined)
                .join(' · ')}
            </span>
          </div>
        );
      },
      header: t('crm.clientFilters.table.contact'),
      id: 'contact',
      meta: { type: 'string', width: 200 },
    },
    {
      accessorFn: (row) => row.client.phone ?? '',
      cell: (info) => {
        const value = info.getValue<string>();
        return value === '' ? (
          <span className="text-fg-secondary">—</span>
        ) : (
          <span className="tabular-nums">{value}</span>
        );
      },
      header: t('crm.clientFilters.table.phone'),
      id: 'phone',
      meta: { type: 'string', width: 150 },
    },
    ...(options.manager
      ? [
          {
            accessorFn: (row: ClientRow) => row.owner ?? '',
            cell: (info) => <SalespersonChip name={info.getValue<string>()} />,
            header: t('crm.clientFilters.table.owner'),
            id: 'owner',
            meta: { type: 'string', width: 180 },
          } satisfies ColumnDef<ClientRow>,
        ]
      : []),
    {
      accessorFn: (row) => orderDateText(row.lastVisit) ?? '',
      cell: (info) => {
        const value = info.getValue<string>();
        return value === '' ? (
          <span className="text-fg-secondary">{t(noContactKey)}</span>
        ) : (
          <span className="tabular-nums">{formatDate(value)}</span>
        );
      },
      header: t('crm.clientFilters.table.lastVisit'),
      id: 'lastVisit',
      meta: { type: 'string', width: 140 },
    },
  ];
  return columns;
};

export const contactColumns = (t: ClientTranslation): ColumnDef<ContactRow>[] => {
  const columns: ColumnDef<ContactRow>[] = [
    {
      accessorFn: (row) => row.contact.name,
      cell: (info) => {
        const row = info.row.original;
        return (
          <div className="flex min-w-0 flex-col py-50">
            <span className="flex min-w-0 items-center gap-100">
              <span className="truncate font-medium">{row.contact.name}</span>
              {row.contact.primary === true && (
                <Badge size="sm" variant="info">
                  {t('crm.clientFilters.table.primary')}
                </Badge>
              )}
            </span>
          </div>
        );
      },
      header: t('crm.clientFilters.table.person'),
      id: 'person',
      meta: { type: 'string', width: 240 },
    },
    {
      accessorFn: (row) => row.contact.role ?? '',
      cell: (info) => {
        const value = info.getValue<string>();
        return value === '' ? <span className="text-fg-secondary">—</span> : <span>{value}</span>;
      },
      header: t('crm.clientFilters.table.role'),
      id: 'role',
      meta: { type: 'string', width: 170 },
    },
    {
      accessorFn: (row) => row.contact.email ?? '',
      cell: (info) => {
        const value = info.getValue<string>();
        return value === '' ? <span className="text-fg-secondary">—</span> : <span className="break-all">{value}</span>;
      },
      header: t('crm.clientFilters.table.email'),
      id: 'email',
      meta: { type: 'string', width: 220 },
    },
    {
      accessorFn: (row) => row.contact.phone ?? '',
      cell: (info) => {
        const value = info.getValue<string>();
        return value === '' ? (
          <span className="text-fg-secondary">—</span>
        ) : (
          <span className="tabular-nums">{value}</span>
        );
      },
      header: t('crm.clientFilters.table.phone'),
      id: 'phone',
      meta: { type: 'string', width: 150 },
    },
    {
      accessorFn: (row) => row.client.name,
      cell: (info) => <span className="truncate">{info.getValue<string>()}</span>,
      header: t('crm.clientFilters.table.owningClient'),
      id: 'owningClient',
      meta: { type: 'string', width: 240 },
    },
    {
      accessorFn: (row) => orderDateText(row.clientRow.lastVisit) ?? '',
      cell: (info) => {
        const value = info.getValue<string>();
        return value === '' ? (
          <span className="text-fg-secondary">{t(noContactKey)}</span>
        ) : (
          <span className="tabular-nums">{formatDate(value)}</span>
        );
      },
      header: t('crm.clientFilters.table.lastVisit'),
      id: 'lastVisit',
      meta: { type: 'string', width: 140 },
    },
  ];
  return columns;
};
