import { PageHeader, SectionCard } from '@app/admin-ui';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { modulePagePreload } from '@app/shared-contracts/page-data';
import type { ModulePageContext } from '@app/shared-contracts/page-data';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { DateTime } from 'effect';
import csResource from '../../../../../locales/cs/sales-insights.json';
import enResource from '../../../../../locales/en/sales-insights.json';
import { computeKpis, computeMetric, computePipelineSummary, metricCatalog } from '../../../../../shared/metrics.ts';
import type { CalendarDay } from '../../../../../shared/metrics.ts';
import { isMetricForbidden, statisticsSourcesFor } from '../../../../statistics/statistics-access.ts';
import { StatisticsControls } from '../../../../statistics/statistics-controls.tsx';
import { StatisticsResults } from '../../../../statistics/statistics-results.tsx';
import type { StatisticsQuery } from '../../../../statistics/statistics-query.ts';
import {
  defaultQuery,
  invertedRangeOf,
  parseStatisticsQuery,
  requestedGroupingOf,
  serializeStatisticsQuery,
} from '../../../../statistics/statistics-query.ts';
import { useUnreadableSources } from '../../../../statistics/readable-sources.ts';
import { preloadStatisticsInputs, useStatisticsInputs } from '../../../../statistics/use-statistics-inputs.ts';
import type { StatisticsPageInput } from '../../../../statistics/use-statistics-inputs.ts';
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

/** Shell page props; the vertical's own route renders the page without them. */
interface StatisticsPageProps {
  readonly context?: ModulePageContext | undefined;
}

const inputOf = (context: ModulePageContext | undefined): StatisticsPageInput => ({
  legalEntityId: context?.legalEntityId ?? '',
});

/** The Shell runs this before it reveals the page, so KPIs, chart and pipeline summary render real values at once. */
export const preloadPage = modulePagePreload((props) => {
  const query = parseStatisticsQuery(props.search, defaultQuery(todayDay()));
  return preloadStatisticsInputs(statisticsSourcesFor(query.metric, query.groupBy), inputOf(props.context));
});

const StatisticsPageContent = ({ context }: StatisticsPageProps) => {
  const { t } = useModernI18n();
  const today = todayDay();
  const search = useRouterState({ select: (state) => state.location.searchStr });
  const query = parseStatisticsQuery(search, defaultQuery(today));
  const data = useStatisticsInputs(statisticsSourcesFor(query.metric, query.groupBy), inputOf(context));
  const unreadable = useUnreadableSources();

  // The query holds the grouping the metric can show; the URL keeps the one the user asked for, so a metric switch
  // that drops it can restore it. Parsing applies the same fallback again.
  const onChange = (patch: Partial<StatisticsQuery>) => {
    const next = { ...query, ...patch };
    const groupBy = patch.groupBy ?? requestedGroupingOf(search) ?? next.groupBy;
    writeUrlSearch(serializeStatisticsQuery({ ...next, groupBy }));
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
  const pipeline =
    data.status === 'ready'
      ? computePipelineSummary(data.inputs, { from: query.from, to: query.to, today })
      : undefined;
  const forbidden = data.status === 'ready' ? data.forbidden : [];
  // Sources the role cannot read at all are known before they are requested, so the metric picker leaves out every
  // metric that needs one (task metrics for the accountant) and never sends a read the producer would refuse.
  const forbiddenSet = new Set([...forbidden, ...unreadable]);
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
          <StatisticsControls
            invertedRange={invertedRangeOf(search)}
            isForbidden={(id) => isMetricForbidden(id, forbiddenSet)}
            onChange={onChange}
            query={query}
            today={today}
          />
        </SectionCard>
        <StatisticsResults
          isForbidden={(id) => isMetricForbidden(id, forbiddenSet)}
          kpis={kpis}
          loading={!ready}
          metric={metric}
          pipeline={pipeline}
          query={query}
          result={result}
        />
      </section>
    </>
  );
};

export const RecordsPage = ({ context }: StatisticsPageProps) => (
  <FederatedI18nBoundary
    defaultNamespace="sales-insights"
    fallbackLanguage="en"
    resources={salesInsightsI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <StatisticsPageContent context={context} />
  </FederatedI18nBoundary>
);

export default RecordsPage;
