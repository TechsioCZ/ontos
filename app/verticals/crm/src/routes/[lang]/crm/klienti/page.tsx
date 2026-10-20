// AREA: clients (C00/C01) — owned by the crm-clients lane.
// Klienti (Správce, Vedoucí) / Mí klienti (Obchodník): search, filters, list, and the client card in a SidePanel
// opened from `?klient=<id>` (drill-down links from other CRM pages use the same param).
import { PageHeader, StatCard, StatRow, formatDate, formatNumber } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Input } from '@techsio/ui-kit/atoms/input';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { ColumnDef } from '@techsio/ui-kit/organisms/data-table';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import { canSeeEverything } from '../../../../../shared/domain/access.ts';
import type { Client } from '../../../../../shared/domain/clients.ts';
import { CrmPage } from '../../../../crm/crm-page.tsx';
import { salespersonName, useCrmRecords } from '../../../../crm/records.ts';
import { CrmScopeNote, CrmStateGate, crmPaginationProps, crmTableTranslations } from '../../../../crm/ui.tsx';
import { CrmSalesKpiStrip } from '../prehled-prodeju/sales-kpi-strip.tsx';
import { ClientCard } from './client-card.tsx';
import { ClientFormDialog } from './client-form-dialog.tsx';
import {
  activeContactsOf,
  cityOf,
  clientMatches,
  clientSegments,
  kindLabels,
  lastVisitOf,
  primaryContactOf,
  segmentLabel,
  segmentLabels,
} from './clients-model.ts';
import { SalespersonChip } from './salesperson-chip.tsx';

const ALL = 'all';
const UNASSIGNED = 'none';
type StatusFilter = 'active' | 'archived' | 'all';

const DAY_MS = 86_400_000;

interface ClientRow {
  readonly city: string | undefined;
  readonly client: Client;
  readonly contactCount: number;
  readonly lastVisit: string | undefined;
  readonly owner: string | undefined;
  readonly primaryContact: { readonly name: string; readonly role?: string } | undefined;
}

const ownerColumn: ColumnDef<ClientRow> = {
  accessorFn: (row) => row.owner ?? '',
  cell: (info) => <SalespersonChip name={info.getValue<string>()} />,
  header: 'Obchodník',
  id: 'owner',
  meta: { type: 'string', width: 180 },
};

const columns = (showOwner: boolean): ColumnDef<ClientRow>[] => [
  {
    accessorFn: (row) => row.client.name,
    cell: (info) => {
      const row = info.row.original;
      const segment = segmentLabel(row.client.segment);
      return (
        <div className="flex min-w-0 flex-col py-50">
          <span className="flex min-w-0 items-center gap-100">
            <span
              aria-hidden
              className={`${row.client.kind === 'person' ? 'icon-[mdi--account-outline]' : 'icon-[mdi--office-building-outline]'} size-200 shrink-0 text-fg-secondary`}
            />
            <span className="truncate font-medium">{row.client.name}</span>
            {row.client.status === 'archived' && (
              <Badge size="sm" variant="outline">
                Archiv
              </Badge>
            )}
          </span>
          <span className="truncate text-fg-secondary text-xs">
            {[segment ?? kindLabels[row.client.kind], row.city].filter((part) => part !== undefined).join(' · ')}
          </span>
        </div>
      );
    },
    header: 'Klient',
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
    header: 'IČO',
    id: 'regNo',
    meta: { type: 'string', width: 110 },
  },
  {
    accessorFn: (row) => row.primaryContact?.name ?? '',
    cell: (info) => {
      const row = info.row.original;
      if (row.primaryContact === undefined) {
        return <span className="text-fg-secondary">bez kontaktní osoby</span>;
      }
      return (
        <div className="flex min-w-0 flex-col">
          <span className="truncate">{row.primaryContact.name}</span>
          <span className="truncate text-fg-secondary text-xs">
            {[row.primaryContact.role, row.contactCount > 1 ? `+${row.contactCount - 1} další` : undefined]
              .filter((part) => part !== undefined)
              .join(' · ')}
          </span>
        </div>
      );
    },
    header: 'Kontaktní osoba',
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
    header: 'Telefon',
    id: 'phone',
    meta: { type: 'string', width: 150 },
  },
  ...(showOwner ? [ownerColumn] : []),
  {
    accessorFn: (row) => row.lastVisit ?? '',
    cell: (info) => {
      const value = info.getValue<string>();
      return value === '' ? (
        <span className="text-fg-secondary">bez návštěvy</span>
      ) : (
        <span className="tabular-nums">{formatDate(value)}</span>
      );
    },
    header: 'Poslední návštěva',
    id: 'lastVisit',
    meta: { type: 'string', width: 140 },
  },
];

