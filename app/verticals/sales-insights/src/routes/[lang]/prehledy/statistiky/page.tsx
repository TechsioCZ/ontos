import { PageHeader, SectionCard } from '@app/admin-ui';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { DateTime } from 'effect';
import csResource from '../../../../../locales/cs/sales-insights.json';
import enResource from '../../../../../locales/en/sales-insights.json';
import { computeKpis, computeMetric, metricCatalog } from '../../../../../shared/metrics.ts';
import type { CalendarDay } from '../../../../../shared/metrics.ts';
import { isMetricForbidden } from '../../../../statistics/statistics-access.ts';
import { StatisticsControls } from '../../../../statistics/statistics-controls.tsx';
import { StatisticsResults } from '../../../../statistics/statistics-results.tsx';
import type { StatisticsQuery } from '../../../../statistics/statistics-query.ts';
import {
  coerceGrouping,
  defaultQuery,
  invertedRangeOf,
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

// The URL search string is the single source of truth for the query. The router tracks every URL write,
// including the `replaceState` calls below, so the page reads `searchStr` from router state. Writes never
// remount the page, which keeps the picker focused and the loaded data in place.
const writeUrlSearch = (search: string) => {
  const url = new URL(window.location.href);
  url.search = search;
  window.history.replaceState(window.history.state, '', url);
};

const StatisticsPageContent = () => {
  const { t } = useModernI18n();
  const today = todayDay();
  const search = useRouterState({ select: (state) => state.location.searchStr });
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
  // The StatRow takes only the period and the loaded inputs, so metric, chart and grouping changes cannot move it.
  const kpis =
    data.status === 'ready' ? computeKpis(data.inputs, { from: query.from, to: query.to, today }) : undefined;
  const forbidden = data.status === 'ready' ? data.forbidden : [];
  const forbiddenSet = new Set(forbidden);
  const forbiddenText =
    forbidden.length > 0 ? forbidden.map((source) => t(`${key}.sources.${source}`)).join(', ') : undefined;
  const failedText =
    data.status === 'ready' && data.failed.length > 0
      ? data.failed.map((source) => t(`${key}.sources.${source}`)).join(', ')
      : undefined;

  return (
    <>
      <UltramodernRouteHead />
      <section className="flex min-w-0 flex-col gap-250 text-fg-primary">
        <PageHeader description={t(`${key}.description`)} title={t(`${key}.title`)} />
        {forbiddenText !== undefined && (
          <StatusText showIcon status="default">
            {t(`${key}.noAccessSources`, { sources: forbiddenText })}
          </StatusText>
        )}
        {failedText !== undefined && (
          <StatusText showIcon status="warning">
            {t(`${key}.sourceError`, { sources: failedText })}
          </StatusText>
        )}
        <SectionCard>
          <StatisticsControls invertedRange={invertedRangeOf(search)} onChange={onChange} query={query} today={today} />
        </SectionCard>
        <StatisticsResults
          isForbidden={(id) => isMetricForbidden(id, forbiddenSet)}
          kpis={kpis}
          loading={!ready}
          metric={metric}
          query={query}
          result={result}
        />
      </section>
    </>
  );
};

export const RecordsPage = () => (
  <FederatedI18nBoundary
    defaultNamespace="sales-insights"
    fallbackLanguage="en"
    resources={salesInsightsI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <StatisticsPageContent />
  </FederatedI18nBoundary>
);

export default RecordsPage;
