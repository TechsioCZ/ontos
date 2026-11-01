import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
// One series per chart: counts or one currency, never mixed currencies or filter-dependent series colors.
import { EmptyState, SectionCard, formatNumber, surfaceTileClassName } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Chart } from '@techsio/ui-kit/molecules/chart';
import { DateTime } from 'effect';
import { Component, useState } from 'react';
import type { ReactElement } from 'react';

import { normalizeStatus, statusMeaningLabels, statusMeanings } from '../../../../../shared/domain/reports.ts';
import type { SalesReport } from '../../../../../shared/domain/reports.ts';

import { useFormatDecimalMoney, totalIn } from './report-format.ts';

const k = 'crm.reports.chart';

const monthFormats = (locale: string) => ({
  long: new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC', year: 'numeric' }),
  short: new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }),
});
const csMonthFormats = monthFormats('cs-CZ');
const enMonthFormats = monthFormats('en-GB');
const monthFormatsFor = (language: string) => (language === 'en' ? enMonthFormats : csMonthFormats);
const monthEpochMillis = (month: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(`${month}-01T00:00:00Z`));
/** Axis tick: "dub 26" / "Apr 26". */
const shortMonth = (key: string, language: string) =>
  `${monthFormatsFor(language).short.format(monthEpochMillis(key))} ${key.slice(2, 4)}`;
/** Tooltip title, descriptions and table rows: "duben 2026" / "April 2026". */
const longMonth = (key: string, language: string) => monthFormatsFor(language).long.format(monthEpochMillis(key));

interface ChartBoundaryProps {
  readonly children: ReactElement;
  readonly fallback: string;
}

class ChartBoundary extends Component<ChartBoundaryProps, { readonly failed: boolean }> {
  constructor(props: ChartBoundaryProps) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <p className="text-fg-secondary text-sm">{this.props.fallback}</p> : this.props.children;
  }
}

