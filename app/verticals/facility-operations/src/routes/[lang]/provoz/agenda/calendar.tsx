// @effect-diagnostics asyncFunction:off globalDate:off
// S13 shared calendar: month / week / list over deadlines READ from their sources. Owned by the ops-agenda lane.
import { EmptyState } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { useMemo, useState } from 'react';
import { addDays, daysUntil, urgencyOf } from '../../../../ui/ops-agenda/deadlines.ts';
import type { Deadline, SourceId } from '../../../../ui/ops-agenda/deadlines.ts';
import { sourceKeys } from '../../../../ui/ops-agenda/sources.ts';
import type { RentalOverviewSources } from '../../../../ui/ops-agenda/sources.ts';
import { Dot, Icon, Pill, categoryTone, exportCsv, fmt, langOf, toneColors, urgencyTone } from '../../../../ui/ops-agenda/ui-bits.tsx';
import { foldSearchText } from '@app/admin-ui';

const k = 'facility-operations.agenda';
const muted = { color: 'var(--color-fg-secondary, #6b7280)' } as const;

export type CalendarMode = 'mesic' | 'tyden' | 'seznam';

const calendarSources: readonly SourceId[] = ['agreements', 'occupancy', 'work', 'finance', 'property', 'ops'];

const monthStart = (date: string) => `${date.slice(0, 7)}-01`;
const addMonths = (date: string, months: number) => {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7)) - 1 + months;
  const next = new Date(Date.UTC(year, month, 1));
  return next.toISOString().slice(0, 10);
};
/** Monday of the week containing `date`. */
const weekStart = (date: string) => {
  const weekday = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(date, -weekday);
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
  const [mode, setMode] = useState<CalendarMode>(initialMode);
  const [cursor, setCursor] = useState(today);
  const [hidden, setHidden] = useState<ReadonlySet<SourceId>>(new Set());
  const [mineOnly, setMineOnly] = useState(false);
  const [overdueOnly, setOverdueOnly] = useState(initialOverdue);
  const [showDone, setShowDone] = useState(false);
  const [query, setQuery] = useState('');

  const range = useMemo(() => {
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
  }, [mode, cursor]);

  const filtered = useMemo(() => {
    const words = foldSearchText(query).split(/\s+/u).filter((word) => word !== '');
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
        const text = foldSearchText(`${row.title} ${row.location ?? ''} ${t(`${k}.category.${row.category}`)}`);
        if (!words.every((word) => text.includes(word))) {
          return false;
        }
      }
      return true;
    });
  }, [deadlines, hidden, mineOnly, me, showDone, overdueOnly, today, query, t]);

  const inRange = overdueOnly ? filtered : filtered.filter((row) => row.date >= range.start && row.date <= range.end);
  const byDate = useMemo(() => {
    const map = new Map<string, Deadline[]>();
    for (const row of inRange) {
      map.set(row.date, [...(map.get(row.date) ?? []), row]);
    }
    return map;
  }, [inRange]);

  const step = (direction: -1 | 1) => {
    if (mode === 'tyden') {
      setCursor(addDays(cursor, 7 * direction));
    } else {
      setCursor(addMonths(monthStart(cursor), direction * (mode === 'seznam' ? 3 : 1)));
    }
  };

  const periodLabel =
    mode === 'tyden'
      ? `${fmt.short(lang, range.start)} – ${fmt.short(lang, range.end)}`
      : mode === 'mesic'
        ? fmt.monthYear(lang, cursor)
        : `${fmt.monthYear(lang, range.start)} – ${fmt.monthYear(lang, range.end)}`;

  const csv = () =>
    void exportCsv({
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
      header: [t(`${k}.columns.date`), t(`${k}.columns.category`), t(`${k}.columns.title`), t(`${k}.columns.location`), t(`${k}.columns.source`), t(`${k}.columns.status`), t(`${k}.columns.link`)],
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
    });

  const missing = sourceKeys.filter((key) => key !== 'parties' && sources[key].status !== 'ready' && sources[key].status !== 'loading');

  return (
    <div className="facilityoperations:flex facilityoperations:flex-col facilityoperations:gap-3">
      <div className="facilityoperations:flex facilityoperations:flex-wrap facilityoperations:items-center facilityoperations:justify-between facilityoperations:gap-3">
        <div className="facilityoperations:flex facilityoperations:items-center facilityoperations:gap-2">
          <Button aria-label={t(`${k}.calendar.previous`)} onClick={() => step(-1)} size="sm" theme="outlined" variant="secondary">
            <Icon name="chevronLeft" size={18} />
          </Button>
          <Button onClick={() => setCursor(today)} size="sm" theme="outlined" variant="secondary">
            {t(`${k}.calendar.today`)}
          </Button>
          <Button aria-label={t(`${k}.calendar.next`)} onClick={() => step(1)} size="sm" theme="outlined" variant="secondary">
            <Icon name="chevronRight" size={18} />
          </Button>
          <h2 className="facilityoperations:m-0 facilityoperations:ml-2 facilityoperations:text-lg facilityoperations:font-semibold facilityoperations:first-letter:uppercase" data-testid="calendar-period">
            {overdueOnly ? t(`${k}.calendar.overduePeriod`) : periodLabel}
          </h2>
        </div>
        <div className="facilityoperations:flex facilityoperations:items-center facilityoperations:gap-2">
          <div className="facilityoperations:inline-flex facilityoperations:rounded-lg facilityoperations:p-0.5" role="group" style={{ background: 'var(--color-surface-subtle, #f1f5f9)' }}>
            {(['mesic', 'tyden', 'seznam'] as const).map((value) => (
              <button
                aria-pressed={mode === value}
                className="facilityoperations:cursor-pointer facilityoperations:rounded-md facilityoperations:border-0 facilityoperations:px-3 facilityoperations:py-1.5 facilityoperations:text-sm facilityoperations:font-medium"
                data-mode={value}
                key={value}
                onClick={() => setMode(value)}
                style={{
                  background: mode === value ? '#ffffff' : 'transparent',
                  boxShadow: mode === value ? '0 1px 2px rgba(0,0,0,.08)' : 'none',
                  color: 'inherit',
                }}
                type="button"
              >
                {t(`${k}.calendar.mode.${value}`)}
              </button>
            ))}
          </div>
          <Button onClick={csv} size="sm" theme="outlined" variant="secondary">
            {t(`${k}.export.csv`)}
          </Button>
        </div>
      </div>

      <div className="facilityoperations:flex facilityoperations:flex-wrap facilityoperations:items-center facilityoperations:gap-2">
        {calendarSources.map((source) => {
          const off = hidden.has(source);
          const status = sources[source].status;
          return (
            <button
              aria-pressed={!off}
              className="facilityoperations:inline-flex facilityoperations:cursor-pointer facilityoperations:items-center facilityoperations:gap-1.5 facilityoperations:rounded-full facilityoperations:px-3 facilityoperations:py-1 facilityoperations:text-xs facilityoperations:font-medium"
              data-source={source}
              key={source}
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
              style={{
                background: off ? 'transparent' : '#ffffff',
                border: '1px solid var(--color-border-primary, #d1d5db)',
                color: 'inherit',
                opacity: off ? 0.5 : 1,
              }}
              title={t(`${k}.state.${status}`)}
              type="button"
            >
              <Dot tone={status === 'ready' ? 'success' : status === 'loading' ? 'neutral' : status === 'forbidden' ? 'neutral' : 'danger'} />
              {t(`${k}.sources.${source}`)}
              {status === 'forbidden' && <Icon name="lock" size={12} />}
            </button>
          );
        })}
        <span className="facilityoperations:mx-1 facilityoperations:h-5 facilityoperations:w-px" style={{ background: 'var(--color-border-primary, #d1d5db)' }} />
        <Toggle active={mineOnly} label={t(`${k}.calendar.mineOnly`)} onToggle={() => setMineOnly((value) => !value)} />
        <Toggle active={overdueOnly} label={t(`${k}.calendar.overdueOnly`)} onToggle={() => setOverdueOnly((value) => !value)} />
        <Toggle active={showDone} label={t(`${k}.calendar.showDone`)} onToggle={() => setShowDone((value) => !value)} />
        <input
          aria-label={t(`${k}.calendar.filter`)}
          className="facilityoperations:ml-auto facilityoperations:min-w-[200px] facilityoperations:rounded-lg facilityoperations:px-3 facilityoperations:py-1.5 facilityoperations:text-sm"
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t(`${k}.calendar.filter`)}
          style={{ background: '#ffffff', border: '1px solid var(--color-border-primary, #d1d5db)' }}
          type="search"
          value={query}
        />
      </div>

      {missing.length > 0 && (
        <p className="facilityoperations:m-0 facilityoperations:flex facilityoperations:items-center facilityoperations:gap-2 facilityoperations:text-xs" style={muted}>
          <Icon name="info" size={14} />
          {t(`${k}.calendar.missingSources`, {
            sources: missing.map((key) => `${t(`${k}.sources.${key}`)} (${t(`${k}.state.${sources[key].status}`)})`).join(', '),
          })}
        </p>
      )}

      {mode === 'mesic' && !overdueOnly ? (
        <MonthGrid byDate={byDate} cursor={cursor} lang={lang} onOpen={onOpen} start={range.start} today={today} />
      ) : mode === 'tyden' && !overdueOnly ? (
        <WeekGrid byDate={byDate} lang={lang} onOpen={onOpen} start={range.start} today={today} />
      ) : (
        <ListView lang={lang} onOpen={onOpen} rows={inRange} today={today} />
      )}
      <p className="facilityoperations:m-0 facilityoperations:text-xs" style={muted}>
        {t(`${k}.calendar.readOnlyNote`)}
      </p>
    </div>
  );
};

