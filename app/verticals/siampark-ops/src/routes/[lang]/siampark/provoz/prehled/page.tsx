// @effect-diagnostics asyncFunction:off globalDate:off
// Siampark provoz — přehled (S15). OWNED BY THE `agenda` LANE (ops-agenda).
// Every KPI is computed from a governed source read (definition, source and read time shown on the tile); a source
// the person may not read or that is down shows „bez oprávnění“ / „zdroj nedostupný“, never a zero. Clicking a tile
// lists exactly the counted records (S15-01) with CSV export of those rows only (S15-02). Global search covers only
// records the person can read.
import { PageHeader } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { useEffect, useMemo, useState } from 'react';
import { AgendaFrame } from '../../../../../ui/agenda-frame.tsx';
import { pragueToday } from '../../../../../ui/ops-agenda/deadlines.ts';
import { currentAgendaState, buildDeadlines, buildKpis, buildSearchIndex } from '../../../../../ui/ops-agenda/model.ts';
import type { KpiId } from '../../../../../ui/ops-agenda/model.ts';
import { allSettled, useSiamparkSources } from '../../../../../ui/ops-agenda/sources.ts';
import { Icon, fmt, langOf } from '../../../../../ui/ops-agenda/ui-bits.tsx';
import { UltramodernRouteHead } from '../../../../ultramodern-route-head';
import { DrillDown, Hero, KpiGrid, OccupancyByBuilding, OpsAgendas, SearchResults, UpcomingTimeline } from './dashboard-parts.tsx';

const kpiIds: readonly KpiId[] = [
  'occupancy',
  'properties',
  'leases',
  'overdueInvoices',
  'openTasks',
  'incidents',
  'deadlines',
  'contracts',
  'salesCases',
  'planActual',
];

const readKpiParam = (): KpiId | undefined => {
  if (typeof window === 'undefined') {
    return undefined;
  }
  const value = new URLSearchParams(window.location.search).get('kpi');
  return kpiIds.find((id) => id === value);
};

const OverviewView = () => {
  const { language, t } = useModernI18n();
  const lang = langOf(language);
  const { names, reload, sources } = useSiamparkSources();
  const [today] = useState(() => pragueToday());
  const [selected, setSelected] = useState<KpiId | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    setSelected(readKpiParam());
  }, []);

  const deadlines = useMemo(() => buildDeadlines(sources, names), [sources, names]);
  const kpis = useMemo(() => buildKpis(sources, names, deadlines, today), [sources, names, deadlines, today]);
  const index = useMemo(() => buildSearchIndex(sources, names), [sources, names]);
  const agendaState = useMemo(() => currentAgendaState(sources, deadlines, today), [sources, deadlines, today]);
  const me = sources.ops.data?.actorPrincipalRef.principalId ?? sources.work.data?.actorPrincipalRef.principalId;
  const unread = (agendaState?.notifications ?? []).filter(
    (entry) => entry.recipient.principalId === me && entry.readAt === undefined,
  ).length;
  const settled = allSettled(sources);
  const lastRead = Object.values(sources)
    .map((source) => source.loadedAt)
    .filter((value): value is string => value !== undefined)
    .toSorted()
    .at(-1);

  const select = (id: KpiId | undefined) => {
    setSelected(id);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      if (id === undefined) {
        url.searchParams.delete('kpi');
      } else {
        url.searchParams.set('kpi', id);
      }
      window.history.replaceState(window.history.state, '', url);
      if (id !== undefined) {
        window.requestAnimationFrame(() =>
          document.getElementById('ops-overview-drilldown')?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        );
      }
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  };

  const selectedKpi = kpis.find((kpi) => kpi.id === selected);
  const agendaEnvelope = sources.ops.data?.agendas.agenda;

  return (
    <>
      <PageHeader
        actions={
          <>
            <a
              className="siamparkops:inline-flex siamparkops:items-center siamparkops:gap-2 siamparkops:rounded-lg siamparkops:px-3 siamparkops:py-1.5 siamparkops:text-sm siamparkops:font-medium siamparkops:no-underline"
              href={`/${lang}/siampark/provoz/agenda`}
              style={{ border: '1px solid var(--color-border-primary, #d1d5db)', color: 'inherit' }}
            >
              <Icon name="calendar" size={18} />
              {t('siampark-ops.agenda.overview.openCalendar')}
            </a>
            <Button
              isLoading={refreshing}
              loadingText={t('siampark-ops.common.loading')}
              onClick={() => void refresh()}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              {t('siampark-ops.agenda.overview.refresh')}
            </Button>
          </>
        }
        description={t('siampark-ops.agenda.overview.description')}
        meta={
          lastRead === undefined ? undefined : (
            <span className="siamparkops:text-xs" style={{ color: 'var(--color-fg-secondary, #6b7280)' }}>
              {t('siampark-ops.agenda.overview.dataAt', { time: fmt.stamp(lang, lastRead) })}
            </span>
          )
        }
        title={t('siampark-ops.agenda.overview.title')}
      />
      <Hero
        deadlines={deadlines}
        kpis={kpis}
        me={me}
        onQuery={setQuery}
        query={query}
        sources={sources}
        today={today}
        unread={unread}
      />
      {query.trim() !== '' && (
        <SearchResults
          agendaRevision={agendaEnvelope?.revision ?? 0}
          canLog={agendaEnvelope?.canWrite === true}
          index={index}
          onClear={() => setQuery('')}
          query={query}
          sources={sources}
        />
      )}
      <KpiGrid kpis={kpis} onSelect={(id) => select(id === selected ? undefined : id)} selected={selected} settled={settled} />
      {selectedKpi !== undefined && (
        <DrillDown
          agendaRevision={agendaEnvelope?.revision ?? 0}
          canLog={agendaEnvelope?.canWrite === true}
          kpi={selectedKpi}
          onClose={() => select(undefined)}
        />
      )}
      <div className="siamparkops:grid siamparkops:grid-cols-1 siamparkops:gap-4 siamparkops:xl:grid-cols-5">
        <div className="siamparkops:xl:col-span-3">
          <UpcomingTimeline deadlines={deadlines} sources={sources} today={today} />
        </div>
        <div className="siamparkops:xl:col-span-2">
          <OccupancyByBuilding sources={sources} today={today} />
        </div>
      </div>
      <OpsAgendas sources={sources} />
    </>
  );
};

export const OverviewPage = () => (
  <AgendaFrame>
    <UltramodernRouteHead titleKey="siampark-ops.agenda.overview.title" />
    <OverviewView />
  </AgendaFrame>
);

export default OverviewPage;
