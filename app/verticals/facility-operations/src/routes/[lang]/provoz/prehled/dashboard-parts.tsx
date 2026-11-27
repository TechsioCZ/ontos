import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
// Building blocks of the Nájempark overview dashboard (S15). Owned by the ops-agenda lane.
import { EmptyState, SectionCard, formatMoney, formatNumber, formatPercent } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { useState } from 'react';
import { DateTime, Effect, Match } from 'effect';
import type { ReactNode } from 'react';
import { agendaIds } from '../../../../../shared/agendas.ts';
import { daysUntil, urgencyOf } from '../../../../ui/ops-agenda/deadlines.ts';
import { opsSegments } from '../../../../../shared/domain/ops-overview.ts';
import type { Deadline } from '../../../../../shared/domain/ops-overview.ts';
import { personalGreetingName, searchRows, unitAvailability } from '../../../../ui/ops-agenda/model.ts';
import type { DrillRow, Kpi, KpiId, SearchKind, SearchRow, Tone } from '../../../../ui/ops-agenda/model.ts';
import { LoadingSkeleton } from '../../../../ui/loading-skeleton.tsx';
import { sourceKeys } from '../../../../ui/ops-agenda/sources.ts';
import type { RentalOverviewSources } from '../../../../ui/ops-agenda/sources.ts';
import {
  Dot,
  Icon,
  IconBadge,
  Pill,
  categoryTone,
  exportCsv,
  fmt,
  langOf,
  statusTone,
  toneColors,
  urgencyTone,
} from '../../../../ui/ops-agenda/ui-bits.tsx';
import type { IconName } from '../../../../ui/ops-agenda/ui-bits.tsx';

const k = 'facility-operations.agenda';
const trackBackground = 'var(--color-neutral-200, #e5e7eb)';
const muted = { color: 'var(--color-fg-secondary, #6b7280)' } as const;
const card = {
  background: 'var(--color-surface)',
  border: '1px solid transparent',
} as const;

const useLang = () => {
  const { language, t } = useModernI18n();
  return { lang: langOf(language), t };
};

const linkTo = (lang: string, href: string) => `/${lang}${href}`;

// ---- Hero ----------------------------------------------------------------------------------------------------------

const pragueHourFormat = new Intl.DateTimeFormat('en-GB', {
  hour: 'numeric',
  hour12: false,
  timeZone: 'Europe/Prague',
});
const greetingForHour = (hour: number) => {
  if (hour < 10) {
    return 'morning';
  }
  if (hour < 18) {
    return 'day';
  }
  return 'evening';
};

/** Quiet inline placeholder of a value whose source has not settled yet (no loading text). */
const PendingBar = () => {
  const { t } = useLang();
  return (
    <span className="inline-block h-3 w-16 animate-pulse rounded" style={{ background: trackBackground }}>
      <span className="sr-only">{t('facility-operations.common.loading')}</span>
    </span>
  );
};

const OccupancyFigure = ({ kpi }: { readonly kpi: Kpi | undefined }) => {
  const { t } = useLang();
  const total = Number(kpi?.secondary?.['total'] ?? 0);
  const occupied = Number(kpi?.secondary?.['occupied'] ?? 0);
  const reserved = Number(kpi?.secondary?.['reserved'] ?? 0);
  const ready = kpi?.status === 'ready' && kpi.value !== undefined && total > 0;
  return (
    <div className="flex w-full flex-col gap-3" style={{ maxWidth: 300 }}>
      <span className="text-sm font-medium" style={muted}>
        {t(`${k}.overview.occupiedToday`)}
      </span>
      <strong style={{ fontSize: 56, fontWeight: 600, letterSpacing: '-0.04em', lineHeight: 1.1 }}>
        {ready ? formatPercent(kpi.value ?? 0) : '—'}
      </strong>
      {ready ? (
        <>
          <meter
            aria-label={t(`${k}.kpi.occupancy.label`)}
            aria-valuetext={t(`${k}.kpi.occupancy.secondary`, { occupied, reserved, total })}
            className="sr-only"
            max={total}
            min={0}
            value={occupied}
          />
          <div aria-hidden="true" style={{ background: '#fef3c7', borderRadius: 4, height: 10, overflow: 'hidden' }}>
            <span
              style={{
                background: 'var(--color-primary-500, #ffc627)',
                display: 'block',
                height: '100%',
                width: `${(occupied / total) * 100}%`,
              }}
            />
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs" style={muted}>
            <span>{t(`${k}.overview.legend.occupied`, { count: occupied })}</span>
            <span>{t(`${k}.overview.legend.reserved`, { count: reserved })}</span>
            <span>{t(`${k}.overview.legend.free`, { count: total - occupied - reserved })}</span>
          </div>
        </>
      ) : (
        <span className="text-sm" style={muted}>
          {kpi === undefined || kpi.status === 'loading' ? (
            <PendingBar />
          ) : (
            t(`${k}.state.${kpi.status === 'ready' ? 'noData' : kpi.status}`)
          )}
        </span>
      )}
    </div>
  );
};

