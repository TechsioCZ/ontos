import { pipe, DateTime } from 'effect';
// AREA: visits — owned by the crm-visits lane. C02 Návštěvy: timeline + table of visits / calls / e-mails with
// filters, record and correct (with history). `?klient=<id>` focuses one client (timeline per client).
import { EmptyState, PageHeader, SectionCard, StatCard, StatRow, formatNumber, matchesSearch } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Input } from '@techsio/ui-kit/atoms/input';
import { Tabs } from '@techsio/ui-kit/molecules/tabs';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { ColumnDef } from '@techsio/ui-kit/organisms/data-table';

import { SelectTemplate } from '@techsio/ui-kit/templates/select';

import { useState } from 'react';
import type { ComponentProps } from 'react';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import { canSeeEverything } from '../../../../../shared/domain/access.ts';
import { lastVisitOf, nextPlanItemOf, visitKinds } from '../../../../../shared/domain/visits.ts';
import type { Visit, VisitKind } from '../../../../../shared/domain/visits.ts';

import { CrmPage } from '../../../../crm/crm-page.tsx';
import { useCrmRecords } from '../../../../crm/records.ts';
import {
  CrmScopeNote,
  CrmStateGate,
  useCrmRouteSearch,
  crmPaginationProps,
  crmTableTranslations,
} from '../../../../crm/ui.tsx';
import { CorrectVisitPanel, RecordVisitPanel, VisitDetailPanel } from './visit-panels.tsx';
import { VisitKindBadge, VisitTimeline } from './visit-timeline.tsx';
import {
  canWriteVisits,
  clientLabel,
  daysBetween,
  formatDay,
  formatVisitTime,
  localDay,
  relativeDay,
  salespersonLabel,
  sortVisitsDesc,
  visitKindMeta,
  visitSearchText,
  writableClients,
} from './visits-model.ts';

const ALL = '__all__';
const periods = [
  { days: 30, label: 'Posledních 30 dní', value: '30' },
  { days: 90, label: 'Posledních 90 dní', value: '90' },
  { days: 100_000, label: 'Celá historie', value: 'all' },
] as const;

const columns = (records: RecordsResponse): ColumnDef<Visit>[] => [
  {
    accessorFn: (visit) => DateTime.formatIso(visit.occurredAt),
    cell: (info) => <span className="tabular-nums">{formatVisitTime(info.row.original.occurredAt)}</span>,
    header: 'Kdy',
    id: 'occurredAt',
    meta: { type: 'string', width: 150 },
  },
  {
    accessorKey: 'kind',
    cell: (info) => <VisitKindBadge kind={info.getValue<VisitKind>()} />,
    header: 'Typ',
    meta: { type: 'string', width: 160 },
  },
  {
    accessorFn: (visit) => clientLabel(records, visit.clientId),
    cell: (info) => <span className="font-medium">{info.getValue<string>()}</span>,
    header: 'Klient',
    id: 'client',
    meta: { type: 'string', width: 220 },
  },
  {
    accessorKey: 'result',
    cell: (info) => {
      const visit = info.row.original;
      return (
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{visit.result}</span>
          {visit.note !== undefined && <span className="truncate text-fg-secondary text-xs">{visit.note}</span>}
        </span>
      );
    },
    header: 'Výsledek',
    meta: { type: 'string', width: 320 },
  },
  {
    accessorFn: (visit) => salespersonLabel(records, visit.salespersonId),
    header: 'Obchodník',
    id: 'salesperson',
    meta: { type: 'string', width: 160 },
  },
  {
    accessorFn: (visit) => visit.nextStepDate ?? '',
    cell: (info) => {
      const visit = info.row.original;
      return visit.nextStep === undefined && visit.nextStepDate === undefined ? (
        <span className="text-fg-secondary">—</span>
      ) : (
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{visit.nextStep ?? 'bez popisu'}</span>
          {visit.nextStepDate !== undefined && (
            <span className="text-fg-secondary text-xs">{formatDay(visit.nextStepDate)}</span>
          )}
        </span>
      );
    },
    header: 'Další krok',
    id: 'nextStep',
    meta: { type: 'string', width: 220 },
  },
  {
    accessorFn: (visit) => visit.corrections.length,
    cell: (info) =>
      info.getValue<number>() === 0 ? (
        <span className="text-fg-secondary">—</span>
      ) : (
        <Badge size="sm" variant="warning">{`Opraveno ${String(info.getValue<number>())}×`}</Badge>
      ),
    header: 'Opravy',
    id: 'corrections',
    meta: { type: 'number', width: 110 },
  },
];

