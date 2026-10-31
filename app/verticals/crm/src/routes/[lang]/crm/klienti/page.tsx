import { DateTime, Effect, Schema, Option } from 'effect';
import { PageHeader, formatNumber } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Input } from '@techsio/ui-kit/atoms/input';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { useState } from 'react';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import { canSeeEverything } from '../../../../../shared/domain/access.ts';
import { uncorrelatedCustomerLinks } from '../../../../../shared/commands/clients.ts';
import { toCsv } from '../../../../../shared/domain/reports.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { CrmPage } from '../../../../crm/crm-page.tsx';
import { useCrmRecords } from '../../../../crm/records.ts';
import { CrmStateGate, useCrmRouteSelection, crmPaginationProps, crmTableTranslations } from '../../../../crm/ui.tsx';
import { CrmSalesKpiStrip } from '../prehled-prodeju/sales-kpi-strip.tsx';
import { downloadCsv } from '../prehled-prodeju/report-format.ts';
import { ClientCard } from './client-card.tsx';
import { ClientFormDialog } from './client-form-dialog.tsx';
import { TeamPanel } from './team-panel.tsx';
import { clientSegments, contactsCsv, segmentLabels } from './clients-model.ts';
import ClientFilterPanel from './client-filter-panel.tsx';
import { clientColumns, contactColumns } from './client-table-columns.tsx';
import {
  KPI_ALL,
  KPI_UNASSIGNED,
  clientQueryForViewer,
  buildClientRows,
  buildContactRows,
  filterClientRows,
  filterContactRows,
  defaultClientFilters,
  metricCount,
  kpiMetricEntity,
  clientMetricsForViewer,
  kpiEntities,
  metricQuery,
  selectedMetric,
  parseClientQuery,
  serializeClientQuery,
  resetClientFilters,
  sameClientFilters,
  kpiStatusOf as clientStatusOf,
  kpiRegistryOf as clientRegistryOf,
  kpiRecencyOf as clientRecencyOf,
  kpiSegmentOf as clientSegmentOf,
} from './client-filters.ts';
import type { ClientEntity, ClientFilters, ClientMetric, ClientQuery } from './client-filters.ts';

const statusArchivedKey = 'crm.clientFilters.filters.statusArchived';
const metricLabelKey = {
  activeClients: 'crm.clientFilters.metrics.activeClients',
  archivedClients: 'crm.clientFilters.metrics.archivedClients',
  contactedRecently: 'crm.clientFilters.metrics.contactedRecently',
  contacts: 'crm.clientFilters.metrics.contacts',
  linkedActive: 'crm.clientFilters.metrics.linkedActive',
  unassignedClients: 'crm.clientFilters.metrics.unassignedClients',
  unlinkedActive: 'crm.clientFilters.metrics.unlinkedActive',
} satisfies Record<ClientMetric, string>;
const entityLabelKey = { client: 'crm.clientFilters.entity.client', contact: 'crm.clientFilters.entity.contact' };