const HeroStat = ({ label, tone, value }: { readonly label: string; readonly tone: Tone; readonly value: number }) => {
  const colors = toneColors(tone);
  return (
    <span
      className="inline-flex items-baseline gap-2 rounded-lg px-3 py-2"
      style={{ background: colors.bg, color: 'var(--color-fg-primary, #111827)' }}
    >
      <span className="text-xl font-semibold tabular-nums">{formatNumber(value)}</span>
      <span className="text-xs font-medium">{label}</span>
    </span>
  );
};

export const SourceHealth = ({ sources }: { readonly sources: RentalOverviewSources }) => {
  const { lang, t } = useLang();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" style={muted}>
      <span className="font-medium">{t(`${k}.overview.sourcesLabel`)}</span>
      {sourceKeys.map((key) => {
        const source = sources[key];
        const when = source.loadedAt === undefined ? '' : ` · ${fmt.clock(lang, source.loadedAt)}`;
        const sourceLabel = t(`${k}.sources.${key}`);
        const stateLabel = t(`${k}.state.${source.status}`);
        return (
          <fieldset
            aria-label={`${sourceLabel}: ${stateLabel}${when}`}
            className="inline-flex items-center gap-1"
            data-source={key}
            data-status={source.status}
            key={key}
            style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}
          >
            <Dot tone={statusTone[source.status]} />
            {sourceLabel}
            {source.status === 'ready' || source.status === 'loading' ? '' : ` (${stateLabel})`}
          </fieldset>
        );
      })}
    </div>
  );
};

