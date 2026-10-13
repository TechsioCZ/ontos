import { datePickerTranslations } from '@app/admin-ui';
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
  asCalendarDay,
  ChartKindSchema,
  chartKinds,
  isInvertedRange,
  presetRange,
  presets,
} from './statistics-query.ts';

const SELECT_PLACEHOLDER = 'sales-insights.selectPlaceholder';

const key = 'sales-insights.pages.statistics';

// The calendar is a floating popup: opaque, and above the select menus that share the toolbar row.
const calendarContentClass = 'z-(--z-popup) bg-(--color-popup-bg)';

const toCalendarDate = (day: CalendarDay): CalendarDate =>
  new CalendarDate(Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10)));

const padNumber = (value: number, length: number) => String(value).padStart(length, '0');

const segmentNumber = (group: Element, type: 'day' | 'month' | 'year'): number | undefined => {
  const raw = group.querySelector(`[data-part="segment"][data-type="${type}"]`)?.getAttribute('aria-valuenow');
  return raw === null || raw === undefined || raw === '' ? undefined : Number(raw);
};

const typedDay = (group: Element): CalendarDay | undefined => {
  const year = segmentNumber(group, 'year');
  const month = segmentNumber(group, 'month');
  const day = segmentNumber(group, 'day');
  if (year === undefined || month === undefined || day === undefined) {
    return undefined;
  }
  return asCalendarDay(`${padNumber(year, 4)}-${padNumber(month, 2)}-${padNumber(day, 2)}`);
};

/**
 * The range the segments show. The ui-kit keeps an inverted typed range (end before start) on screen but never
 * reports it through `onValueChange`, so the last reported value can be an older half-typed date. `undefined`
 * means the picker renders no segments; `null` means a segment is empty or the typed date does not exist.
 */
const typedRangeOf = (root: Element): DayRange | null | undefined => {
  const [startGroup, endGroup] = root.querySelectorAll('[data-scope="date-input"][data-part="segment-group"]');
  if (startGroup === undefined || endGroup === undefined) {
    return undefined;
  }
  const from = typedDay(startGroup);
  const to = typedDay(endGroup);
  return from === undefined || to === undefined ? null : { from, to };
};

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
  // The segments are the source of truth for typed dates: what the user sees is what gets committed or rejected.
  const commitDraft = (root: Element) => {
    const typed = typedRangeOf(root);
    if (typed === null) {
      return;
    }
    const next = typed ?? draft;
    if (next !== null) {
      commitRange(next);
    }
  };
  const onPickerBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      commitDraft(event.currentTarget);
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
    <div className="flex flex-wrap items-start gap-150">
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
            // Enter inside the calendar popup (a portal outside this element) picks a day itself; only Enter in
            // the segments commits typed dates.
            if (event.key === 'Enter' && event.currentTarget.contains(document.activeElement)) {
              commitDraft(event.currentTarget);
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
          translations={datePickerTranslations}
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
            <DatePicker.Content className={calendarContentClass}>
              <DatePicker.Calendar />
            </DatePicker.Content>
          </DatePicker.Positioner>
        </DatePicker.Root>
        <fieldset
          aria-label={t(`${key}.presetsLabel`)}
          className="inline-flex min-w-0 max-w-full flex-wrap self-start rounded-button-sm border border-border-primary p-50"
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
