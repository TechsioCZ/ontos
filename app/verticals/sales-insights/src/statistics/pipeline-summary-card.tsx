import { EmptyState, formatNumber, SectionCard } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Skeleton } from '@techsio/ui-kit/atoms/skeleton';
import type { CalendarDay, PipelineSummary, PipelineTally } from '../../shared/metrics.ts';
import { formatMetricValue, formatPeriodDay } from './format-metric.ts';

const key = 'sales-insights.pages.statistics';
const pipelineKey = `${key}.pipeline`;

/** Label, count and value tracks shared by every row of one list, so the numbers line up. */
const ROWS_CLASS = 'grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-200 gap-y-100 text-sm';

interface TallyRowProps {
  readonly countText: string;
  readonly indent?: boolean;
  readonly label: string;
  readonly tally: PipelineTally;
}

const TallyRow = ({ countText, indent = false, label, tally }: TallyRowProps) => (
  <div className="col-span-full grid grid-cols-subgrid items-baseline">
    <dt className={`min-w-0 break-words ${indent ? 'ps-200 text-fg-secondary' : ''}`}>{label}</dt>
    <dd className="text-end text-fg-secondary tabular-nums">{countText}</dd>
    <dd className="text-end font-semibold tabular-nums">{formatMetricValue(tally.valueMinor, 'CZK')}</dd>
  </div>
);

const ColumnHeading = ({ note, title }: { readonly note: string; readonly title: string }) => (
  <div className="flex flex-col gap-50">
    <h3 className="font-semibold text-sm">{title}</h3>
    <p className="text-fg-secondary text-sm">{note}</p>
  </div>
);

export interface PipelineSummaryCardProps {
  /** The role may not read opportunities: once loaded, the card shows a permission state instead of zeros. */
  readonly forbidden: boolean;
  readonly from: CalendarDay;
  readonly loading: boolean;
  /** `undefined` while the opportunities load. */
  readonly summary: PipelineSummary | undefined;
  readonly to: CalendarDay;
}

/**
 * The open pipeline as of today, which the period cannot change, beside what the period moved: opportunities opened
 * in it and closed in it (won, lost, win rate).
 */
export const PipelineSummaryCard = ({ forbidden, from, loading, summary, to }: PipelineSummaryCardProps) => {
  const { t } = useModernI18n();
  const countOf = (count: number) => t(`${pipelineKey}.count`, { count, formatted: formatNumber(count) });

  const blocked = !loading && forbidden;
  if (blocked || loading || summary === undefined) {
    return (
      <SectionCard title={t(`${pipelineKey}.title`)}>
        {blocked ? (
          <EmptyState title={t(`${key}.noAccessMetric`)} />
        ) : (
          <Skeleton aria-label={t('sales-insights.loadingContent')} isLoaded={false}>
            <Skeleton.Rectangle className="h-48 w-full" />
          </Skeleton>
        )}
      </SectionCard>
    );
  }

  const { closed, lost, open, opened, winRate, won } = summary;
  const flowEmpty = opened.count === 0 && closed.count === 0;

  return (
    <SectionCard title={t(`${pipelineKey}.title`)}>
      <div className="grid min-w-0 grid-cols-1 gap-250 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-150">
          <ColumnHeading note={t(`${pipelineKey}.openNote`)} title={t(`${pipelineKey}.open`)} />
          {open.count === 0 ? (
            <EmptyState title={t(`${pipelineKey}.openEmpty`)} />
          ) : (
            <>
              <div className="flex flex-wrap items-baseline gap-150">
                <span className="font-semibold text-xl tabular-nums">{formatMetricValue(open.valueMinor, 'CZK')}</span>
                <span className="text-fg-secondary text-sm tabular-nums">{countOf(open.count)}</span>
              </div>
              <dl aria-label={t(`${pipelineKey}.stagesLabel`)} className={ROWS_CLASS}>
                {open.byStage.map((stage) => (
                  <TallyRow countText={countOf(stage.count)} key={stage.stage} label={stage.label} tally={stage} />
                ))}
              </dl>
            </>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-150">
          <ColumnHeading
            note={t(`${key}.chartDescription`, { from: formatPeriodDay(from), to: formatPeriodDay(to) })}
            title={t(`${pipelineKey}.flowTitle`)}
          />
          {flowEmpty ? (
            <EmptyState title={t(`${pipelineKey}.flowEmpty`)} />
          ) : (
            <>
              <dl className={ROWS_CLASS}>
                <TallyRow countText={countOf(opened.count)} label={t(`${pipelineKey}.opened`)} tally={opened} />
                <TallyRow countText={countOf(closed.count)} label={t(`${pipelineKey}.closed`)} tally={closed} />
                <TallyRow countText={countOf(won.count)} indent label={t(`${pipelineKey}.won`)} tally={won} />
                <TallyRow countText={countOf(lost.count)} indent label={t(`${pipelineKey}.lost`)} tally={lost} />
                <div className="col-span-full grid grid-cols-subgrid items-baseline">
                  <dt className="min-w-0 break-words">{t(`${pipelineKey}.winRate`)}</dt>
                  {/* Nothing closed has no rate: a sentence, not 0 % or NaN. */}
                  {winRate === null ? (
                    <dd className="col-span-2 text-end text-fg-secondary">{t(`${pipelineKey}.winRateNone`)}</dd>
                  ) : (
                    <dd className="col-span-2 text-end font-semibold tabular-nums">
                      {formatMetricValue(winRate, 'percent')}
                    </dd>
                  )}
                </div>
              </dl>
              <p className="text-fg-secondary text-xs">{t(`${pipelineKey}.flowNote`)}</p>
            </>
          )}
        </div>
      </div>
    </SectionCard>
  );
};