export const Hero = ({
  deadlines,
  displayName,
  kpis,
  onQuery,
  query,
  sources,
  today,
  unread,
}: {
  readonly deadlines: readonly Deadline[];
  readonly displayName: string | undefined;
  readonly kpis: readonly Kpi[];
  readonly onQuery: (value: string) => void;
  readonly query: string;
  readonly sources: RentalOverviewSources;
  readonly today: string;
  readonly unread: number;
}) => {
  const { lang, t } = useLang();
  const personalName = personalGreetingName(displayName);
  const hour = browserRuntime.runSync(DateTime.now).pipe(DateTime.formatIntl(pragueHourFormat), Number);
  const greeting = greetingForHour(hour);
  const open = deadlines.filter((row) => !row.done);
  const todayCount = open.filter((row) => row.date === today).length;
  const overdue = open.filter((row) => row.date < today && daysUntil(row.date, today) >= -60).length;
  const week = open.filter((row) => row.date >= today && daysUntil(row.date, today) <= 7).length;
  return (
    <section
      className="grid grid-cols-1 gap-6 rounded-lg p-6 facilityoperations:lg:grid-cols-[minmax(0,1fr)_auto]"
      style={{
        background:
          'radial-gradient(1200px 300px at 0% 0%, var(--color-primary-100, #fef3c7) 0%, transparent 60%), linear-gradient(135deg, #ffffff 0%, var(--color-surface-subtle, #f8fafc) 100%)',
      }}
    >
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide" style={muted}>
            {fmt.long(lang, today)}
          </span>
          <h2 className="m-0 text-2xl font-semibold">
            {t(`${k}.overview.greeting.${greeting}`)}
            {personalName === undefined ? '' : `, ${personalName}`}
          </h2>
          <p className="m-0 text-sm" style={muted}>
            {t(`${k}.overview.summary`, { overdue, today: todayCount, unread, week })}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <HeroStat label={t(`${k}.overview.todayLabel`)} tone="primary" value={todayCount} />
          <HeroStat label={t(`${k}.overview.weekLabel`)} tone="info" value={week} />
          <HeroStat label={t(`${k}.overview.overdueLabel`)} tone={overdue > 0 ? 'danger' : 'success'} value={overdue} />
          <a className="no-underline" href={`/${lang}/provoz/agenda?tab=notifikace`} style={{ color: 'inherit' }}>
            <HeroStat label={t(`${k}.overview.unreadLabel`)} tone={unread > 0 ? 'warning' : 'neutral'} value={unread} />
          </a>
        </div>
        <label className="relative block max-w-2xl">
          <span className="sr-only">{t(`${k}.search.label`)}</span>
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" style={muted}>
            <Icon name="magnify" size={20} />
          </span>
          <input
            className="w-full rounded-lg py-3 pl-10 pr-3 text-base facilityoperations:outline-none"
            id="ops-global-search"
            onChange={(event) => onQuery(event.target.value)}
            placeholder={t(`${k}.search.placeholder`)}
            style={{
              background: '#ffffff',
              border: '1px solid var(--color-border-primary, #d1d5db)',
              boxShadow: '0 1px 2px rgba(0,0,0,.04)',
            }}
            type="search"
            value={query}
          />
        </label>
        <SourceHealth sources={sources} />
      </div>
      <div className="flex items-center justify-center">
        <OccupancyFigure kpi={kpis.find((kpi) => kpi.id === 'occupancy')} />
      </div>
    </section>
  );
};

// ---- KPI grid ------------------------------------------------------------------------------------------------------

const kpiIcon = {
  contracts: 'timer',
  deadlines: 'calendar',
  incidents: 'shield',
  leases: 'contract',
  occupancy: 'key',
  openTasks: 'tasks',
  overdueInvoices: 'invoice',
  planActual: 'clipboard',
  properties: 'building',
  salesCases: 'contract',
} satisfies Record<KpiId, IconName>;

const secondaryValues = (kpi: Kpi) => {
  const values = { ...kpi.secondary };
  return Match.value(values['amountMinor']).pipe(
    Match.when(Match.number, (amountMinor) => ({ ...values, amount: formatMoney(amountMinor) })),
    Match.orElse(() => values),
  );
};

const kpiStateIcon = {
  forbidden: 'lock',
  noData: 'info',
  unavailable: 'alert',
} satisfies Record<Exclude<Kpi['status'], 'loading' | 'ready'> | 'noData', IconName>;

const KpiValue = ({ kpi }: { readonly kpi: Kpi }) => {
  const { t } = useLang();
  if (kpi.status === 'loading') {
    return (
      <output
        aria-label={t('facility-operations.common.loading')}
        className="block h-9 w-24 animate-pulse rounded-lg"
        style={{ background: trackBackground }}
      />
    );
  }
  if (kpi.status !== 'ready' || kpi.value === undefined) {
    const state = kpi.status === 'ready' ? 'noData' : kpi.status;
    return (
      <span className="inline-flex items-center gap-2 text-lg font-semibold" style={muted}>
        <Icon name={kpiStateIcon[state]} size={18} />
        {t(`${k}.state.${state}`)}
      </span>
    );
  }
  return (
    <span className="text-4xl font-semibold leading-none">
      {kpi.kind === 'percent' ? formatPercent(kpi.value) : formatNumber(kpi.value)}
    </span>
  );
};