/** Summary of one client: last contact, owner, next planned contact (C02 + C06 facts, no guesses). */
const ClientFocus = ({
  clientId,
  onRecord,
  records,
}: {
  readonly clientId: string;
  readonly onRecord: (() => void) | undefined;
  readonly records: RecordsResponse;
}) => {
  const { language, t } = useModernI18n();
  const client = records.state.clients.items.find((entry) => entry.id === clientId);
  if (client === undefined) {
    return (
      <EmptyState
        description="Klient neexistuje nebo k němu nemáte přístup."
        title={t('crm.ciClientsVisits.clients.cannotDisplay')}
      />
    );
  }
  const today = localDay(records.now);
  const last = lastVisitOf(records.state.visits.items, clientId);
  const next = nextPlanItemOf(records.state.visits.plan, clientId);
  const count = records.state.visits.items.filter((visit) => visit.clientId === clientId).length;
  return (
    <SectionCard
      actions={
        <>
          <a
            className="inline-flex items-center gap-50 font-medium underline text-sm underline-offset-2 hover:underline"
            href={`/${language ?? 'cs'}/crm/klienti?klient=${encodeURIComponent(clientId)}`}
          >
            <span aria-hidden="true" className="icon-[mdi--card-account-details-outline] size-200" />
            Karta klienta
          </a>
          {onRecord !== undefined && (
            <Button icon="icon-[mdi--plus]" onClick={onRecord} size="sm" variant="primary">
              Zapsat návštěvu
            </Button>
          )}
        </>
      }
      title={client.name}
    >
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-50">
          <span className="text-fg-secondary text-xs">Poslední kontakt</span>
          {last === undefined ? (
            <span className="text-fg-secondary text-sm">bez záznamu</span>
          ) : (
            <span className="text-sm">
              <span className="font-medium">{pipe(last.occurredAt, localDay, formatDay)}</span>
              {` · ${relativeDay(localDay(last.occurredAt), today)} · ${visitKindMeta[last.kind].label}`}
            </span>
          )}
        </div>
        <div className="flex flex-col gap-50">
          <span className="text-fg-secondary text-xs">Přidělený obchodník</span>
          <span className="text-sm">{salespersonLabel(records, client.ownerSalespersonId)}</span>
        </div>
        <div className="flex flex-col gap-50">
          <span className="text-fg-secondary text-xs">Příští plánovaný kontakt</span>
          {next === undefined ? (
            <span className="text-fg-secondary text-sm">nenaplánováno</span>
          ) : (
            <span className="text-sm">
              <span className="font-medium">{formatDay(next.dueDate)}</span>
              {` · ${relativeDay(next.dueDate, today)}`}
            </span>
          )}
        </div>
        <div className="flex flex-col gap-50">
          <span className="text-fg-secondary text-xs">Zapsané kontakty</span>
          <span className="text-sm tabular-nums">{formatNumber(count)}</span>
        </div>
      </div>
    </SectionCard>
  );
};

const renderVisitResults = ({
  canWrite,
  clientFilter,
  filtered,
  handleClear,
  handleOpen,
  handleRecord,
  records,
  view,
  visible,
}: {
  readonly canWrite: boolean;
  readonly clientFilter: string;
  readonly filtered: boolean;
  readonly handleClear: () => void;
  readonly handleOpen: (visit: Visit) => void;
  readonly handleRecord: () => void;
  readonly records: RecordsResponse;
  readonly view: string;
  readonly visible: Visit[];
}) => {
  if (view !== 'timeline') {
    return (
      <DataTable
        columns={columns(records)}
        data={visible}
        enablePagination
        enableSorting
        getRowId={(row) => row.id}
        getRowLabel={(row) => `${clientLabel(records, row.original.clientId)} – ${row.original.result}`}
        maxHeight="calc(100dvh - 20rem)"
        onRowClick={(row) => handleOpen(row.original)}
        pageSizeOptions={[50, 100]}
        paginationProps={crmPaginationProps}
        size="sm"
        stickyHeader
        tableLayout="fixed"
        translations={crmTableTranslations}
      />
    );
  }
  if (visible.length > 0) {
    return (
      <SectionCard>
        <VisitTimeline onOpen={handleOpen} records={records} showClient={clientFilter === ALL} visits={visible} />
      </SectionCard>
    );
  }
  let emptyAction;
  if (filtered) {
    emptyAction = (
      <Button onClick={handleClear} size="sm" theme="outlined" variant="secondary">
        Zrušit filtry
      </Button>
    );
  } else if (canWrite) {
    emptyAction = (
      <Button onClick={handleRecord} size="sm" theme="outlined" variant="secondary">
        Zapsat návštěvu
      </Button>
    );
  }
  return (
    <SectionCard>
      <EmptyState
        action={emptyAction}
        description={filtered ? 'Upravte filtry nebo období.' : 'Zatím tu nejsou žádné zapsané kontakty.'}
        title={filtered ? 'Filtrům neodpovídá žádný záznam' : 'Bez záznamů'}
      />
    </SectionCard>
  );
};