export const ReportCharts = ({ report }: { readonly report: SalesReport }) => {
  const { language, t } = useModernI18n();
  const formatDecimalMoney = useFormatDecimalMoney();
  const [chosenCurrency, setChosenCurrency] = useState<string | undefined>();
  const currency =
    chosenCurrency !== undefined && report.currencies.includes(chosenCurrency) ? chosenCurrency : report.currencies[0];
  if (report.count === 0) {
    return (
      <SectionCard title={t('crm.ciWorkflow.monthlyTrend')}>
        <EmptyState description={t(`${k}.emptyDescription`)} title={t('crm.ciWorkflow.noData')} />
      </SectionCard>
    );
  }
  // Approved mapping (R04): columns per meaning; otherwise per raw source status (no unapproved categories).
  const statusKey = (row: SalesReport['rows'][number]) =>
    report.mappingApproved ? row.meaning : normalizeStatus(row.order.rawStatus);
  const meanings: readonly { readonly key: string; readonly label: string }[] = report.mappingApproved
    ? statusMeanings.flatMap((meaning) =>
        report.rows.some((row) => row.meaning === meaning)
          ? [{ key: meaning, label: statusMeaningLabels[meaning] }]
          : [],
      )
    : [...new Map(report.rows.map((row) => [statusKey(row), row.order.rawStatus] as const)).entries()].map(
        ([key, raw]) => ({ key, label: `Ze zdroje: ${raw}` }),
      );
  const counts = new Map<string, number>();
  for (const row of report.rows) {
    const key = `${row.month}|${statusKey(row)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const titleByTick = new Map(
    report.byMonth.map((month) => [shortMonth(month.key, language), longMonth(month.key, language)] as const),
  );
  const monthTitle = (tick: string | number | Date) => titleByTick.get(String(tick)) ?? String(tick);
  const countData = report.byMonth.map((month) => ({ count: month.count, month: shortMonth(month.key, language) }));
  const valueData =
    currency === undefined
      ? []
      : report.byMonth.flatMap((month) => {
          const total = totalIn(month.totals, currency);
          // A month with orders but no supplied amount in this currency is missing data, not a zero value.
          return total === undefined && month.count > 0
            ? []
            : [{ month: shortMonth(month.key, language), value: Number(total?.amount ?? '0') }];
        });
  const firstKey = report.byMonth[0]?.key;
  const lastKey = report.byMonth.at(-1)?.key;
  const from = firstKey === undefined ? '' : longMonth(firstKey, language);
  const to = lastKey === undefined ? '' : longMonth(lastKey, language);
  const fallback = t(`${k}.boundaryFailed`);
  return (
    <section aria-label={t('crm.ciWorkflow.orderChartData')} className="flex min-w-0 flex-col gap-150">
      <div className="grid min-w-0 grid-cols-1 gap-250 xl:grid-cols-2">
        <SectionCard title={t('crm.ciWorkflow.monthlyOrderCounts')}>
          <p className="text-fg-secondary text-sm">{t(`${k}.countsNote`)}</p>
          <ChartBoundary fallback={fallback}>
            <Chart
              ariaDescription={t(`${k}.countsDescription`, { from, to })}
              ariaLabel={t(`${k}.countsAria`)}
              data={countData}
              formatCategory={monthTitle}
              formatTooltipValue={formatNumber}
              formatValue={(value) => (Number.isInteger(value) ? formatNumber(value) : '')}
              height={260}
              locale={language}
              type="bar"
              valueLabel={t(`${k}.orderCount`)}
              x="month"
              y="count"
            />
          </ChartBoundary>
        </SectionCard>
        <SectionCard
          actions={
            report.currencies.length > 1 ? (
              <fieldset
                aria-label={t('crm.ciWorkflow.chartCurrency')}
                className="inline-flex rounded-button-sm border border-border-primary p-50"
              >
                {report.currencies.map((entry) => (
                  <Button
                    aria-pressed={entry === currency}
                    key={entry}
                    onClick={() => setChosenCurrency(entry)}
                    size="sm"
                    theme={entry === currency ? 'solid' : 'borderless'}
                    variant={entry === currency ? 'primary' : 'secondary'}
                  >
                    {entry}
                  </Button>
                ))}
              </fieldset>
            ) : undefined
          }
          title={currency === undefined ? t(`${k}.valueTitle`) : t(`${k}.valueTitleIn`, { currency })}
        >
          {currency === undefined ? (
            <EmptyState description={t(`${k}.noAmount`)} title={t('crm.ciWorkflow.noData')} />
          ) : (
            <>
              <p className="text-fg-secondary text-sm">{t(`${k}.valueNote`, { currency })}</p>
              <ChartBoundary fallback={fallback}>
                <Chart
                  ariaDescription={t(`${k}.valueDescription`, { currency, from, to })}
                  ariaLabel={t(`${k}.valueAria`, { currency })}
                  data={valueData}
                  formatCategory={monthTitle}
                  formatValue={(value) => formatDecimalMoney(String(value), currency)}
                  height={260}
                  locale={language}
                  type="bar"
                  valueLabel={t(`${k}.valueTitle`)}
                  x="month"
                  y="value"
                />
              </ChartBoundary>
            </>
          )}
        </SectionCard>
      </div>
      <details className={`${surfaceTileClassName} p-200`}>
        <summary className="cursor-pointer font-medium text-sm">{t(`${k}.tableToggle`)}</summary>
        <div className="overflow-x-auto pt-150">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">{t(`${k}.tableCaption`)}</caption>
            <thead>
              <tr className="border-border-primary border-b text-left">
                <th className="py-100 pr-200" scope="col">
                  {t(`${k}.month`)}
                </th>
                <th className="py-100 pr-200" scope="col">
                  {t(`${k}.orders`)}
                </th>
                {meanings.map((meaning) => (
                  <th className="py-100 pr-200" key={meaning.key} scope="col">
                    {meaning.label}
                  </th>
                ))}
                {report.currencies.map((entry) => (
                  <th className="py-100 pr-200" key={entry} scope="col">
                    {t(`${k}.valueIn`, { currency: entry })}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.byMonth.map((month) => (
                <tr className="border-border-primary border-b" key={month.key}>
                  <th className="py-100 pr-200 text-left font-normal" scope="row">
                    {longMonth(month.key, language)}
                  </th>
                  <td className="py-100 pr-200 tabular-nums">{formatNumber(month.count)}</td>
                  {meanings.map((meaning) => (
                    <td className="py-100 pr-200 tabular-nums" key={meaning.key}>
                      {formatNumber(counts.get(`${month.key}|${meaning.key}`) ?? 0)}
                    </td>
                  ))}
                  {report.currencies.map((entry) => {
                    const total = totalIn(month.totals, entry);
                    return (
                      <td className="py-100 pr-200 tabular-nums" key={entry}>
                        {total === undefined ? '—' : formatDecimalMoney(total.amount, entry)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
};