export const KpiGrid = ({
  kpis,
  onSelect,
  selected,
  settled,
}: {
  readonly kpis: readonly Kpi[];
  readonly onSelect: (id: KpiId) => void;
  readonly selected: KpiId | undefined;
  readonly settled: boolean;
}) => {
  const { lang, t } = useLang();
  return (
    <section
      aria-busy={!settled}
      aria-label={t(`${k}.overview.kpiSection`)}
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
    >
      {kpis.map((kpi) => {
        const colors = toneColors(kpi.tone);
        const active = kpi.id === selected;
        const ready = kpi.status === 'ready' && kpi.value !== undefined;
        return (
          <button
            aria-describedby={`kpi-${kpi.id}-definition`}
            aria-pressed={active}
            className="flex facilityoperations:min-h-[184px] cursor-pointer flex-col gap-3 rounded-lg p-4 text-left facilityoperations:transition-shadow facilityoperations:hover:shadow-lg"
            data-kpi={kpi.id}
            data-value={ready ? String(kpi.value) : kpi.status}
            key={kpi.id}
            onClick={() => onSelect(kpi.id)}
            style={{
              ...card,
              borderColor: active ? colors.accent : 'transparent',
              boxShadow: active ? `0 0 0 3px ${colors.ring}` : 'none',
              color: 'inherit',
              font: 'inherit',
            }}
            type="button"
          >
            <span hidden id={`kpi-${kpi.id}-definition`}>
              {t(`${k}.kpi.${kpi.id}.definition`)}
            </span>
            <div className="flex items-start justify-between gap-2">
              <IconBadge name={kpiIcon[kpi.id]} tone={ready ? kpi.tone : 'neutral'} />
              <span
                className="inline-flex items-center gap-1 text-xs font-medium"
                style={{ color: 'var(--color-fg-secondary, #4b5563)' }}
              >
                {t(`${k}.overview.drill`)}
                <Icon name="arrowRight" size={14} />
              </span>
            </div>
            <span className="text-sm font-medium" style={muted}>
              {t(`${k}.kpi.${kpi.id}.label`)}
            </span>
            <KpiValue kpi={kpi} />
            {kpi.kind === 'percent' && ready && (
              <span className="block h-1.5 w-full overflow-hidden rounded-full" style={{ background: trackBackground }}>
                <span
                  className="block h-full rounded-full"
                  style={{ background: colors.accent, width: `${Math.round((kpi.value ?? 0) * 100)}%` }}
                />
              </span>
            )}
            {ready && kpi.secondary !== undefined && (
              <span className="text-sm">{t(`${k}.kpi.${kpi.id}.secondary`, secondaryValues(kpi))}</span>
            )}
            <span className="mt-auto facilityoperations:text-[11px] leading-snug" style={muted}>
              {t(`${k}.overview.sourceLine`, {
                sources: kpi.sources.map((source) => t(`${k}.sources.${source}`)).join(', ') || '—',
                time: kpi.loadedAt === undefined ? '—' : fmt.clock(lang, kpi.loadedAt),
              })}
            </span>
          </button>
        );
      })}
    </section>
  );
};

// ---- Drill-down ----------------------------------------------------------------------------------------------------

const statusLabel = (t: (key: string) => string, status: string | undefined) =>
  status === undefined ? '' : t(`${k}.status.${status}`);

