import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
// S13 shared calendar: month / week / list over deadlines READ from their sources. Owned by the ops-agenda lane.
import { EmptyState, foldSearchText } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Input } from '@techsio/ui-kit/atoms/input';
import { useState, useSyncExternalStore } from 'react';
import { DateTime, Schema } from 'effect';
import { Tooltip } from '@techsio/ui-kit/atoms/tooltip';
import type { Tone } from '../../../../ui/ops-agenda/model.ts';
import { addDays, daysUntil, urgencyOf } from '../../../../ui/ops-agenda/deadlines.ts';
import type { Deadline, SourceId } from '../../../../../shared/domain/ops-overview.ts';
import { sourceKeys } from '../../../../ui/ops-agenda/sources.ts';
import type { RentalOverviewSources } from '../../../../ui/ops-agenda/sources.ts';
import {
  Dot,
  Icon,
  Pill,
  categoryTone,
  exportCsv,
  fmt,
  langOf,
  toneColors,
  urgencyTone,
} from '../../../../ui/ops-agenda/ui-bits.tsx';

const k = 'facility-operations.agenda';

export const CalendarModeSchema = Schema.Literals(['mesic', 'tyden', 'seznam']);
export type CalendarMode = typeof CalendarModeSchema.Type;

const calendarSources: readonly SourceId[] = ['agreements', 'occupancy', 'work', 'finance', 'property', 'ops'];

const monthStart = (date: string) => `${date.slice(0, 7)}-01`;
const addMonths = (date: string, months: number) => {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7)) - 1 + months;
  // Date.UTC maps years 0–99 to 1900–1999; retain that existing calendar-construction behavior.
  const calendarYear = year >= 0 && year <= 99 ? year + 1900 : year;
  const base = DateTime.makeUnsafe({ day: 1, month: 1, year: calendarYear });
  return DateTime.formatIso(DateTime.add(base, { months: month })).slice(0, 10);
};
/** Monday of the week containing `date`. */
const mondayWeekday = (date: string) => (DateTime.toPartsUtc(DateTime.makeUnsafe(`${date}T00:00:00Z`)).weekDay + 6) % 7;
const weekStart = (date: string) => addDays(date, -mondayWeekday(date));

const calendarPeriod = (
  mode: CalendarMode,
  lang: ReturnType<typeof langOf>,
  range: { readonly end: string; readonly start: string },
  cursor: string,
) => {
  if (mode === 'tyden') {
    return `${fmt.short(lang, range.start)} – ${fmt.short(lang, range.end)}`;
  }
  if (mode === 'mesic') {
    return fmt.monthYear(lang, cursor);
  }
  return `${fmt.monthYear(lang, range.start)} – ${fmt.monthYear(lang, range.end)}`;
};

const sourceTone = (status: RentalOverviewSources[SourceId]['status']): Tone => {
  if (status === 'ready') {
    return 'success';
  }
  return status === 'loading' || status === 'forbidden' ? 'neutral' : 'danger';
};

const cellBackground = (outside: boolean) => (outside ? 'bg-surface' : 'bg-base');

const dayNumberColour = (isToday: boolean, outside: boolean) => {
  if (isToday) {
    return `${toneColors('primary').accent} text-fg-reverse`;
  }
  return outside ? 'text-fg-secondary' : '';
};

const relativeDayLabel = (days: number, t: ReturnType<typeof useModernI18n>['t']) => {
  if (days === 0) {
    return t(`${k}.relative.today`);
  }
  return days > 0 ? t(`${k}.relative.inDays`, { count: days }) : t(`${k}.relative.daysAgo`, { count: -days });
};

const Toggle = ({
  active,
  label,
  onToggle,
}: {
  readonly active: boolean;
  readonly label: string;
  readonly onToggle: () => void;
}) => (
  <Button
    aria-pressed={active}
    className={[
      'rounded-full border px-3 py-1 text-xs font-medium',
      ...(active
        ? [toneColors('primary').border, toneColors('primary').tint, toneColors('primary').fg]
        : ['border-border-primary bg-transparent text-inherit']),
    ].join(' ')}
    composition
    onClick={onToggle}
    size="current"
    unstyled
  >
    <span className="inline-flex items-center gap-1">
      {active && <Icon name="check" size={12} />}
      {label}
    </span>
  </Button>
);

