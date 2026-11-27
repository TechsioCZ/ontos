import { datePickerSegmentsClassName, datePickerTranslations } from '@app/admin-ui';
import {
  DateRangeField,
  FormBuilder,
  FormReact,
  FormRoot,
  SelectTemplateField,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import type { DayRangeValue } from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { CalendarDate } from '@internationalized/date';
import { Effect, Option, Schema } from 'effect';
import { AsyncResult, Atom } from 'effect/reactivity';
import type { FocusEvent } from 'react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { browserAtomRuntime } from '../runtime/browser-effect-runtime.ts';
import type { CalendarDay, MetricId } from '../../shared/metrics.ts';
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

// The period picker's label is small (`text-label-sm`); the select labels in the same row match it.
const toolbarLabelProps = { className: 'text-date-picker-label-fg text-label-sm' };

// The calendar is a floating popup: opaque, and above the select menus that share the toolbar row.
const calendarContentClass = 'z-(--z-popup) bg-(--color-popup-bg)';

const toCalendarDate = (day: CalendarDay): CalendarDate =>
  new CalendarDate(Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10)));

const periodOf = (range: DayRange): DayRangeValue => [toCalendarDate(range.from), toCalendarDate(range.to)];
const dayRangeOf = ([start, end]: DayRangeValue): DayRange => ({ from: start.toString(), to: end.toString() });

const CalendarDateSchema = Schema.instanceOf(CalendarDate);

/** The period the picker shows; a period whose end is before its start is never committed. */
const PeriodSchema = Schema.Tuple([CalendarDateSchema, CalendarDateSchema]).check(
  Schema.makeFilter(([start, end]) => (start.compare(end) > 0 ? `${key}.rangeInvalid` : undefined)),
);

/** What typed segments showed when the person left them, when they showed no period to commit. */
const SegmentsProblemSchema = Schema.Literals(['dateFuture', 'dateInvalid']);
type SegmentsProblem = typeof SegmentsProblemSchema.Type;

/** A commit the typed segments refused: an empty, impossible or future day. */
class PeriodRefused extends Schema.TaggedError<PeriodRefused>()('PeriodRefused', { reason: SegmentsProblemSchema }) {}

/**
 * The period picker: a commit (focus leaving the segments, Enter, a calendar pick or a preset) submits the period on
 * screen, and the page takes it into the URL. A commit whose typed segments show no period carries why, so the picker
 * keeps what was typed and says what is wrong.
 */
const periodForm = FormReact.make(FormBuilder.empty.addField('period', PeriodSchema), {
  fields: { period: DateRangeField },
  // oxlint-disable-next-line typescript/no-invalid-void-type -- FormRoot submits with no argument; only a commit from the typed segments passes what they showed.
  onSubmit: (problem: SegmentsProblem | void, { decoded }) =>
    problem === undefined ? Effect.succeed(decoded.period) : Effect.fail(new PeriodRefused({ reason: problem })),
  runtime: browserAtomRuntime,
  submitErrors: ({ reason }) => [{ message: `${key}.${reason}`, path: 'period' as const }],
});

const periodField = periodForm.getFieldAtoms(periodForm.fields.period);

const daysOf = Option.match({ onNone: () => '', onSome: ({ from, to }: DayRange) => `${from}/${to}` });

/**
 * The days the picker shows; none before the form starts. It changes only when the days do: the field's own value atom
 * reports every change of the form, so committing on it would commit again forever.
 */
const shownPeriod = periodField.value.pipe(
  Atom.map(Option.map(dayRangeOf)),
  Atom.withEquality<Option.Option<DayRange>>((value, next) => daysOf(value) === daysOf(next)),
);

/**
 * Metric, chart type and grouping each switch the page at once: picking one submits it, and the page takes it into the
 * URL. Each holds the value the URL shows.
 */
const metricForm = FormReact.make(FormBuilder.empty.addField('metric', Schema.String), {
  fields: { metric: SelectTemplateField },
  mode: { autoSubmit: true, validation: 'onChange' },
  onSubmit: (_submit, { decoded }) => Effect.succeed(decoded.metric),
  runtime: browserAtomRuntime,
});
const chartForm = FormReact.make(FormBuilder.empty.addField('chart', Schema.String), {
  fields: { chart: SelectTemplateField },
  mode: { autoSubmit: true, validation: 'onChange' },
  onSubmit: (_submit, { decoded }) => Effect.succeed(decoded.chart),
  runtime: browserAtomRuntime,
});
const groupingForm = FormReact.make(FormBuilder.empty.addField('groupBy', Schema.String), {
  fields: { groupBy: SelectTemplateField },
  mode: { autoSubmit: true, validation: 'onChange' },
  onSubmit: (_submit, { decoded }) => Effect.succeed(decoded.groupBy),
  runtime: browserAtomRuntime,
});