const VisitsContent = ({ initialClient }: { readonly initialClient: string | null }) => {
  const { t } = useModernI18n();
  const { busy, load, state, submit } = useCrmRecords();
  const [filters, setFilters] = useState(() => ({
    clientFilter: initialClient ?? ALL,
    kindFilter: ALL,
    period: '90',
    salespersonFilter: ALL,
    search: '',
  }));
  const { clientFilter, kindFilter, period, salespersonFilter, search } = filters;
  const patchForm = (patch: Partial<typeof filters>) => setFilters((current) => ({ ...current, ...patch }));
  const [view, setView] = useState('timeline');
  const [recordOpen, setRecordOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | undefined>();
  const [correctId, setCorrectId] = useState<string | undefined>();

  return (
    <CrmStateGate onRetry={load} state={state}>
      {(records) => {
        const today = localDay(records.now);
        const all = sortVisitsDesc(records.state.visits.items);
        const canWrite = canWriteVisits(records) && writableClients(records).length > 0;
        const days = periods.find((entry) => entry.value === period)?.days ?? 90;
        const visible = all.filter(
          (visit) =>
            (clientFilter === ALL || visit.clientId === clientFilter) &&
            (salespersonFilter === ALL || visit.salespersonId === salespersonFilter) &&
            (kindFilter === ALL || visit.kind === kindFilter) &&
            daysBetween(localDay(visit.occurredAt), today) <= days &&
            (search.trim() === '' || matchesSearch(visitSearchText(records, visit), search)),
        );
        const last30 = all.filter((visit) => daysBetween(localDay(visit.occurredAt), today) <= 30);
        const activeClients = records.state.clients.items.filter((client) => client.status === 'active');
        const quiet = activeClients.filter((client) => {
          const last = lastVisitOf(all, client.id);
          return last === undefined || daysBetween(localDay(last.occurredAt), today) > 60;
        });
        const filtered =
          search.trim() !== '' ||
          clientFilter !== ALL ||
          salespersonFilter !== ALL ||
          kindFilter !== ALL ||
          period !== '90';
        const detail = all.find((visit) => visit.id === detailId);
        const correcting = all.find((visit) => visit.id === correctId);
        const writableIds = new Set<string>(writableClients(records).map((client) => client.id));
        const recordClient: Pick<ComponentProps<typeof RecordVisitPanel>, 'clientId'> = {};
        if (clientFilter !== ALL && writableIds.has(clientFilter)) {
          Object.assign(recordClient, { clientId: clientFilter });
        }
        const clearFilters = () => {
          setFilters({ clientFilter: ALL, kindFilter: ALL, period: '90', salespersonFilter: ALL, search: '' });
        };
        return (
          <>
            <PageHeader
              actions={
                canWrite ? (
                  <Button icon="icon-[mdi--plus]" onClick={() => setRecordOpen(true)} size="sm" variant="primary">
                    Zapsat návštěvu
                  </Button>
                ) : undefined
              }
              description={t('crm.pages.visits.description')}
              title={t('crm.pages.visits.title')}
            />
            <StatRow>
              <StatCard
                hint="všechny typy kontaktu"
                label={t('crm.ciClientsVisits.visits.contactsLast30Days')}
                value={formatNumber(last30.length)}
              />
              <StatCard
                label={t('crm.ciClientsVisits.visits.inPersonLast30Days')}
                value={formatNumber(last30.filter((visit) => visit.kind === 'visit').length)}
              />
              <StatCard
                hint="aktivní klienti bez kontaktu za 60 dní"
                label={t('crm.ciClientsVisits.clients.withoutContact')}
                value={formatNumber(quiet.length)}
              />
              <StatCard
                hint="opravy se nepřepisují, zůstávají v historii"
                label={t('crm.ciClientsVisits.visits.correctedRecords')}
                value={formatNumber(all.filter((visit) => visit.corrections.length > 0).length)}
              />
            </StatRow>
            <CrmScopeNote records={records} />

            {clientFilter !== ALL && (
              <ClientFocus
                clientId={clientFilter}
                onRecord={writableIds.has(clientFilter) ? () => setRecordOpen(true) : undefined}
                records={records}
              />
            )}

            <div className="flex flex-wrap items-end gap-150">
              <Input
                aria-label={t('crm.ciClientsVisits.visits.searchLabel')}
                className="w-64"
                onChange={(event) => patchForm({ search: event.target.value })}
                placeholder={t('crm.ciClientsVisits.visits.searchPlaceholder')}
                size="sm"
                type="search"
                value={search}
              />
              <div className="w-56">
                <SelectTemplate
                  items={[
                    { label: 'Všichni klienti', value: ALL },
                    ...records.state.clients.items
                      .toSorted((left, right) => left.name.localeCompare(right.name, 'cs'))
                      .map((client) => ({ label: client.name, value: client.id })),
                  ]}
                  label={t('crm.ciClientsVisits.fields.client')}
                  name="clientFilter"
                  onValueChange={(details) => patchForm({ clientFilter: details.value[0] ?? ALL })}
                  size="sm"
                  value={[clientFilter]}
                />
              </div>
              {canSeeEverything(records.viewer) && (
                <div className="w-48">
                  <SelectTemplate
                    items={[
                      { label: 'Všichni obchodníci', value: ALL },
                      ...records.state.salespeople.map((person) => ({
                        label: person.active ? person.name : `${person.name} (vyřazen)`,
                        value: person.id,
                      })),
                    ]}
                    label={t('crm.ciClientsVisits.fields.salesperson')}
                    name="salespersonFilter"
                    onValueChange={(details) => patchForm({ salespersonFilter: details.value[0] ?? ALL })}
                    size="sm"
                    value={[salespersonFilter]}
                  />
                </div>
              )}
              <div className="w-44">
                <SelectTemplate
                  items={[
                    { label: 'Všechny typy', value: ALL },
                    ...visitKinds.map((kind) => ({ label: visitKindMeta[kind].label, value: kind })),
                  ]}
                  label={t('crm.ciClientsVisits.fields.type')}
                  name="kindFilter"
                  onValueChange={(details) => patchForm({ kindFilter: details.value[0] ?? ALL })}
                  size="sm"
                  value={[kindFilter]}
                />
              </div>
              <div className="w-44">
                <SelectTemplate
                  items={periods.map((entry) => ({ label: entry.label, value: entry.value }))}
                  label={t('crm.ciClientsVisits.fields.period')}
                  name="period"
                  onValueChange={(details) => patchForm({ period: details.value[0] ?? '90' })}
                  size="sm"
                  value={[period]}
                />
              </div>
              {filtered && (
                <Button onClick={clearFilters} size="sm" theme="borderless" variant="secondary">
                  Zrušit filtry
                </Button>
              )}
            </div>

            <Tabs onValueChange={setView} value={view} variant="line">
              <Tabs.List>
                <Tabs.Trigger value="timeline">{`Časová osa (${String(visible.length)})`}</Tabs.Trigger>
                <Tabs.Trigger value="table">Tabulka</Tabs.Trigger>
                <Tabs.Indicator />
              </Tabs.List>
            </Tabs>

            {renderVisitResults({
              canWrite,
              clientFilter,
              filtered,
              handleClear: clearFilters,
              handleOpen: (visit) => setDetailId(visit.id),
              handleRecord: () => setRecordOpen(true),
              records,
              view,
              visible,
            })}

            {recordOpen && (
              <RecordVisitPanel
                busy={busy}
                {...recordClient}
                onOpenChange={setRecordOpen}
                open={recordOpen}
                records={records}
                submit={submit}
              />
            )}
            <VisitDetailPanel
              canCorrect={detail !== undefined && writableIds.has(detail.clientId)}
              onClose={() => setDetailId(undefined)}
              onCorrect={(visit) => {
                setDetailId(undefined);
                setCorrectId(visit.id);
              }}
              onOpenClient={(clientId) => {
                setDetailId(undefined);
                patchForm({ clientFilter: clientId });
              }}
              records={records}
              visit={detail}
            />
            <CorrectVisitPanel
              busy={busy}
              onClose={() => setCorrectId(undefined)}
              records={records}
              submit={submit}
              visit={correcting}
            />
          </>
        );
      }}
    </CrmStateGate>
  );
};

export const VisitsPage = () => {
  const { klient } = useCrmRouteSearch();
  const initialClient = klient === undefined || klient === '' ? null : klient;
  return (
    <CrmPage titleKey="crm.pages.visits.title">
      <VisitsContent initialClient={initialClient} key={initialClient ?? 'all'} />
    </CrmPage>
  );
};

/** The Shell awaits this before it reveals the page, so the first render already has the records. */
export { preloadCrmRecords as preloadPage } from '../../../../crm/records.ts';
export default VisitsPage;