const EventChip = ({
  onOpen,
  row,
  today,
}: {
  readonly onOpen: (row: Deadline) => void;
  readonly row: Deadline;
  readonly today: string;
}) => {
  const { t } = useModernI18n();
  const tone = categoryTone[row.category];
  const colors = toneColors(tone);
  const overdue = urgencyOf(row, today) === 'overdue';
  const categoryLabel = t(`${k}.category.${row.category}`);
  return (
    <Tooltip content={`${categoryLabel}: ${row.title}`}>
      <Button
        className={`flex w-full justify-start truncate rounded-md border-0 border-l-2 px-1.5 py-0.5 text-left text-[11px] font-medium ${colors.tint} ${colors.fg} ${overdue ? toneColors('danger').border : colors.border}${row.done ? ' line-through opacity-60' : ''}`}
        composition
        data-key={row.key}
        onClick={() => onOpen(row)}
        size="current"
        unstyled
      >
        <span className="truncate">{row.title}</span>
      </Button>
    </Tooltip>
  );
};

const weekdayHeaders = (lang: 'cs' | 'en', start: string) =>
  [0, 1, 2, 3, 4, 5, 6].map((offset) => fmt.weekday(lang, addDays(start, offset)));

const MonthGrid = ({
  byDate,
  cursor,
  lang,
  onOpen,
  start,
  today,
}: {
  readonly byDate: ReadonlyMap<string, readonly Deadline[]>;
  readonly cursor: string;
  readonly lang: 'cs' | 'en';
  readonly onOpen: (row: Deadline) => void;
  readonly start: string;
  readonly today: string;
}) => {
  const { t } = useModernI18n();
  const month = cursor.slice(0, 7);
  const days = Array.from({ length: 42 }, (_, index) => addDays(start, index));
  return (
    <div className="overflow-hidden rounded-lg border border-border-primary" data-testid="calendar-month">
      <div className="grid grid-cols-7 bg-surface">
        {weekdayHeaders(lang, start).map((label) => (
          <div className="px-2 py-2 text-xs font-semibold uppercase text-fg-secondary" key={label}>
            {label}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((date) => {
          const rows = byDate.get(date) ?? [];
          const more = rows.at(3);
          const isToday = date === today;
          const outside = date.slice(0, 7) !== month;
          return (
            <div
              className={`flex min-h-28 flex-col gap-1 border-l border-t border-border-primary/60 p-1.5 ${cellBackground(outside)}`}
              data-date={date}
              key={date}
            >
              <span
                className={`inline-flex h-6 w-6 items-center justify-center self-end rounded-full text-xs font-semibold ${dayNumberColour(isToday, outside)}`}
              >
                {Number(date.slice(8, 10))}
              </span>
              {rows.slice(0, 3).map((row) => (
                <EventChip key={row.key} onOpen={onOpen} row={row} today={today} />
              ))}
              {rows.length > 3 && more !== undefined && (
                <Button
                  className="justify-start border-0 bg-transparent px-1 text-left text-[11px] font-medium text-fg-secondary"
                  composition
                  onClick={() => onOpen(more)}
                  size="current"
                  unstyled
                >
                  {t(`${k}.calendar.more`, { count: rows.length - 3 })}
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const WeekGrid = ({
  byDate,
  lang,
  onOpen,
  start,
  today,
}: {
  readonly byDate: ReadonlyMap<string, readonly Deadline[]>;
  readonly lang: 'cs' | 'en';
  readonly onOpen: (row: Deadline) => void;
  readonly start: string;
  readonly today: string;
}) => {
  const { t } = useModernI18n();
  const days = Array.from({ length: 7 }, (_, index) => addDays(start, index));
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-7" data-testid="calendar-week">
      {days.map((date) => {
        const rows = byDate.get(date) ?? [];
        const isToday = date === today;
        return (
          <div
            className={[
              'flex min-h-[260px] flex-col gap-1.5 rounded-lg border bg-surface p-2',
              ...(isToday
                ? ['ring-2', toneColors('primary').border, toneColors('primary').ring]
                : ['border-transparent']),
            ].join(' ')}
            data-date={date}
            key={date}
          >
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-semibold uppercase text-fg-secondary">{fmt.weekday(lang, date)}</span>
              <span className="text-lg font-semibold">{fmt.dayMonth(lang, date)}</span>
            </div>
            {rows.length === 0 ? (
              <span className="text-xs text-fg-secondary">{t(`${k}.calendar.free`)}</span>
            ) : (
              rows.map((row) => <EventChip key={row.key} onOpen={onOpen} row={row} today={today} />)
            )}
          </div>
        );
      })}
    </div>
  );
};

const ListView = ({
  lang,
  onOpen,
  rows,
  today,
}: {
  readonly lang: 'cs' | 'en';
  readonly onOpen: (row: Deadline) => void;
  readonly rows: readonly Deadline[];
  readonly today: string;
}) => {
  const { t } = useModernI18n();
  if (rows.length === 0) {
    return <EmptyState description={t(`${k}.calendar.emptyDescription`)} title={t(`${k}.calendar.empty`)} />;
  }
  const groups = new Map<string, Deadline[]>();
  for (const row of rows) {
    groups.set(row.date, [...(groups.get(row.date) ?? []), row]);
  }
  return (
    <div className="flex flex-col gap-4" data-testid="calendar-list">
      {[...groups.entries()].map(([date, items]) => {
        const days = daysUntil(date, today);
        return (
          <section className="flex flex-col gap-1.5" key={date}>
            <h3 className="m-0 flex items-center gap-2 text-sm font-semibold first-letter:uppercase">
              {fmt.long(lang, date)}
              <span className="text-xs font-normal text-fg-secondary">{relativeDayLabel(days, t)}</span>
            </h3>
            {items.map((row) => {
              const urgency = urgencyOf(row, today);
              return (
                <Button
                  className="block w-full rounded-lg border-0 bg-surface px-3 py-2.5 text-left text-inherit hover:shadow-md"
                  composition
                  data-key={row.key}
                  key={row.key}
                  onClick={() => onOpen(row)}
                  size="current"
                  unstyled
                >
                  <span className="flex flex-wrap items-center gap-3">
                    <Pill tone={categoryTone[row.category]}>{t(`${k}.category.${row.category}`)}</Pill>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className={`truncate font-medium${row.done ? ' line-through' : ''}`}>{row.title}</span>
                      <span className="truncate text-xs text-fg-secondary">
                        {[t(`${k}.sources.${row.source}`), row.location]
                          .filter((part) => part !== undefined)
                          .join(' · ')}
                      </span>
                    </span>
                    <Pill tone={urgencyTone[urgency]}>{t(`${k}.urgency.${urgency}`)}</Pill>
                  </span>
                </Button>
              );
            })}
          </section>
        );
      })}
    </div>
  );
};

const renderCalendarGrid = (
  mode: CalendarMode,
  overdueOnly: boolean,
  input: {
    readonly byDate: ReadonlyMap<string, readonly Deadline[]>;
    readonly cursor: string;
    readonly lang: ReturnType<typeof langOf>;
    readonly onOpen: (row: Deadline) => void;
    readonly range: { readonly end: string; readonly start: string };
    readonly rows: readonly Deadline[];
    readonly today: string;
  },
) => {
  const { onOpen: handleOpen } = input;
  if (mode === 'mesic' && !overdueOnly) {
    return (
      <MonthGrid
        byDate={input.byDate}
        cursor={input.cursor}
        lang={input.lang}
        onOpen={handleOpen}
        start={input.range.start}
        today={input.today}
      />
    );
  }
  if (mode === 'tyden' && !overdueOnly) {
    return (
      <WeekGrid
        byDate={input.byDate}
        lang={input.lang}
        onOpen={handleOpen}
        start={input.range.start}
        today={input.today}
      />
    );
  }
  return <ListView lang={input.lang} onOpen={handleOpen} rows={input.rows} today={input.today} />;
};

// A seven-column month grid leaves a phone one or two letters per event, so phones open the list unless a view was
// chosen (in the URL or with the mode switch).
const narrowViewportQuery = '(max-width: 39.99rem)';
const subscribeNarrowViewport = (onChange: () => void) => {
  const query = globalThis.matchMedia(narrowViewportQuery);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};
const useNarrowViewport = () =>
  useSyncExternalStore(
    subscribeNarrowViewport,
    () => globalThis.matchMedia(narrowViewportQuery).matches,
    // The server render keeps the month grid; the first client render corrects it.
    () => false,
  );

const calendarRange = (mode: CalendarMode, cursor: string) => {
  if (mode === 'tyden') {
    const start = weekStart(cursor);
    return { end: addDays(start, 6), start };
  }
  if (mode === 'mesic') {
    const start = weekStart(monthStart(cursor));
    return { end: addDays(start, 41), start };
  }
  const start = monthStart(cursor);
  return { end: addDays(addMonths(start, 3), -1), start };
};

export const CalendarView = ({
  agendaRevision,
  canLog,
  deadlines,
  initialMode,
  initialOverdue,
  me,
  onOpen,
  sources,
  today,
}: {
  readonly agendaRevision: number;
  readonly canLog: boolean;
  readonly deadlines: readonly Deadline[];
  readonly initialMode: CalendarMode;
  readonly initialOverdue: boolean;
  readonly me: string | undefined;
  readonly onOpen: (deadline: Deadline) => void;
  readonly sources: RentalOverviewSources;
  readonly today: string;
}) => {
  const { language, t } = useModernI18n();
  const lang = langOf(language);
  const narrow = useNarrowViewport();
  const [chosenMode, setChosenMode] = useState<CalendarMode | undefined>(
    initialMode === 'mesic' ? undefined : initialMode,
  );
  const mode: CalendarMode = chosenMode ?? (narrow ? 'seznam' : 'mesic');
  const [cursor, setCursor] = useState(today);
  const [hidden, setHidden] = useState<ReadonlySet<SourceId>>(new Set());
  const [mineOnly, setMineOnly] = useState(false);
  const [overdueOnly, setOverdueOnly] = useState(initialOverdue);
  const [showDone, setShowDone] = useState(false);
  const [query, setQuery] = useState('');

  const range = calendarRange(mode, cursor);

  const filtered = (() => {
    const words = foldSearchText(query)
      .split(/\s+/u)
      .filter((word) => word !== '');
    return deadlines.filter((row) => {
      if (hidden.has(row.source === 'parties' ? 'ops' : row.source)) {
        return false;
      }
      if (mineOnly && row.ownerPrincipalId !== me) {
        return false;
      }
      if (!showDone && row.done) {
        return false;
      }
      if (overdueOnly && !(row.date < today && !row.done)) {
        return false;
      }
      if (words.length > 0) {
        const categoryLabel = t(`${k}.category.${row.category}`);
        const text = foldSearchText(`${row.title} ${row.location ?? ''} ${categoryLabel}`);
        if (!words.every((word) => text.includes(word))) {
          return false;
        }
      }
      return true;
    });
  })();

  const inRange = overdueOnly ? filtered : filtered.filter((row) => row.date >= range.start && row.date <= range.end);
  const byDate = (() => {
    const map = new Map<string, Deadline[]>();
    for (const row of inRange) {
      map.set(row.date, [...(map.get(row.date) ?? []), row]);
    }
    return map;
  })();

  const step = (direction: -1 | 1) => {
    if (mode === 'tyden') {
      setCursor(addDays(cursor, 7 * direction));
    } else {
      setCursor(addMonths(monthStart(cursor), direction * (mode === 'seznam' ? 3 : 1)));
    }
  };

  const periodLabel = calendarPeriod(mode, lang, range, cursor);

  const csv = () => {
    browserRuntime.runFork(
      exportCsv({
        fileName: `provoz-kalendar-${range.start}.csv`,
        filter: [
          `od=${overdueOnly ? '' : range.start}`,
          `do=${overdueOnly ? today : range.end}`,
          mineOnly ? 'jen-moje' : '',
          overdueOnly ? 'po-terminu' : '',
          hidden.size > 0 ? `skryte=${[...hidden].join(',')}` : '',
          query === '' ? '' : `q=${query}`,
        ]
          .filter((part) => part !== '')
          .join(' '),
        header: [
          t(`${k}.columns.date`),
          t(`${k}.columns.category`),
          t(`${k}.columns.title`),
          t(`${k}.columns.location`),
          t(`${k}.columns.source`),
          t(`${k}.columns.status`),
          t(`${k}.columns.link`),
        ],
        list: 'calendar',
        log: canLog,
        revision: agendaRevision,
        rows: inRange.map((row) => [
          row.date,
          t(`${k}.category.${row.category}`),
          row.title,
          row.location,
          t(`${k}.sources.${row.source}`),
          t(`${k}.urgency.${urgencyOf(row, today)}`),
          `${window.location.origin}/${lang}${row.href}`,
        ]),
      }),
    );
  };

  const missing = sourceKeys.filter(
    (key) => key !== 'parties' && sources[key].status !== 'ready' && sources[key].status !== 'loading',
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button
            appearance="outline"
            aria-label={t(`${k}.calendar.previous`)}
            onClick={() => step(-1)}
            severity="secondary"
            size="sm"
          >
            <Icon name="chevronLeft" size={18} />
          </Button>
          <Button appearance="outline" onClick={() => setCursor(today)} severity="secondary" size="sm">
            {t(`${k}.calendar.today`)}
          </Button>
          <Button
            appearance="outline"
            aria-label={t(`${k}.calendar.next`)}
            onClick={() => step(1)}
            severity="secondary"
            size="sm"
          >
            <Icon name="chevronRight" size={18} />
          </Button>
          <h2 className="m-0 ml-2 text-lg font-semibold first-letter:uppercase" data-testid="calendar-period">
            {overdueOnly ? t(`${k}.calendar.overduePeriod`) : periodLabel}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <fieldset className="m-0 inline-flex min-w-0 rounded-lg border-0 bg-surface p-0.5">
            {(['mesic', 'tyden', 'seznam'] as const).map((value) => (
              <Button
                aria-pressed={mode === value}
                className={`rounded-md border-0 px-3 py-1.5 text-sm font-medium text-inherit ${mode === value ? 'bg-base shadow-sm' : 'bg-transparent'}`}
                composition
                data-mode={value}
                key={value}
                onClick={() => setChosenMode(value)}
                size="current"
                unstyled
              >
                {t(`${k}.calendar.mode.${value}`)}
              </Button>
            ))}
          </fieldset>
          <Button appearance="outline" onClick={csv} severity="secondary" size="sm">
            {t(`${k}.export.csv`)}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {calendarSources.map((source) => {
          const off = hidden.has(source);
          const { status } = sources[source];
          return (
            <Tooltip content={t(`${k}.state.${status}`)} key={source}>
              <Button
                aria-pressed={!off}
                className={`rounded-full border border-border-primary px-3 py-1 text-xs font-medium text-inherit ${off ? 'bg-transparent opacity-50' : 'bg-base'}`}
                composition
                data-source={source}
                onClick={() =>
                  setHidden((current) => {
                    const next = new Set(current);
                    if (next.has(source)) {
                      next.delete(source);
                    } else {
                      next.add(source);
                    }
                    return next;
                  })
                }
                size="current"
                unstyled
              >
                <span className="inline-flex items-center gap-1.5">
                  <Dot tone={sourceTone(status)} />
                  {t(`${k}.sources.${source}`)}
                  {status === 'forbidden' && <Icon name="lock" size={12} />}
                </span>
              </Button>
            </Tooltip>
          );
        })}
        <span className="mx-1 h-5 w-px bg-border-primary" />
        <Toggle active={mineOnly} label={t(`${k}.calendar.mineOnly`)} onToggle={() => setMineOnly((value) => !value)} />
        <Toggle
          active={overdueOnly}
          label={t(`${k}.calendar.overdueOnly`)}
          onToggle={() => setOverdueOnly((value) => !value)}
        />
        <Toggle active={showDone} label={t(`${k}.calendar.showDone`)} onToggle={() => setShowDone((value) => !value)} />
        <Input
          aria-label={t(`${k}.calendar.filter`)}
          className="ml-auto h-auto w-auto min-w-[200px] rounded-lg px-3 py-1.5 text-sm"
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t(`${k}.calendar.filter`)}
          size="sm"
          type="search"
          value={query}
        />
      </div>

      {missing.length > 0 && (
        <p className="m-0 flex items-center gap-2 text-xs text-fg-secondary">
          <Icon name="info" size={14} />
          {t(`${k}.calendar.missingSources`, {
            sources: missing
              .map((key) => {
                const sourceLabel = t(`${k}.sources.${key}`);
                const stateLabel = t(`${k}.state.${sources[key].status}`);
                return `${sourceLabel} (${stateLabel})`;
              })
              .join(', '),
          })}
        </p>
      )}

      {renderCalendarGrid(mode, overdueOnly, { byDate, cursor, lang, onOpen, range, rows: inRange, today })}
      <p className="m-0 text-xs text-fg-secondary">{t(`${k}.calendar.readOnlyNote`)}</p>
    </div>
  );
};