const RecordTable = ({ rows }: { readonly rows: readonly DrillRow[] }) => {
  const { lang, t } = useLang();
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm" data-testid="ops-drill-table">
        <thead>
          <tr className="text-left" style={muted}>
            <th className="px-3 py-2 font-medium">{t(`${k}.columns.title`)}</th>
            <th className="px-3 py-2 font-medium">{t(`${k}.columns.date`)}</th>
            <th className="px-3 py-2 font-medium">{t(`${k}.columns.status`)}</th>
            <th className="px-3 py-2 text-right font-medium">{t(`${k}.columns.amount`)}</th>
            <th className="px-3 py-2">
              <span className="sr-only">{t(`${k}.columns.link`)}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} style={{ borderTop: '1px solid var(--color-border-muted, #f1f5f9)' }}>
              <td className="px-3 py-2.5">
                <div className="font-medium">{row.title}</div>
                {row.subtitle !== undefined && row.subtitle !== '' && (
                  <div className="text-xs" style={muted}>
                    {row.subtitle}
                  </div>
                )}
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">
                {row.date === undefined ? '—' : fmt.short(lang, row.date)}
              </td>
              <td className="px-3 py-2.5">
                {row.status === undefined ? (
                  '—'
                ) : (
                  <Pill tone={row.tone ?? 'neutral'}>{statusLabel(t, row.status)}</Pill>
                )}
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">
                {row.amountMinor === undefined ? '' : formatMoney(row.amountMinor)}
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 text-right">
                <a className="inline-flex items-center gap-1 font-medium" href={linkTo(lang, row.href)}>
                  {t(`${k}.open`)}
                  <Icon name="arrowRight" size={14} />
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export const DrillDown = ({
  agendaRevision,
  canLog,
  kpi,
  onClose,
}: {
  readonly agendaRevision: number;
  readonly canLog: boolean;
  readonly kpi: Kpi;
  readonly onClose: () => void;
}) => {
  const { lang, t } = useLang();
  const label = t(`${k}.kpi.${kpi.id}.label`);
  const detail =
    kpi.status === 'ready' ? t(`${k}.overview.records`, { count: kpi.rows.length }) : t(`${k}.state.${kpi.status}`);
  let body: ReactNode;
  if (kpi.status !== 'ready') {
    body = <EmptyState description={t(`${k}.state.${kpi.status}Description`)} title={t(`${k}.state.${kpi.status}`)} />;
  } else if (kpi.rows.length === 0) {
    body = <EmptyState description={t(`${k}.overview.zeroConfirmed`)} title={t(`${k}.overview.noRecords`)} />;
  } else {
    body = <RecordTable rows={kpi.rows} />;
  }
  const csv = () => {
    browserRuntime.runFork(
      DateTime.now.pipe(
        Effect.flatMap((now) =>
          exportCsv({
            fileName: `provoz-${kpi.id}-${now.pipe(DateTime.formatIsoDateUtc)}.csv`,
            filter: `kpi=${kpi.id}`,
            header: [
              t(`${k}.columns.title`),
              t(`${k}.columns.detail`),
              t(`${k}.columns.date`),
              t(`${k}.columns.status`),
              t(`${k}.columns.amount`),
              t(`${k}.columns.link`),
            ],
            list: `overview:${kpi.id}`,
            log: canLog,
            revision: agendaRevision,
            rows: kpi.rows.map((row) => [
              row.title,
              row.subtitle,
              row.date,
              statusLabel(t, row.status),
              row.amountMinor === undefined ? undefined : (row.amountMinor / 100).toFixed(2).replace('.', ','),
              `${window.location.origin}${linkTo(lang, row.href)}`,
            ]),
          }),
        ),
      ),
    );
  };
  return (
    <div id="ops-overview-drilldown" style={{ scrollMarginTop: 16 }}>
      <SectionCard
        actions={
          <>
            {kpi.status === 'ready' && kpi.rows.length > 0 && (
              <Button appearance="outline" onClick={csv} severity="secondary" size="sm">
                {t(`${k}.export.csv`)}
              </Button>
            )}
            <Button appearance="ghost" onClick={onClose} severity="secondary" size="sm">
              {t('facility-operations.common.close')}
            </Button>
          </>
        }
        title={`${label} — ${detail}`}
      >
        <div
          className="flex flex-col gap-1 rounded-lg p-3 text-sm"
          style={{ background: 'var(--color-surface-subtle, #f8fafc)' }}
        >
          <span>
            <strong>{t(`${k}.overview.definition`)}:</strong> {t(`${k}.kpi.${kpi.id}.definition`)}
          </span>
          <span style={muted}>
            {t(`${k}.overview.sourceLine`, {
              sources: kpi.sources.map((source) => t(`${k}.sources.${source}`)).join(', ') || '—',
              time: kpi.loadedAt === undefined ? '—' : fmt.stamp(lang, kpi.loadedAt),
            })}
          </span>
        </div>
        {body}
      </SectionCard>
    </div>
  );
};

// ---- Search --------------------------------------------------------------------------------------------------------

const kindTone = {
  asset: 'neutral',
  contract: 'warning',
  event: 'primary',
  invoice: 'info',
  lease: 'success',
  ops: 'neutral',
  party: 'primary',
  property: 'success',
  task: 'primary',
  unit: 'success',
} satisfies Record<SearchKind, Tone>;