/** A picked choice, once its submit settled. */
const pickedOf = (result: AsyncResult.AsyncResult<string, unknown>): string | undefined =>
  AsyncResult.isSuccess(result) && !result.waiting ? result.value : undefined;

/**
 * The period the page shows, put back into the picker whenever it changes: a typed period applies only to the period
 * it was made against, so a URL change drops it. An inverted URL period is checked at once, so its error shows.
 */
const PeriodShown = ({ inverted, period }: { readonly inverted: boolean; readonly period: DayRange }) => {
  const setValues = useAtomSet(periodForm.setValues);
  const validate = useAtomSet(periodForm.validate);
  const { from, to } = period;
  useLayoutEffect(() => {
    setValues({ period: periodOf({ from, to }) });
    if (inverted) {
      validate();
    }
  }, [from, inverted, setValues, to, validate]);
  return null;
};

const padNumber = (value: number, length: number) => String(value).padStart(length, '0');

const segmentNumber = (group: Element, type: 'day' | 'month' | 'year'): number | undefined => {
  const raw = group.querySelector(`[data-part="segment"][data-type="${type}"]`)?.getAttribute('aria-valuenow');
  return raw === null || raw === undefined || raw === '' ? undefined : Number(raw);
};

// A year typed one digit at a time passes through 2 and 20; only a four-digit year is a date the user meant.
const MIN_TYPED_YEAR = 1000;