/** `?klient=<id>` of the current URL. */
const useClientParam = () => {
  const [openId, setOpenId] = useCrmRouteSelection('klient');
  const setClient = (id: string | undefined) => {
    setOpenId(id);
    const url = new URL(globalThis.location.href);
    if (id === undefined) {
      url.searchParams.delete('klient');
    } else {
      url.searchParams.set('klient', id);
    }
    globalThis.history.replaceState(globalThis.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  };
  return [openId, setClient] as const;
};

const HistoryIndexSchema = Schema.Struct({ __TSR_index: Schema.Int });
const writeClientQuery = (query: ClientQuery, mode: 'push' | 'replace') => {
  const url = new URL(globalThis.location.href);
  url.search = serializeClientQuery(url.search, query);
  if (mode === 'replace') {
    globalThis.history.replaceState(globalThis.history.state, '', url);
    return;
  }
  const index = Option.match(Schema.decodeUnknownOption(HistoryIndexSchema)(globalThis.history.state), {
    onNone: () => 0,
    onSome: (state) => state.__TSR_index,
  });
  const key = `clients-${String(index + 1)}`;
  globalThis.history.pushState({ __TSR_index: index + 1, __TSR_key: key, key }, '', url);
};

interface FiltersBarProps {
  readonly entity: ClientEntity;
  readonly filters: ClientFilters;
  readonly manager: boolean;
  readonly onChange: (patch: Partial<ClientFilters>, mode: 'push' | 'replace') => void;
  readonly onReset: () => void;
  readonly records: RecordsResponse;
}

const FiltersBar = ({ entity, filters, manager, onChange, onReset, records }: FiltersBarProps) => {
  const { t } = useModernI18n();
  const active = !sameClientFilters(filters, defaultClientFilters);
  return (
    <div className="flex flex-col gap-100">
      <div className="flex flex-wrap items-end gap-150">
        <Input
          aria-label={t('crm.clientFilters.filters.search')}
          className="w-full sm:w-80"
          onChange={(event) => onChange({ search: event.target.value }, 'replace')}
          placeholder={t(
            entity === 'contact'
              ? 'crm.clientFilters.table.searchContacts'
              : 'crm.clientFilters.filters.searchPlaceholder',
          )}
          size="sm"
          type="search"
          value={filters.search}
        />
        <div className="w-full sm:w-44">
          <SelectTemplate
            items={[
              { label: t('crm.clientFilters.filters.statusActive'), value: 'active' },
              { label: t(statusArchivedKey), value: 'archived' },
              { label: t('crm.clientFilters.filters.statusAll'), value: 'all' },
            ]}
            label={t('crm.clientFilters.filters.status')}
            name="status"
            onValueChange={(details) => {
              const next = clientStatusOf(details.value[0]);
              if (next !== undefined) {
                onChange({ status: next }, 'push');
              }
            }}
            size="sm"
            value={[filters.status]}
          />
        </div>
        {manager && (
          <div className="w-full sm:w-52">
            <SelectTemplate
              items={[
                { label: t('crm.clientFilters.filters.ownerAll'), value: KPI_ALL },
                ...records.state.salespeople.map((person) => ({ label: person.name, value: person.id })),
                { label: t('crm.clientFilters.filters.ownerNone'), value: KPI_UNASSIGNED },
              ]}
              label={t('crm.clientFilters.filters.owner')}
              name="owner"
              onValueChange={(details) => onChange({ owner: details.value[0] ?? KPI_ALL }, 'push')}
              size="sm"
              value={[filters.owner]}
            />
          </div>
        )}
        {manager && (
          <div className="w-full sm:w-52">
            <SelectTemplate
              items={[
                { label: t('crm.clientFilters.filters.registryAll'), value: 'all' },
                { label: t('crm.clientFilters.filters.registryLinked'), value: 'linked' },
                { label: t('crm.clientFilters.filters.registryUnlinked'), value: 'unlinked' },
              ]}
              label={t('crm.clientFilters.filters.registry')}
              name="registry"
              onValueChange={(details) => {
                const next = clientRegistryOf(details.value[0]);
                if (next !== undefined) {
                  onChange({ registry: next }, 'push');
                }
              }}
              size="sm"
              value={[filters.registry]}
            />
          </div>
        )}
        <div className="w-full sm:w-48">
          <SelectTemplate
            items={[
              { label: t('crm.clientFilters.filters.recencyAll'), value: 'all' },
              { label: t('crm.clientFilters.filters.recency30'), value: 'recent30' },
            ]}
            label={t('crm.clientFilters.filters.recency')}
            name="recency"
            onValueChange={(details) => {
              const next = clientRecencyOf(details.value[0]);
              if (next !== undefined) {
                onChange({ recency: next }, 'push');
              }
            }}
            size="sm"
            value={[filters.recency]}
          />
        </div>
        <div className="w-full sm:w-52">
          <SelectTemplate
            items={[
              { label: t('crm.clientFilters.filters.segmentAll'), value: KPI_ALL },
              ...clientSegments.map((key) => ({ label: segmentLabels[key], value: key })),
            ]}
            label={t('crm.clientFilters.filters.segment')}
            name="segment"
            onValueChange={(details) => onChange({ segment: clientSegmentOf(details.value[0]) ?? KPI_ALL }, 'push')}
            size="sm"
            value={[filters.segment]}
          />
        </div>
        {active && (
          <Button
            icon="icon-[mdi--filter-remove-outline]"
            onClick={onReset}
            size="sm"
            theme="borderless"
            variant="secondary"
          >
            {t('crm.clientFilters.filters.reset')}
          </Button>
        )}
      </div>
    </div>
  );
};

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
  const search = useRouterState({ select: (state) => state.location.searchStr });
  const query = clientQueryForViewer(parseClientQuery(search), records.viewer);
  const manager = canSeeEverything(records.viewer);
  const canCreate = records.viewer.writeAll || records.viewer.writeAssigned;
  const [createOpen, setCreateOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const rows = buildClientRows(records);
  const visible = filterClientRows(records, rows, query.filters);
  const contacts = filterContactRows(records, buildContactRows(records), query.filters);
  const visibleCount = query.entity === 'contact' ? contacts.length : visible.length;
  const filtered = !sameClientFilters(query.filters, defaultClientFilters);
  const activeCount = metricCount(records, 'activeClients');
  const linkedCount = metricCount(records, 'linkedActive');
  const pendingCorrelations = uncorrelatedCustomerLinks(records.state);
  const toaster = useToast();
  const emptyDescription = filtered
    ? t('crm.clientFilters.table.adjustFilters')
    : t(manager ? 'crm.clientFilters.table.emptyManager' : 'crm.clientFilters.table.emptyAssigned');
  const groups = kpiEntities.map((entity) => ({
    entity,
    label: t(entityLabelKey[entity]),
    metrics: clientMetricsForViewer(records.viewer).flatMap((metricId) =>
      kpiMetricEntity(metricId) === entity
        ? [
            {
              countLabel: formatNumber(metricCount(records, metricId)),
              label: t(metricLabelKey[metricId]),
              metricId,
            },
          ]
        : [],
    ),
  }));
  const exportCsv =
    query.entity === 'contact'
      ? toCsv(
          [
            t('crm.clientFilters.table.person'),
            t('crm.clientFilters.table.role'),
            t('crm.clientFilters.table.email'),
            t('crm.clientFilters.table.phone'),
            t('crm.clientFilters.table.owningClient'),
          ],
          contacts.map((row) => [
            row.contact.name,
            row.contact.role,
            row.contact.email,
            row.contact.phone,
            row.client.name,
          ]),
        )
      : contactsCsv(
          records,
          visible.map((row) => row.client),
        );
  return (
    <>
      <PageHeader
        actions={
          <div className="flex flex-wrap gap-100">
            <Button
              disabled={visibleCount === 0}
              icon="icon-[mdi--download]"
              onClick={() => downloadCsv(exportCsv, `kontakty-${DateTime.formatIsoDateUtc(records.now)}.csv`)}
              size="sm"
              theme="outlined"
              title={t('crm.ciClientsVisits.clients.exportDescription')}
              variant="secondary"
            >
              {t('crm.clientFilters.actions.export')}
            </Button>
            {records.viewer.assign && (
              <Button
                icon="icon-[mdi--account-group-outline]"
                onClick={() => setTeamOpen(true)}
                size="sm"
                theme="outlined"
                variant="secondary"
              >
                {t('crm.clientFilters.actions.team')}
              </Button>
            )}
            {canCreate && (
              <Button icon="icon-[mdi--plus]" onClick={() => setCreateOpen(true)} size="sm" variant="primary">
                {t('crm.clientFilters.actions.create')}
              </Button>
            )}
          </div>
        }
        description={manager ? t('crm.pages.clients.description') : t('crm.clientFilters.assignedDescription')}
        title={manager ? t('crm.pages.clients.title') : t('crm.clientFilters.assignedTitle')}
      />
      {records.viewer.writeAll && (activeCount > linkedCount || pendingCorrelations > 0) && (
        <div className="flex flex-wrap items-center justify-between gap-150 rounded-lg bg-bg-light-warning-base px-200 py-150">
          <p className="text-sm">
            {activeCount > linkedCount
              ? `${formatNumber(activeCount - linkedCount)} aktivních klientů zatím nemá identitu v evidenci zákazníků.`
              : `${formatNumber(pendingCorrelations)} schválených externích ID zákazníků čeká na převod na evidenci zákazníků.`}{' '}
            Systém je založí nebo dohledá podle IČO a názvu a propojí.
          </p>
          <Button
            disabled={busy}
            icon="icon-[mdi--link-variant]"
            onClick={() => {
              browserRuntime.runFork(
                submit({ _tag: 'SyncClientParties' }).pipe(
                  Effect.tap((outcome) =>
                    Effect.sync(() =>
                      toaster.create(
                        outcome.ok
                          ? { title: 'Klienti propojeni s evidencí zákazníků', type: 'success' }
                          : {
                              description: outcome.message ?? 'Zkuste to prosím znovu.',
                              title: 'Propojení se nezdařilo',
                              type: 'error',
                            },
                      ),
                    ),
                  ),
                ),
              );
            }}
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            Propojit s evidencí zákazníků
          </Button>
        </div>
      )}

      <ClientFilterPanel
        groups={groups}
        label={t('crm.clientFilters.navigation')}
        onOpenMetric={(metric) => writeClientQuery(metricQuery(metric), 'push')}
        selectedMetric={selectedMetric(query, records.viewer)}
      >
        <div className="flex min-w-0 flex-col gap-200">
          <FiltersBar
            entity={query.entity}
            filters={query.filters}
            manager={manager}
            onChange={(patch, mode) => writeClientQuery({ ...query, filters: { ...query.filters, ...patch } }, mode)}
            onReset={() => writeClientQuery(resetClientFilters(query), 'push')}
            records={records}
          />
          {query.entity === 'contact' ? (
            <DataTable
              columns={contactColumns(t)}
              data={contacts}
              enablePagination
              enableSorting
              getRowId={(row) => row.contact.id}
              getRowLabel={(row) => row.original.contact.name}
              key="contacts"
              onRowClick={(row) => onOpen(row.original.client.id)}
              pageSizeOptions={[25, 50, 100]}
              paginationProps={crmPaginationProps}
              size="sm"
              tableLayout="fixed"
              translations={{
                ...crmTableTranslations,
                emptyDescription,
                emptyTitle: t('crm.clientFilters.table.emptyContacts'),
              }}
            />
          ) : (
            <DataTable
              columns={clientColumns(t, { manager, showStatus: query.filters.status === 'all' })}
              data={visible}
              enablePagination
              enableSorting
              getRowId={(row) => row.client.id}
              getRowLabel={(row) => row.original.client.name}
              key="clients"
              onRowClick={(row) => onOpen(row.original.client.id)}
              pageSizeOptions={[25, 50, 100]}
              paginationProps={crmPaginationProps}
              size="sm"
              tableLayout="fixed"
              translations={{
                ...crmTableTranslations,
                emptyDescription,
                emptyTitle: t('crm.clientFilters.table.emptyClients'),
              }}
            />
          )}
        </div>
      </ClientFilterPanel>
      {records.state.imports.orders.length > 0 && <CrmSalesKpiStrip records={records} />}
      {teamOpen && <TeamPanel busy={busy} onClose={() => setTeamOpen(false)} records={records} submit={submit} />}
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
  const { t } = useModernI18n();
  const { busy, load, state, submit } = useCrmRecords();
  const [openId, setOpenId] = useClientParam();
  return (
    <CrmStateGate loadingTitle={t('crm.pages.clients.title')} onRetry={load} state={state}>
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

/** The Shell awaits this before it reveals the page, so the first render already has the records. */
export { preloadCrmRecords as preloadPage } from '../../../../crm/records.ts';
export default ClientsPage;