/** `?klient=<id>` of the current URL. */
const useClientParam = () => {
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  const fromUrl = useMemo(() => new URLSearchParams(searchStr).get('klient') ?? undefined, [searchStr]);
  const [openId, setOpenId] = useState<string | undefined>(fromUrl);
  useEffect(() => {
    setOpenId(fromUrl);
  }, [fromUrl]);
  const setClient = useCallback((id: string | undefined) => {
    setOpenId(id);
    const url = new URL(globalThis.location.href);
    if (id === undefined) {
      url.searchParams.delete('klient');
    } else {
      url.searchParams.set('klient', id);
    }
    globalThis.history.replaceState(globalThis.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);
  return [openId, setClient] as const;
};

const buildRows = (records: RecordsResponse): ClientRow[] =>
  records.state.clients.items.map((client) => {
    const primary = primaryContactOf(records, client.id);
    return {
      city: cityOf(client.address),
      client,
      contactCount: activeContactsOf(records, client.id).length,
      lastVisit: lastVisitOf(records, client.id),
      owner: salespersonName(records, client.ownerSalespersonId),
      primaryContact:
        primary === undefined
          ? undefined
          : { name: primary.name, ...(primary.role === undefined ? {} : { role: primary.role }) },
    };
  });

const ClientsList = ({
  busy,
  onOpen,
  records,
  submit,
}: {
  readonly busy: boolean;
  readonly onOpen: (id: string | undefined) => void;
  readonly records: RecordsResponse;
  readonly submit: ReturnType<typeof useCrmRecords>['submit'];
}) => {
  const { t } = useModernI18n();
  const [search, setSearch] = useState('');
  const [owner, setOwner] = useState<string>(ALL);
  const [segment, setSegment] = useState<string>(ALL);
  const [status, setStatus] = useState<StatusFilter>('active');
  const [createOpen, setCreateOpen] = useState(false);

  const manager = canSeeEverything(records.viewer);
  const canCreate = records.viewer.writeAll || records.viewer.writeAssigned;
  const rows = useMemo(() => buildRows(records), [records]);
  const active = rows.filter((row) => row.client.status === 'active');
  const archivedCount = rows.length - active.length;
  const nowMs = Date.parse(records.now);
  const visitedRecently = active.filter(
    (row) => row.lastVisit !== undefined && nowMs - Date.parse(row.lastVisit) <= 30 * DAY_MS,
  ).length;
  const visible = rows.filter(
    (row) =>
      (status === 'all' || row.client.status === status) &&
      (owner === ALL ||
        (owner === UNASSIGNED
          ? row.client.ownerSalespersonId === undefined
          : row.client.ownerSalespersonId === owner)) &&
      (segment === ALL || row.client.segment === segment) &&
      clientMatches(records, row.client, search),
  );
  const filtered = search.trim() !== '' || owner !== ALL || segment !== ALL || status !== 'active';
  const mine = records.viewer.salespersonId;

  return (
    <>
      <PageHeader
        actions={
          canCreate ? (
            <Button icon="icon-[mdi--plus]" onClick={() => setCreateOpen(true)} size="sm" variant="primary">
              Nový klient
            </Button>
          ) : undefined
        }
        description={
          manager
            ? t('crm.pages.clients.description')
            : 'Klienti, které máte přidělené: kontakty, návštěvy a objednávky na jednom místě.'
        }
        title={manager ? t('crm.pages.clients.title') : 'Mí klienti'}
      />
      <StatRow>
        <StatCard
          {...(archivedCount > 0 ? { hint: `${formatNumber(archivedCount)} v archivu` } : {})}
          label="Aktivní klienti"
          value={formatNumber(active.length)}
        />
        {manager ? (
          <StatCard
            hint="Vidí je jen vedení a správce"
            label="Bez obchodníka"
            value={formatNumber(active.filter((row) => row.client.ownerSalespersonId === undefined).length)}
          />
        ) : (
          <StatCard
            hint={salespersonName(records, mine) ?? 'bez záznamu obchodníka'}
            label="Přidělení mně"
            value={formatNumber(active.length)}
          />
        )}
        <StatCard
          label="Kontaktní osoby"
          value={formatNumber(active.reduce((sum, row) => sum + row.contactCount, 0))}
        />
        <StatCard hint="podle zapsaných návštěv" label="Navštíveno za 30 dní" value={formatNumber(visitedRecently)} />
      </StatRow>
      <CrmSalesKpiStrip records={records} />
      <div className="flex flex-wrap items-end gap-150">
        <Input
          aria-label="Hledat klienta"
          className="w-full sm:w-80"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Název, IČO, telefon, e-mail, kontaktní osoba"
          size="sm"
          type="search"
          value={search}
        />
        {manager && (
          <div className="w-full sm:w-52">
            <SelectTemplate
              label="Obchodník"
              items={[
                { label: 'Všichni obchodníci', value: ALL },
                ...records.state.salespeople.map((person) => ({ label: person.name, value: person.id })),
                { label: 'Bez obchodníka', value: UNASSIGNED },
              ]}
              name="owner"
              onValueChange={(details) => setOwner(details.value[0] ?? ALL)}
              size="sm"
              value={[owner]}
            />
          </div>
        )}
        <div className="w-full sm:w-52">
          <SelectTemplate
            label="Segment"
            items={[
              { label: 'Všechny segmenty', value: ALL },
              ...clientSegments.map((key) => ({ label: segmentLabels[key], value: key })),
            ]}
            name="segment"
            onValueChange={(details) => setSegment(details.value[0] ?? ALL)}
            size="sm"
            value={[segment]}
          />
        </div>
        <div className="w-full sm:w-44">
          <SelectTemplate
            label="Stav"
            items={[
              { label: 'Aktivní', value: 'active' },
              { label: 'Archivovaní', value: 'archived' },
              { label: 'Aktivní i archiv', value: 'all' },
            ]}
            name="status"
            onValueChange={(details) => {
              const next = details.value[0];
              if (next === 'active' || next === 'archived' || next === 'all') {
                setStatus(next);
              }
            }}
            size="sm"
            value={[status]}
          />
        </div>
        {filtered && (
          <Button
            icon="icon-[mdi--filter-remove-outline]"
            onClick={() => {
              setSearch('');
              setOwner(ALL);
              setSegment(ALL);
              setStatus('active');
            }}
            size="sm"
            theme="borderless"
            variant="secondary"
          >
            Zrušit filtry
          </Button>
        )}
        <div className="ms-auto">
          <CrmScopeNote records={records} />
        </div>
      </div>
      <ul className="flex flex-col gap-100 md:hidden">
        {visible.length === 0 && (
          <li className="p-200 text-center text-fg-secondary text-sm">Žádný klient neodpovídá.</li>
        )}
        {visible.slice(0, 100).map((row) => (
          <li key={row.client.id}>
            <button
              className="flex w-full flex-col gap-50 rounded-lg border border-border-primary bg-surface p-200 text-start"
              onClick={() => onOpen(row.client.id)}
              type="button"
            >
              <span className="flex items-center justify-between gap-100">
                <span className="truncate font-medium">{row.client.name}</span>
                {row.client.status === 'archived' && (
                  <Badge size="sm" variant="outline">
                    Archiv
                  </Badge>
                )}
              </span>
              <span className="truncate text-fg-secondary text-xs">
                {[segmentLabel(row.client.segment) ?? kindLabels[row.client.kind], row.city, row.primaryContact?.name]
                  .filter((part) => part !== undefined)
                  .join(' · ')}
              </span>
              <span className="flex items-center justify-between gap-100 text-sm">
                {manager ? (
                  <SalespersonChip name={row.owner} />
                ) : (
                  <span className="tabular-nums">{row.client.phone ?? ''}</span>
                )}
                <span className="text-fg-secondary text-xs">
                  {row.lastVisit === undefined ? 'bez návštěvy' : `návštěva ${formatDate(row.lastVisit)}`}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="hidden min-w-0 md:block">
        <DataTable
          columns={columns(manager)}
          data={visible}
          enablePagination
          enableSorting
          getRowId={(row) => row.client.id}
          getRowLabel={(row) => row.original.client.name}
          maxHeight="calc(100dvh - 22rem)"
          onRowClick={(row) => onOpen(row.original.client.id)}
          pageSizeOptions={[25, 50, 100]}
          paginationProps={crmPaginationProps}
          size="sm"
          stickyHeader
          tableLayout="fixed"
          translations={{
            ...crmTableTranslations,
            emptyDescription: filtered
              ? 'Upravte hledání nebo filtry.'
              : manager
                ? 'Založte prvního klienta tlačítkem Nový klient.'
                : 'Zatím vám nebyl přidělen žádný klient.',
            emptyTitle: filtered ? 'Žádný klient neodpovídá' : 'Zatím žádní klienti',
          }}
        />
      </div>
      {createOpen && (
        <ClientFormDialog
          busy={busy}
          mode="create"
          onClose={() => setCreateOpen(false)}
          onSaved={(id) => {
            setCreateOpen(false);
            onOpen(id);
          }}
          records={records}
          submit={submit}
        />
      )}
    </>
  );
};

const ClientsContent = () => {
  const { busy, load, state, submit } = useCrmRecords();
  const [openId, setOpenId] = useClientParam();
  return (
    <CrmStateGate onRetry={load} state={state}>
      {(records) => (
        <>
          <ClientsList busy={busy} onOpen={setOpenId} records={records} submit={submit} />
          {openId !== undefined && (
            <ClientCard
              busy={busy}
              clientId={openId}
              onClose={() => setOpenId(undefined)}
              records={records}
              submit={submit}
            />
          )}
        </>
      )}
    </CrmStateGate>
  );
};

export const ClientsPage = () => (
  <CrmPage titleKey="crm.pages.clients.title">
    <ClientsContent />
  </CrmPage>
);

export default ClientsPage;