const typedDay = (group: Element): CalendarDay | undefined => {
  const year = segmentNumber(group, 'year');
  const month = segmentNumber(group, 'month');
  const day = segmentNumber(group, 'day');
  if (year === undefined || year < MIN_TYPED_YEAR || month === undefined || day === undefined) {
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
  /** Metrics this role may not compute (a source read was refused). The picker leaves them out. */
  readonly isForbidden: (id: MetricId) => boolean;
  readonly onChange: (patch: Partial<StatisticsQuery>) => void;
  readonly query: StatisticsQuery;
  readonly today: CalendarDay;
}

/** Metric, chart type, period and grouping controls in one wrapping toolbar row above the results. */
export const StatisticsControls = ({ invertedRange, isForbidden, onChange, query, today }: StatisticsControlsProps) => {
  const { t } = useModernI18n();
  const translateMessage = (message: string) => t(message, { defaultValue: message });
  // The selects show what the URL shows; a pick reaches the URL through its submit.
  const showMetric = useAtomSet(metricForm.setValues);
  const showChart = useAtomSet(chartForm.setValues);
  const showGrouping = useAtomSet(groupingForm.setValues);
  useAtomSubscribe(
    metricForm.submit,
    (result) => {
      const next = pickedOf(result);
      if (Schema.is(MetricIdSchema)(next) && next !== query.metric) {
        onChange({ metric: next });
      }
    },
    { immediate: false },
  );
  useAtomSubscribe(
    chartForm.submit,
    (result) => {
      const next = pickedOf(result);
      if (Schema.is(ChartKindSchema)(next) && next !== query.chart) {
        onChange({ chart: next });
      }
    },
    { immediate: false },
  );
  useAtomSubscribe(
    groupingForm.submit,
    (result) => {
      const next = pickedOf(result);
      if (Schema.is(GroupingSchema)(next) && next !== query.groupBy) {
        onChange({ groupBy: next });
      }
    },
    { immediate: false },
  );
  // After the subscriptions above took this render's query, so a value put back from the URL is not taken for a pick.
  useEffect(() => {
    showMetric({ metric: query.metric });
    showChart({ chart: query.chart });
    showGrouping({ groupBy: query.groupBy });
  }, [query.chart, query.groupBy, query.metric, showChart, showGrouping, showMetric]);
  // Typed dates stay in the picker as the form's period and reach the URL only when focus leaves the picker or on
  // Enter, so editing one segment neither moves focus nor recomputes the page. An inverted period (end before start)
  // is never committed: it keeps the validation error and the chart keeps the last valid period.
  // Read only in handlers: whether the calendar popup is open when a value arrives.
  const calendarOpen = useRef(false);
  const setPeriod = useAtomSet(periodField.setValue);
  const commit = useAtomSet(periodForm.submit);
  const pageRange = invertedRange ?? query;
  const shownRange = Option.getOrElse(useAtomValue(shownPeriod), () => pageRange);
  useAtomSubscribe(
    periodForm.submit,
    (result) => {
      if (!AsyncResult.isSuccess(result) || result.waiting) {
        return;
      }
      const range = dayRangeOf(result.value);
      // An inverted URL range must be rewritten even when the new range equals the fallback period.
      if (invertedRange !== undefined || range.from !== query.from || range.to !== query.to) {
        onChange(range);
      }
    },
    { immediate: false },
  );
  // A calendar pick is a deliberate choice and commits at once; typed segments wait for blur.
  useAtomSubscribe(
    shownPeriod,
    () => {
      if (calendarOpen.current) {
        commit();
      }
    },
    { immediate: false },
  );
  const commitRange = (range: DayRange) => {
    setPeriod(periodOf(range));
    commit();
  };
  // The segments are the source of truth for typed dates: what the user sees is what gets committed or rejected.
  const commitDraft = (root: Element) => {
    const typed = typedRangeOf(root);
    // A blurred picker with an empty, impossible or future typed date keeps its segments and marks them invalid.
    if (typed === null) {
      commit('dateInvalid');
      return;
    }
    // The calendar offers no day after today, so a typed future date is rejected the same way.
    if (typed !== undefined && (typed.from > today || typed.to > today)) {
      commit('dateFuture');
      return;
    }
    if (typed !== undefined) {
      setPeriod(periodOf(typed));
    }
    commit();
  };
  // Tab from the last segment lands on the calendar trigger, which is inside the picker. The draft commits when
  // focus leaves the segments, not only the picker, so the period applies on the first Tab.
  const onPickerBlur = (event: FocusEvent<HTMLDivElement>) => {
    const segmentGroups = [
      ...event.currentTarget.querySelectorAll('[data-scope="date-input"][data-part="segment-group"]'),
    ];
    const staysInSegments = segmentGroups.some((group) => group.contains(event.relatedTarget));
    if (!staysInSegments) {
      commitDraft(event.currentTarget);
    }
  };

  // The chosen metric stays listed even when refused, so the select still names what the page shows.
  const metricItems = metricCatalog.flatMap((entry) =>
    entry.id === query.metric || !isForbidden(entry.id) ? [{ label: entry.label, value: entry.id }] : [],
  );
  const chartItems = chartKinds.map((kind) => ({ label: t(`${key}.chart.${kind}`), value: kind }));
  const groupingEntry = metricCatalog.find((entry) => entry.id === query.metric);
  const groupingItems = (groupingEntry?.allowedGroupings ?? []).map((grouping) => ({
    label: t(`${key}.groupingLabel.${grouping}`),
    value: grouping,
  }));
  const rangeInvalid = isInvertedRange(shownRange);
  const currentPreset = rangeInvalid ? undefined : activePreset(shownRange, today);

  return (
    <div className="flex flex-wrap items-start gap-150">
      <FormRoot
        className="w-48"
        defaultValues={{ metric: query.metric }}
        form={metricForm}
        translateMessage={translateMessage}
      >
        <metricForm.metric
          id="statistics-metric"
          items={metricItems}
          label={t(`${key}.metric`)}
          labelProps={toolbarLabelProps}
          placeholder={t(SELECT_PLACEHOLDER)}
          size="sm"
        />
      </FormRoot>
      <FormRoot
        className="w-48"
        defaultValues={{ chart: query.chart }}
        form={chartForm}
        translateMessage={translateMessage}
      >
        <chartForm.chart
          id="statistics-chart"
          items={chartItems}
          label={t(`${key}.chartType`)}
          labelProps={toolbarLabelProps}
          placeholder={t(SELECT_PLACEHOLDER)}
          size="sm"
        />
      </FormRoot>
      <FormRoot
        className="flex min-w-0 flex-col gap-100"
        defaultValues={{ period: periodOf(pageRange) }}
        form={periodForm}
        translateMessage={translateMessage}
      >
        <PeriodShown inverted={invertedRange !== undefined} period={pageRange} />
        <periodForm.period
          contentClassName={calendarContentClass}
          endLabel={t(`${key}.rangeEnd`)}
          label={t(`${key}.period`)}
          locale="cs-CZ"
          max={toCalendarDate(today)}
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
          segmentsClassName={datePickerSegmentsClassName}
          size="sm"
          startLabel={t(`${key}.rangeStart`)}
          translations={datePickerTranslations}
        />
        <fieldset
          aria-label={t(`${key}.presetsLabel`)}
          className="inline-flex min-w-0 max-w-full flex-wrap self-start rounded-button-sm border border-border-primary p-50"
        >
          {presets.map((preset) => {
            const active = currentPreset === preset;
            return (
              <Button
                appearance={active ? 'solid' : 'ghost'}
                aria-pressed={active}
                key={preset}
                onClick={() => commitRange(presetRange(preset, today))}
                severity={active ? 'primary' : 'secondary'}
                size="sm"
                type="button"
              >
                {t(`${key}.presets.${preset}`)}
              </Button>
            );
          })}
        </fieldset>
      </FormRoot>
      <FormRoot
        className="w-48"
        defaultValues={{ groupBy: query.groupBy }}
        form={groupingForm}
        translateMessage={translateMessage}
      >
        <groupingForm.groupBy
          id="statistics-group"
          items={groupingItems}
          label={t(`${key}.grouping`)}
          labelProps={toolbarLabelProps}
          placeholder={t(SELECT_PLACEHOLDER)}
          size="sm"
        />
      </FormRoot>
    </div>
  );
};
