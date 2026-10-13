import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { DatePicker } from '@techsio/ui-kit/molecules/date-picker';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { CalendarDate } from '@internationalized/date';
import { Schema } from 'effect';
import type { FocusEvent } from 'react';
import { useRef, useState } from 'react';
import type { CalendarDay } from '../../shared/metrics.ts';
import { GroupingSchema, MetricIdSchema, metricCatalog } from '../../shared/metrics.ts';
import type { DayRange, StatisticsQuery } from './statistics-query.ts';
import {
  activePreset,
  ChartKindSchema,
  chartKinds,
  isInvertedRange,
  presetRange,
  presets,
} from './statistics-query.ts';

const SELECT_PLACEHOLDER = 'sales-insights.selectPlaceholder';

const key = 'sales-insights.pages.statistics';

const toCalendarDate = (day: CalendarDay): CalendarDate =>
  new CalendarDate(Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10)));

export interface StatisticsControlsProps {
  /** The URL's range when its end date is before its start date; the query fell back to its defaults. */
  readonly invertedRange: DayRange | undefined;
  readonly onChange: (patch: Partial<StatisticsQuery>) => void;
  readonly query: StatisticsQuery;
  readonly today: CalendarDay;
}

/** Metric, chart type, period and grouping controls in one wrapping toolbar row above the results. */
export const StatisticsControls = ({ invertedRange, onChange, query, today }: StatisticsControlsProps) => {
  const { t } = useModernI18n();
  // Typed dates stay in the picker as a draft and reach the URL only when focus leaves the picker or on
  // Enter, so editing one segment neither moves focus nor recomputes the page. An inverted draft (end before
  // start) is never committed: it keeps the validation error and the chart keeps the last valid period.
  // The draft applies only to the period it was made against, so a URL change drops it without an effect.
  const periodKey = `${query.from}/${query.to}`;
  const [draftState, setDraftState] = useState<{ readonly period: string; readonly range: DayRange } | null>(null);
  // Read only in handlers: whether the calendar popup is open when a value arrives.
  const calendarOpen = useRef(false);
  const draft = draftState?.period === periodKey ? draftState.range : null;
  const setDraft = (range: DayRange | null) => setDraftState(range === null ? null : { period: periodKey, range });
  const commitRange = (range: DayRange) => {
    if (isInvertedRange(range)) {
      setDraft(range);
      return;
    }
    setDraft(null);
    // An inverted URL range must be rewritten even when the new range equals the fallback period.
    if (invertedRange !== undefined || range.from !== query.from || range.to !== query.to) {
      onChange(range);
    }
  };
  const commitDraft = () => {
    if (draft !== null) {
      commitRange(draft);
    }
  };
  const onPickerBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      commitDraft();
    }
  };

  const metricItems = metricCatalog.map((entry) => ({ label: entry.label, value: entry.id }));
  const chartItems = chartKinds.map((kind) => ({ label: t(`${key}.chart.${kind}`), value: kind }));
  const groupingEntry = metricCatalog.find((entry) => entry.id === query.metric);
  const groupingItems = (groupingEntry?.allowedGroupings ?? []).map((grouping) => ({
    label: t(`${key}.groupingLabel.${grouping}`),
    value: grouping,
  }));
  const shownRange = draft ?? invertedRange ?? query;
  const rangeInvalid = isInvertedRange(shownRange);
  const rangeValue = [toCalendarDate(shownRange.from), toCalendarDate(shownRange.to)] as const;
  const currentPreset = rangeInvalid ? undefined : activePreset(shownRange, today);

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
          invalid={rangeInvalid}
          locale="cs-CZ"
          onBlur={onPickerBlur}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitDraft();
            }
          }}
          onOpenChange={(details) => {
            calendarOpen.current = details.open;
          }}
          onValueChange={(details) => {
            const [start, end] = details.value ?? [];
            if (start === undefined || end === undefined) {
              return;
            }
            const range = { from: start.toString(), to: end.toString() };
            // A calendar pick is a deliberate choice and commits at once; typed segments wait for blur.
            if (calendarOpen.current) {
              commitRange(range);
              return;
            }
            setDraft(range);
          }}
          selectionMode="range"
          size="sm"
          value={rangeValue}
        >
          <DatePicker.Label>{t(`${key}.period`)}</DatePicker.Label>
          <DatePicker.Control>
            <DatePicker.Segments endLabel={t(`${key}.rangeEnd`)} startLabel={t(`${key}.rangeStart`)} />
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
                onClick={() => commitRange(presetRange(preset, today))}
                size="sm"
                theme={active ? 'solid' : 'borderless'}
                variant={active ? 'primary' : 'secondary'}
              >
                {t(`${key}.presets.${preset}`)}
              </Button>
            );
          })}
        </fieldset>
        {rangeInvalid && <StatusText status="error">{t(`${key}.rangeInvalid`)}</StatusText>}
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