export const SearchResults = ({
  agendaRevision,
  canLog,
  index,
  onClear,
  query,
  sources,
}: {
  readonly agendaRevision: number;
  readonly canLog: boolean;
  readonly index: readonly SearchRow[];
  readonly onClear: () => void;
  readonly query: string;
  readonly sources: RentalOverviewSources;
}) => {
  const { lang, t } = useLang();
  const results = searchRows(index, query, 80);
  const hidden = sourceKeys.filter(
    (key) => sources[key].status === 'forbidden' || sources[key].status === 'unavailable',
  );
  const csv = () => {
    browserRuntime.runFork(
      DateTime.now.pipe(
        Effect.flatMap((now) =>
          exportCsv({
            fileName: `provoz-hledani-${now.pipe(DateTime.formatIsoDateUtc)}.csv`,
            filter: `q=${query}`,
            header: [
              t(`${k}.columns.type`),
              t(`${k}.columns.title`),
              t(`${k}.columns.detail`),
              t(`${k}.columns.source`),
              t(`${k}.columns.link`),
            ],
            list: 'search',
            log: canLog,
            revision: agendaRevision,
            rows: results.map((row) => [
              t(`${k}.search.kind.${row.kind}`),
              row.title,
              row.subtitle,
              t(`${k}.sources.${row.source}`),
              `${window.location.origin}${linkTo(lang, row.href)}`,
            ]),
          }),
        ),
      ),
    );
  };
  return (
    <SectionCard
      actions={
        <>
          {results.length > 0 && (
            <Button appearance="outline" onClick={csv} severity="secondary" size="sm">
              {t(`${k}.export.csv`)}
            </Button>
          )}
          <Button appearance="ghost" onClick={onClear} severity="secondary" size="sm">
            {t(`${k}.search.clear`)}
          </Button>
        </>
      }
      title={t(`${k}.search.results`, { count: results.length, query: query.trim() })}
    >
      <p className="m-0 text-xs" style={muted}>
        {t(`${k}.search.scope`, { count: index.length })}
        {hidden.length > 0 && ' '}
        {hidden.length > 0 &&
          t(`${k}.search.hidden`, { sources: hidden.map((key) => t(`${k}.sources.${key}`)).join(', ') })}
      </p>
      {results.length === 0 ? (
        <EmptyState description={t(`${k}.search.emptyDescription`)} title={t(`${k}.search.empty`)} />
      ) : (
        <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0 md:grid-cols-2" data-testid="ops-search-results">
          {results.map((row) => (
            <li key={`${row.kind}:${row.id}`}>
              <a
                className="flex items-center gap-3 rounded-lg p-3 no-underline transition-colors facilityoperations:hover:shadow-md"
                href={linkTo(lang, row.href)}
                style={{ ...card, color: 'inherit' }}
              >
                <Pill tone={kindTone[row.kind]}>{t(`${k}.search.kind.${row.kind}`)}</Pill>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{row.title}</span>
                  {row.subtitle !== undefined && (
                    <span className="truncate text-xs" style={muted}>
                      {row.subtitle}
                    </span>
                  )}
                </span>
                <span className="ml-auto" style={muted}>
                  <Icon name="chevronRight" size={18} />
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
};

// ---- Upcoming timeline ---------------------------------------------------------------------------------------------

export const UpcomingTimeline = ({
  deadlines,
  sources,
  today,
}: {
  readonly deadlines: readonly Deadline[];
  readonly sources: RentalOverviewSources;
  readonly today: string;
}) => {
  const { lang, t } = useLang();
  const [showAll, setShowAll] = useState(false);
  const overdue = deadlines.filter((row) => !row.done && row.date < today && daysUntil(row.date, today) >= -60);
  const upcoming = deadlines.filter((row) => !row.done && row.date >= today);
  const visible = upcoming.slice(0, showAll ? 24 : 8);
  const groups = new Map<string, Deadline[]>();
  for (const row of visible) {
    groups.set(row.date, [...(groups.get(row.date) ?? []), row]);
  }
  const missing = sourceKeys.filter(
    (key) => key !== 'parties' && sources[key].status !== 'ready' && sources[key].status !== 'loading',
  );
  return (
    <SectionCard
      actions={
        <a className="inline-flex items-center gap-1 text-sm font-medium" href={`/${lang}/provoz/agenda`}>
          {t(`${k}.overview.fullCalendar`)}
          <Icon name="arrowRight" size={14} />
        </a>
      }
      title={t(`${k}.overview.upcomingTitle`)}
    >
      {overdue.length > 0 && (
        <a
          className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium no-underline"
          href={`/${lang}/provoz/agenda?view=seznam&filtr=po-terminu`}
          style={{ background: toneColors('danger').bg, color: toneColors('danger').fg }}
        >
          <Icon name="alert" size={18} />
          {t(`${k}.overview.overdueBanner`, { count: overdue.length })}
        </a>
      )}
      {visible.length === 0 ? (
        <EmptyState description={t(`${k}.overview.noUpcomingDescription`)} title={t(`${k}.overview.noUpcoming`)} />
      ) : (
        <ol className="m-0 flex list-none flex-col gap-3 p-0">
          {[...groups.entries()].map(([date, rows]) => {
            const urgency = urgencyOf({ date, done: false }, today);
            const tone = urgencyTone[urgency];
            const days = daysUntil(date, today);
            return (
              <li className="flex gap-3" key={date}>
                <div
                  className="flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-lg"
                  style={{ background: toneColors(tone).bg, color: toneColors(tone).fg }}
                >
                  <span className="text-lg font-semibold leading-none">{Number(date.slice(8, 10))}</span>
                  <span className="facilityoperations:text-[11px] uppercase">{fmt.weekday(lang, date)}</span>
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className="text-xs font-medium" style={muted}>
                    {fmt.dayMonth(lang, date)} ·{' '}
                    {days === 0 ? t(`${k}.relative.today`) : t(`${k}.relative.inDays`, { count: days })}
                  </span>
                  {rows.map((row) => (
                    <a
                      className="flex items-center gap-2 rounded-lg px-2 py-1.5 no-underline facilityoperations:hover:shadow-sm"
                      href={linkTo(lang, row.href)}
                      key={row.key}
                      style={{ background: 'var(--color-surface-subtle, #f8fafc)', color: 'inherit' }}
                    >
                      <Pill tone={categoryTone[row.category]}>{t(`${k}.category.${row.category}`)}</Pill>
                      <span className="truncate text-sm font-medium">{row.title}</span>
                      {row.location !== undefined && (
                        <span className="hidden truncate text-xs md:inline" style={muted}>
                          {row.location}
                        </span>
                      )}
                    </a>
                  ))}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {upcoming.length > 8 && (
        <Button appearance="ghost" onClick={() => setShowAll((value) => !value)} severity="secondary" size="sm">
          {showAll
            ? t(`${k}.overview.showLess`)
            : t(`${k}.overview.showMore`, { count: Math.min(upcoming.length, 24) - 8 })}
        </Button>
      )}
      {missing.length > 0 && (
        <p className="m-0 text-xs" style={muted}>
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
    </SectionCard>
  );
};

// ---- Occupancy by building -------------------------------------------------------------------------------------------

export const OccupancyByBuilding = ({
  sources,
  today,
}: {
  readonly sources: RentalOverviewSources;
  readonly today: string;
}) => {
  const { lang, t } = useLang();
  const property = sources.property.data;
  const occupancy = sources.occupancy.data;
  let body: ReactNode;
  if (property === undefined || occupancy === undefined) {
    const status = sources.property.status === 'ready' ? sources.occupancy.status : sources.property.status;
    body =
      status === 'loading' ? (
        <LoadingSkeleton rows={3} />
      ) : (
        <EmptyState description={t(`${k}.state.${status}Description`)} title={t(`${k}.state.${status}`)} />
      );
  } else {
    const buildings = property.properties.flatMap((entry) => {
      if (entry.lifecycleState !== 'ACTIVE') {
        return [];
      }
      const units = property.units.filter(
        (unit) => unit.propertyRef.resourceId === entry.propertyRef.resourceId && unit.lifecycleState === 'ACTIVE',
      );
      const states = units.map((unit) => unitAvailability(unit.unitRef.resourceId, occupancy.occupancies, today));
      return [
        {
          code: entry.code,
          free: states.filter((state) => state === 'AVAILABLE').length,
          id: entry.propertyRef.resourceId,
          name: entry.name,
          occupied: states.filter((state) => state === 'OCCUPIED').length,
          reserved: states.filter((state) => state === 'RESERVED').length,
          total: units.length,
        },
      ];
    });
    body =
      buildings.length === 0 ? (
        <EmptyState description={t(`${k}.overview.noBuildingsDescription`)} title={t(`${k}.state.noData`)} />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-4 p-0">
          {buildings.map((building) => (
            <li className="flex flex-col gap-1.5" key={building.id}>
              <div className="flex items-baseline justify-between gap-2">
                <a className="truncate font-medium" href={`/${lang}/nemovitosti?resourceId=${building.id}`}>
                  {building.name}
                </a>
                <span className="text-sm tabular-nums" style={muted}>
                  {building.total === 0
                    ? t(`${k}.state.noData`)
                    : `${formatPercent(building.occupied / building.total)} · ${building.occupied}/${building.total}`}
                </span>
              </div>
              <div className="flex h-3 w-full overflow-hidden rounded-full" style={{ background: trackBackground }}>
                {building.total > 0 && (
                  <>
                    <span
                      style={{
                        background: toneColors('primary').accent,
                        width: `${(building.occupied / building.total) * 100}%`,
                      }}
                    />
                    <span
                      style={{
                        background: toneColors('warning').accent,
                        width: `${(building.reserved / building.total) * 100}%`,
                      }}
                    />
                  </>
                )}
              </div>
              <span className="text-xs" style={muted}>
                {t(`${k}.overview.buildingLine`, {
                  free: building.free,
                  occupied: building.occupied,
                  reserved: building.reserved,
                })}
              </span>
            </li>
          ))}
        </ul>
      );
  }
  return <SectionCard title={t(`${k}.overview.byBuilding`)}>{body}</SectionCard>;
};

// ---- Provoz agendas ----------------------------------------------------------------------------------------------

const agendaIcon = {
  agenda: 'calendar',
  assets: 'building',
  documents: 'contract',
  meters: 'timer',
  purchasing: 'clipboard',
  security: 'shield',
} satisfies Record<(typeof agendaIds)[number], IconName>;

export const OpsAgendas = ({ sources }: { readonly sources: RentalOverviewSources }) => {
  const { lang, t } = useLang();
  const { ops } = sources;
  return (
    <SectionCard title={t(`${k}.overview.opsTitle`)}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {agendaIds.map((agenda) => {
          const envelope = ops.data?.agendas.find((entry) => entry.agenda === agenda);
          const locked = ops.status === 'ready' && envelope === undefined;
          let summary: ReactNode;
          if (ops.status === 'loading') {
            summary = <PendingBar />;
          } else if (locked || ops.status === 'forbidden') {
            summary = t(`${k}.state.forbidden`);
          } else if (envelope === undefined) {
            summary = t(`${k}.state.unavailable`);
          } else if (envelope.revision === 0 && envelope.records === 0) {
            summary = t(`${k}.state.noData`);
          } else {
            summary = t(`${k}.overview.records`, { count: envelope.records });
          }
          return (
            <a
              className="flex flex-col gap-2 rounded-lg p-3 no-underline facilityoperations:hover:shadow-md"
              data-agenda={agenda}
              href={`/${lang}/provoz/${opsSegments[agenda] ?? agenda}`}
              key={agenda}
              style={{ ...card, color: 'inherit', opacity: locked ? 0.7 : 1 }}
            >
              <IconBadge
                name={locked ? 'lock' : (agendaIcon[agenda] ?? 'clipboard')}
                size={34}
                tone={locked ? 'neutral' : 'primary'}
              />
              <span className="text-sm font-medium">{t(`facility-operations.${agenda}.title`)}</span>
              <span className="text-xs" style={muted}>
                {summary}
              </span>
            </a>
          );
        })}
      </div>
    </SectionCard>
  );
};
