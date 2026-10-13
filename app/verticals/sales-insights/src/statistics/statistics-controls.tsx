import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { DatePicker } from '@techsio/ui-kit/molecules/date-picker';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { CalendarDate } from '@internationalized/date';
import { Schema } from 'effect';
import type { CalendarDay } from '../../shared/metrics.ts';
import { GroupingSchema, MetricIdSchema, metricCatalog } from '../../shared/metrics.ts';
import type { StatisticsQuery } from './statistics-query.ts';
import { activePreset, ChartKindSchema, chartKinds, presetRange, presets } from './statistics-query.ts';

const SELECT_PLACEHOLDER = 'sales-insights.selectPlaceholder';

const key = 'sales-insights.pages.statistics';

const toCalendarDate = (day: CalendarDay): CalendarDate =>
  new CalendarDate(Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10)));

export interface StatisticsControlsProps {
  readonly onChange: (patch: Partial<StatisticsQuery>) => void;
  readonly query: StatisticsQuery;
  readonly today: CalendarDay;
}

/** Metric, chart type, period and grouping controls in one wrapping toolbar row above the results. */
export const StatisticsControls = ({ onChange, query, today }: StatisticsControlsProps) => {
  const { t } = useModernI18n();
  const metricItems = metricCatalog.map((entry) => ({ label: entry.label, value: entry.id }));
  const chartItems = chartKinds.map((kind) => ({ label: t(`${key}.chart.${kind}`), value: kind }));
  const groupingEntry = metricCatalog.find((entry) => entry.id === query.metric);
  const groupingItems = (groupingEntry?.allowedGroupings ?? []).map((grouping) => ({
    label: t(`${key}.groupingLabel.${grouping}`),
    value: grouping,
  }));
  const rangeValue = [toCalendarDate(query.from), toCalendarDate(query.to)] as const;
  const currentPreset = activePreset(query, today);

  return (
    <div className="flex flex-wrap items-end gap-150">
      <div className="w-48">
        <SelectTemplate
          id="statistics-metric"
          items={metricItems}
          label={t(`${key}.metric`)}
          onValueChange={(details) => {
            const [next] = details.value;
            if (Schema.is(MetricIdSchema)(next)) {
              onChange({ metric: next });
            }
          }}
          placeholder={t(SELECT_PLACEHOLDER)}
          size="sm"
          value={[query.metric]}
        />
      </div>
      <div className="w-48">
        <SelectTemplate
          id="statistics-chart"
          items={chartItems}
          label={t(`${key}.chartType`)}
          onValueChange={(details) => {
            const [next] = details.value;
            if (Schema.is(ChartKindSchema)(next)) {
              onChange({ chart: next });
            }
          }}
          placeholder={t(SELECT_PLACEHOLDER)}
          size="sm"
          value={[query.chart]}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-100">
        <DatePicker.Root
          locale="cs-CZ"
          onValueChange={(details) => {
            const [start, end] = details.value ?? [];
            if (start !== undefined && end !== undefined) {
              onChange({ from: start.toString(), to: end.toString() });
            }
          }}
          selectionMode="range"
          size="sm"
          value={rangeValue}
        >
          <DatePicker.Label>{t(`${key}.period`)}</DatePicker.Label>
          <DatePicker.Control>
            <DatePicker.Segments />
            <DatePicker.IndicatorGroup>
              <DatePicker.Trigger />
            </DatePicker.IndicatorGroup>
          </DatePicker.Control>
          <DatePicker.Positioner>
            <DatePicker.Content>
              <DatePicker.Calendar />
            </DatePicker.Content>
          </DatePicker.Positioner>
        </DatePicker.Root>
        <fieldset
          aria-label={t(`${key}.presetsLabel`)}
          className="inline-flex min-w-0 max-w-full self-start overflow-x-auto whitespace-nowrap rounded-button-sm border border-border-primary p-50"
        >
          {presets.map((preset) => {
            const active = currentPreset === preset;
            return (
              <Button
                aria-pressed={active}
                key={preset}
                onClick={() => onChange(presetRange(preset, today))}
                size="sm"
                theme={active ? 'solid' : 'borderless'}
                variant={active ? 'primary' : 'secondary'}
              >
                {t(`${key}.presets.${preset}`)}
              </Button>
            );
          })}
        </fieldset>
      </div>
      <div className="w-48">
        <SelectTemplate
          id="statistics-group"
          items={groupingItems}
          label={t(`${key}.grouping`)}
          onValueChange={(details) => {
            const [next] = details.value;
            if (Schema.is(GroupingSchema)(next)) {
              onChange({ groupBy: next });
            }
          }}
          placeholder={t(SELECT_PLACEHOLDER)}
          size="sm"
          value={[query.groupBy]}
        />
      </div>
    </div>
  );
};
