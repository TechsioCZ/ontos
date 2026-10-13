import { PageHeader, SectionCard } from '@app/admin-ui';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { DateTime } from 'effect';
import { useSyncExternalStore } from 'react';
import csResource from '../../../../../locales/cs/sales-insights.json';
import enResource from '../../../../../locales/en/sales-insights.json';
import { computeKpis, computeMetric, metricCatalog } from '../../../../../shared/metrics.ts';
import type { CalendarDay } from '../../../../../shared/metrics.ts';
import { StatisticsControls } from '../../../../statistics/statistics-controls.tsx';
import { StatisticsResults } from '../../../../statistics/statistics-results.tsx';
import type { StatisticsQuery } from '../../../../statistics/statistics-query.ts';
import {
  coerceGrouping,
  defaultQuery,
  parseStatisticsQuery,
  serializeStatisticsQuery,
} from '../../../../statistics/statistics-query.ts';
import { useStatisticsInputs } from '../../../../statistics/use-statistics-inputs.ts';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import '../../../index.css';

const salesInsightsI18nResources = {
  cs: { 'sales-insights': csResource },
  en: { 'sales-insights': enResource },
} as const;

const key = 'sales-insights.pages.statistics';

const todayDay = (): CalendarDay => DateTime.formatIsoDateUtc(DateTime.nowUnsafe());

// The URL search string is the single source of truth for the query. `replaceState` fires no event,
// so writes dispatch a window event that the subscription listens to alongside popstate.
const urlChangeEvent = 'sales-insights:statistics-url';
const subscribeToUrl = (listener: () => void) => {
  window.addEventListener('popstate', listener);
  window.addEventListener(urlChangeEvent, listener);
  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener(urlChangeEvent, listener);
  };
};
const readUrlSearch = () => window.location.search;
const serverSearch = () => '';

const writeUrlSearch = (search: string) => {
  const url = new URL(window.location.href);
  url.search = search;
  window.history.replaceState(window.history.state, '', url);
  window.dispatchEvent(new Event(urlChangeEvent));
};

const StatisticsPageContent = () => {
  const { t } = useModernI18n();
  const today = todayDay();
  const search = useSyncExternalStore(subscribeToUrl, readUrlSearch, serverSearch);
  const query = parseStatisticsQuery(search, defaultQuery(today));
  const data = useStatisticsInputs();

  const onChange = (patch: Partial<StatisticsQuery>) => {
    const next = { ...query, ...patch };
    writeUrlSearch(serializeStatisticsQuery({ ...next, groupBy: coerceGrouping(next.metric, next.groupBy) }));
  };

  const metric = metricCatalog.find((entry) => entry.id === query.metric);
  const ready = data.status === 'ready';
  const result =
    data.status === 'ready'
      ? computeMetric(query.metric, data.inputs, { from: query.from, groupBy: query.groupBy, to: query.to, today })
      : undefined;
  const kpis =
    data.status === 'ready' ? computeKpis(data.inputs, { from: query.from, to: query.to, today }) : undefined;
  const failedText =
    data.status === 'ready' && data.failed.length > 0
      ? data.failed.map((source) => t(`${key}.sources.${source}`)).join(', ')
      : undefined;

  return (
    <>
      <UltramodernRouteHead />
      <section className="flex min-w-0 flex-col gap-250 text-fg-primary">
        <PageHeader description={t(`${key}.description`)} title={t(`${key}.title`)} />
        {failedText !== undefined && (
          <StatusText showIcon status="warning">
            {t(`${key}.sourceError`, { sources: failedText })}
          </StatusText>
        )}
        <div className="contents" data-uidotsh-pick="Statistiky: rozložení">
          <div className="contents" data-uidotsh-option="A: Panel vlevo">
            <div className="grid grid-cols-1 items-start gap-250 xl:grid-cols-[18rem_minmax(0,1fr)]">
              <SectionCard title={t(`${key}.controls`)}>
                <StatisticsControls id="left" layout="stack" onChange={onChange} query={query} today={today} />
              </SectionCard>
              <StatisticsResults kpis={kpis} loading={!ready} metric={metric} query={query} result={result} />
            </div>
          </div>
          <div className="contents" data-uidotsh-option="B: Lišta nahoře" hidden>
            <div className="flex min-w-0 flex-col gap-250">
              <SectionCard>
                <StatisticsControls id="top" layout="row" onChange={onChange} query={query} today={today} />
              </SectionCard>
              <StatisticsResults kpis={kpis} loading={!ready} metric={metric} query={query} result={result} />
            </div>
          </div>
        </div>
      </section>
    </>
  );
};

export const RecordsPage = () => {
  const location = useRouterState({ select: (state) => state.location.href });
  return (
    <FederatedI18nBoundary
      defaultNamespace="sales-insights"
      fallbackLanguage="en"
      resources={salesInsightsI18nResources}
      supportedLanguages={['en', 'cs']}
    >
      <StatisticsPageContent key={location} />
    </FederatedI18nBoundary>
  );
};

export default RecordsPage;
