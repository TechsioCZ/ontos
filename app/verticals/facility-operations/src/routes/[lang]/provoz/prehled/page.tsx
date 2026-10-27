// Facility operations — přehled (S15). OWNED BY THE `agenda` LANE (ops-agenda).
// Every KPI is computed from a governed source read (definition, source and read time shown on the tile); a source
// the person may not read or that is down shows „bez oprávnění“ / „zdroj nedostupný“, never a zero. Clicking a tile
// lists exactly the counted records (S15-01) with CSV export of those rows only (S15-02). Global search covers only
// records the person can read.
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import { PageHeader } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { useEffect, useState } from 'react';
import { Array as EffectArray, Effect, Option, Order, Schema } from 'effect';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { AgendaFrame } from '../../../../ui/agenda-frame.tsx';
import { pragueToday } from '../../../../ui/ops-agenda/deadlines.ts';
import {
  currentAgendaState,
  buildDeadlines,
  buildKpis,
  buildSearchIndex,
  KpiIdSchema,
} from '../../../../ui/ops-agenda/model.ts';
import type { KpiId } from '../../../../ui/ops-agenda/model.ts';
import { allSettled, sourceKeys, useRentalOverviewSources } from '../../../../ui/ops-agenda/sources.ts';
import { Icon, fmt, langOf } from '../../../../ui/ops-agenda/ui-bits.tsx';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import {
  DrillDown,
  Hero,
  KpiGrid,
  OccupancyByBuilding,
  OpsAgendas,
  SearchResults,
  UpcomingTimeline,
} from './dashboard-parts.tsx';

// The Shell supplies this raw query string on both server and client renders.
const overviewSearchSchema = Schema.Struct({ kpi: Schema.OptionFromNullOr(KpiIdSchema) });
const decodeSearchParams = Schema.decodeOption(Schema.toCodecJson(Schema.URLSearchParams));
const decodeOverviewSearch = Schema.decodeUnknownOption(overviewSearchSchema);
const readKpiParam = (search: string): KpiId | undefined =>
  decodeSearchParams(search).pipe(
    Option.flatMap((params) => decodeOverviewSearch({ kpi: params.get('kpi') })),
    Option.flatMap(({ kpi }) => kpi),
    Option.getOrUndefined,
  );

const OverviewView = ({
  displayName,
  search,
}: {
  readonly displayName: string | undefined;
  readonly search: string;
}) => {
  const { language, t } = useModernI18n();
  const lang = langOf(language);
  const { loadSearch, names, reload, sources } = useRentalOverviewSources();
  const [view, setView] = useState(() => ({ selected: readKpiParam(search), today: pragueToday() }));
  const { selected, today } = view;
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  // Search rows of the provoz records are fetched only when someone actually searches.
  useEffect(() => {
    if (query.trim() !== '') {
      loadSearch();
    }
  }, [query, loadSearch]);

  const deadlines = buildDeadlines(sources, names);
  const kpis = buildKpis({ deadlines, names, sources, today });
  const index = buildSearchIndex(sources, names);
  const agendaState = currentAgendaState(sources, deadlines, today);
  const me = sources.ops.data?.actorPrincipalRef.principalId ?? sources.work.data?.actorPrincipalRef.principalId;
  const unread = (agendaState?.notifications ?? []).filter(
    (entry) => entry.recipient.principalId === me && entry.readAt === undefined,
  ).length;
  const settled = allSettled(sources);
  const lastRead = EffectArray.sort(
    sourceKeys.map((key) => sources[key].loadedAt).filter((value): value is string => value !== undefined),
    Order.String,
  ).at(-1);

  const select = (id?: KpiId) => {
    setView((current) => ({ ...current, selected: id }));
    if ('window' in globalThis) {
      const url = new URL(window.location.href);
      if (id === undefined) {
        url.searchParams.delete('kpi');
      } else {
        url.searchParams.set('kpi', id);
      }
      window.history.replaceState(window.history.state, '', url);
      if (id !== undefined) {
        window.requestAnimationFrame(() =>
          document.querySelector('#ops-overview-drilldown')?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        );
      }
    }
  };

  const refresh = () => {
    setRefreshing(true);
    browserRuntime.runFork(reload().pipe(Effect.ensuring(Effect.sync(() => setRefreshing(false)))));
  };

  const selectedKpi = kpis.find((kpi) => kpi.id === selected);
  const agendaEnvelope = sources.ops.data?.agenda;

  return (
    <>
      <PageHeader
        actions={
          <>
            <a
              className="facilityoperations:inline-flex facilityoperations:items-center facilityoperations:gap-2 facilityoperations:rounded-lg facilityoperations:px-3 facilityoperations:py-1.5 facilityoperations:text-sm facilityoperations:font-medium facilityoperations:no-underline"
              href={`/${lang}/provoz/agenda`}
              style={{ border: '1px solid var(--color-border-primary, #d1d5db)', color: 'inherit' }}
            >
              <Icon name="calendar" size={18} />
              {t('facility-operations.agenda.overview.openCalendar')}
            </a>
            <Button
              isLoading={refreshing}
              loadingText={t('facility-operations.common.loading')}
              onClick={refresh}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              {t('facility-operations.agenda.overview.refresh')}
            </Button>
          </>
        }
        description={t('facility-operations.agenda.overview.description')}
        meta={
          lastRead === undefined ? undefined : (
            <span className="facilityoperations:text-xs" style={{ color: 'var(--color-fg-secondary, #6b7280)' }}>
              {t('facility-operations.agenda.overview.dataAt', { time: fmt.stamp(lang, lastRead) })}
            </span>
          )
        }
        title={t('facility-operations.agenda.overview.title')}
      />
      <Hero
        deadlines={deadlines}
        displayName={displayName}
        kpis={kpis}
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
      <KpiGrid
        kpis={kpis}
        onSelect={(id) => select(id === selected ? undefined : id)}
        selected={selected}
        settled={settled}
      />
      {selectedKpi !== undefined && (
        <DrillDown
          agendaRevision={agendaEnvelope?.revision ?? 0}
          canLog={agendaEnvelope?.canWrite === true}
          kpi={selectedKpi}
          onClose={() => select()}
        />
      )}
      <div className="facilityoperations:grid facilityoperations:grid-cols-1 facilityoperations:gap-4 facilityoperations:xl:grid-cols-5">
        <div className="facilityoperations:xl:col-span-3">
          <UpcomingTimeline deadlines={deadlines} sources={sources} today={today} />
        </div>
        <div className="facilityoperations:xl:col-span-2">
          <OccupancyByBuilding sources={sources} today={today} />
        </div>
      </div>
      <OpsAgendas sources={sources} />
    </>
  );
};

export const OverviewPage = ({ context, search = '' }: Partial<ModulePageProps>) => (
  <AgendaFrame>
    <UltramodernRouteHead titleKey="facility-operations.agenda.overview.title" />
    <OverviewView displayName={context?.displayName} search={search} />
  </AgendaFrame>
);

/** The Shell awaits this before it reveals the page, so the KPI tiles render values in the first commit. */
export { preloadRentalOverviewSources as preloadPage } from '../../../../ui/ops-agenda/sources.ts';
export default OverviewPage;