const Toggle = ({ active, label, onToggle }: { readonly active: boolean; readonly label: string; readonly onToggle: () => void }) => (
  <button
    aria-pressed={active}
    className="facilityoperations:inline-flex facilityoperations:cursor-pointer facilityoperations:items-center facilityoperations:gap-1 facilityoperations:rounded-full facilityoperations:px-3 facilityoperations:py-1 facilityoperations:text-xs facilityoperations:font-medium"
    onClick={onToggle}
    style={{
      background: active ? toneColors('primary').bg : 'transparent',
      border: `1px solid ${active ? toneColors('primary').accent : 'var(--color-border-primary, #d1d5db)'}`,
      color: active ? toneColors('primary').fg : 'inherit',
    }}
    type="button"
  >
    {active && <Icon name="check" size={12} />}
    {label}
  </button>
);

const EventChip = ({ onOpen, row, today }: { readonly onOpen: (row: Deadline) => void; readonly row: Deadline; readonly today: string }) => {
  const { t } = useModernI18n();
  const tone = categoryTone[row.category];
  const colors = toneColors(tone);
  const overdue = urgencyOf(row, today) === 'overdue';
  return (
    <button
      className="facilityoperations:flex facilityoperations:w-full facilityoperations:cursor-pointer facilityoperations:items-center facilityoperations:gap-1 facilityoperations:truncate facilityoperations:rounded-md facilityoperations:border-0 facilityoperations:px-1.5 facilityoperations:py-0.5 facilityoperations:text-left facilityoperations:text-[11px] facilityoperations:font-medium"
      data-key={row.key}
      onClick={() => onOpen(row)}
      style={{
        background: colors.bg,
        borderLeft: `3px solid ${overdue ? toneColors('danger').accent : colors.accent}`,
        color: colors.fg,
        opacity: row.done ? 0.55 : 1,
        textDecoration: row.done ? 'line-through' : 'none',
      }}
      title={`${t(`${k}.category.${row.category}`)}: ${row.title}`}
      type="button"
    >
      <span className="facilityoperations:truncate">{row.title}</span>
    </button>
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
    <div className="facilityoperations:overflow-hidden facilityoperations:rounded-2xl" data-testid="calendar-month" style={{ border: '1px solid var(--color-border-primary, #e5e7eb)' }}>
      <div className="facilityoperations:grid facilityoperations:grid-cols-7" style={{ background: '#f4f5f7' }}>
        {weekdayHeaders(lang, start).map((label) => (
          <div className="facilityoperations:px-2 facilityoperations:py-2 facilityoperations:text-xs facilityoperations:font-semibold facilityoperations:uppercase" key={label} style={muted}>
            {label}
          </div>
        ))}
      </div>
      <div className="facilityoperations:grid facilityoperations:grid-cols-7">
        {days.map((date) => {
          const rows = byDate.get(date) ?? [];
          const isToday = date === today;
          const outside = date.slice(0, 7) !== month;
          const weekend = [5, 6].includes((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7);
          return (
            <div
              className="facilityoperations:flex facilityoperations:min-h-[112px] facilityoperations:flex-col facilityoperations:gap-1 facilityoperations:p-1.5"
              data-date={date}
              key={date}
              style={{
                background: outside ? '#f4f5f7' : weekend ? '#fafafb' : '#ffffff',
                borderTop: '1px solid var(--color-border-muted, #eef0f3)',
                borderLeft: '1px solid var(--color-border-muted, #eef0f3)',
              }}
            >
              <span
                className="facilityoperations:inline-flex facilityoperations:h-6 facilityoperations:w-6 facilityoperations:items-center facilityoperations:justify-center facilityoperations:self-end facilityoperations:rounded-full facilityoperations:text-xs facilityoperations:font-semibold"
                style={
                  isToday
                    ? { background: toneColors('primary').accent, color: '#fff' }
                    : { color: outside ? 'var(--color-fg-secondary, #9ca3af)' : 'inherit' }
                }
              >
                {Number(date.slice(8, 10))}
              </span>
              {rows.slice(0, 3).map((row) => (
                <EventChip key={row.key} onOpen={onOpen} row={row} today={today} />
              ))}
              {rows.length > 3 && (
                <button
                  className="facilityoperations:cursor-pointer facilityoperations:border-0 facilityoperations:bg-transparent facilityoperations:px-1 facilityoperations:text-left facilityoperations:text-[11px] facilityoperations:font-medium"
                  onClick={() => onOpen(rows[3] as Deadline)}
                  style={muted}
                  type="button"
                >
                  {t(`${k}.calendar.more`, { count: rows.length - 3 })}
                </button>
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
    <div className="facilityoperations:grid facilityoperations:grid-cols-1 facilityoperations:gap-2 facilityoperations:md:grid-cols-7" data-testid="calendar-week">
      {days.map((date) => {
        const rows = byDate.get(date) ?? [];
        const isToday = date === today;
        return (
          <div
            className="facilityoperations:flex facilityoperations:min-h-[260px] facilityoperations:flex-col facilityoperations:gap-1.5 facilityoperations:rounded-xl facilityoperations:p-2"
            data-date={date}
            key={date}
            style={{
              background: '#ffffff',
              border: `1px solid ${isToday ? toneColors('primary').accent : 'var(--color-border-primary, #e5e7eb)'}`,
              boxShadow: isToday ? `0 0 0 2px ${toneColors('primary').ring}` : 'none',
            }}
          >
            <div className="facilityoperations:flex facilityoperations:items-baseline facilityoperations:justify-between">
              <span className="facilityoperations:text-xs facilityoperations:font-semibold facilityoperations:uppercase" style={muted}>
                {fmt.weekday(lang, date)}
              </span>
              <span className="facilityoperations:text-lg facilityoperations:font-semibold">{fmt.dayMonth(lang, date)}</span>
            </div>
            {rows.length === 0 ? (
              <span className="facilityoperations:text-xs" style={muted}>
                {t(`${k}.calendar.free`)}
              </span>
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
    <div className="facilityoperations:flex facilityoperations:flex-col facilityoperations:gap-4" data-testid="calendar-list">
      {[...groups.entries()].map(([date, items]) => {
        const days = daysUntil(date, today);
        return (
          <section className="facilityoperations:flex facilityoperations:flex-col facilityoperations:gap-1.5" key={date}>
            <h3 className="facilityoperations:m-0 facilityoperations:flex facilityoperations:items-center facilityoperations:gap-2 facilityoperations:text-sm facilityoperations:font-semibold facilityoperations:first-letter:uppercase">
              {fmt.long(lang, date)}
              <span className="facilityoperations:text-xs facilityoperations:font-normal" style={muted}>
                {days === 0 ? t(`${k}.relative.today`) : days > 0 ? t(`${k}.relative.inDays`, { count: days }) : t(`${k}.relative.daysAgo`, { count: -days })}
              </span>
            </h3>
            {items.map((row) => {
              const urgency = urgencyOf(row, today);
              return (
                <button
                  className="facilityoperations:flex facilityoperations:w-full facilityoperations:cursor-pointer facilityoperations:flex-wrap facilityoperations:items-center facilityoperations:gap-3 facilityoperations:rounded-xl facilityoperations:px-3 facilityoperations:py-2.5 facilityoperations:text-left facilityoperations:hover:shadow-md"
                  data-key={row.key}
                  key={row.key}
                  onClick={() => onOpen(row)}
                  style={{ background: '#ffffff', border: '1px solid var(--color-border-primary, #e5e7eb)', color: 'inherit', font: 'inherit' }}
                  type="button"
                >
                  <Pill tone={categoryTone[row.category]}>{t(`${k}.category.${row.category}`)}</Pill>
                  <span className="facilityoperations:flex facilityoperations:min-w-0 facilityoperations:flex-1 facilityoperations:flex-col">
                    <span className="facilityoperations:truncate facilityoperations:font-medium" style={{ textDecoration: row.done ? 'line-through' : 'none' }}>
                      {row.title}
                    </span>
                    <span className="facilityoperations:truncate facilityoperations:text-xs" style={muted}>
                      {[t(`${k}.sources.${row.source}`), row.location].filter((part) => part !== undefined).join(' · ')}
                    </span>
                  </span>
                  <Pill tone={urgencyTone[urgency]}>{t(`${k}.urgency.${urgency}`)}</Pill>
                </button>
              );
            })}
          </section>
        );
      })}
    </div>
  );
};
