import { browserAtomRuntime, browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
// Building blocks of the Nájempark overview dashboard (S15). Owned by the ops-agenda lane.
import { EmptyState, SectionCard, formatMoney, formatNumber, formatPercent } from '@app/admin-ui';
import { BareTextField, FormBuilder, FormReact, FormRoot, useAtomSet } from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Label } from '@techsio/ui-kit/atoms/label';
import { Link } from '@techsio/ui-kit/atoms/link';
import { Meter } from '@techsio/ui-kit/atoms/meter';
import { useState } from 'react';
import { DateTime, Effect, Match, Schema } from 'effect';
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
import { useFormValues } from '../../../../ui/form-values.tsx';
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
const card = 'border border-transparent bg-surface';

/** The overview's global search: what it holds is searched for at once (`SearchResults`) and is never submitted. */
const overviewSearchForm = FormReact.make(FormBuilder.empty.addField('query', Schema.String), {
  fields: { query: BareTextField },
  onSubmit: () => Effect.void,
  runtime: browserAtomRuntime,
});
const noOverviewSearch = { query: '' };
const overviewQuery = overviewSearchForm.getFieldAtoms(overviewSearchForm.fields.query);

/** The search text of the overview; render `ready` as `Hero`'s `searchReady`. */
export const useOverviewSearch = () => {
  const { ready, values } = useFormValues(overviewSearchForm, noOverviewSearch);
  const setQuery = useAtomSet(overviewQuery.setValue);
  return {
    clear: () => {
      setQuery('');
    },
    query: values.query,
    ready,
  };
};

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
    <span className="inline-block h-3 w-16 animate-pulse rounded bg-skeleton-bg-primary">
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
    <div className="flex w-full max-w-75 flex-col gap-3">
      <span className="text-sm font-medium text-fg-secondary">{t(`${k}.overview.occupiedToday`)}</span>
      <strong className="font-semibold text-[3.5rem] leading-[1.1] tracking-[-0.04em]">
        {ready ? formatPercent(kpi.value ?? 0) : '—'}
      </strong>
      {ready ? (
        <>
          <Meter
            aria-label={t(`${k}.kpi.occupancy.label`)}
            aria-valuetext={t(`${k}.kpi.occupancy.secondary`, { occupied, reserved, total })}
            max={total}
            size="md"
            value={occupied}
          />
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-secondary">
            <span>{t(`${k}.overview.legend.occupied`, { count: occupied })}</span>
            <span>{t(`${k}.overview.legend.reserved`, { count: reserved })}</span>
            <span>{t(`${k}.overview.legend.free`, { count: total - occupied - reserved })}</span>
          </div>
        </>
      ) : (
        <span className="text-sm text-fg-secondary">
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

const HeroStat = ({ label, tone, value }: { readonly label: string; readonly tone: Tone; readonly value: number }) => (
  <span className={`inline-flex items-baseline gap-2 rounded-lg px-3 py-2 text-fg-primary ${toneColors(tone).tint}`}>
    <span className="text-xl font-semibold tabular-nums">{formatNumber(value)}</span>
    <span className="text-xs font-medium">{label}</span>
  </span>
);

export const SourceHealth = ({ sources }: { readonly sources: RentalOverviewSources }) => {
  const { lang, t } = useLang();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-secondary">
      <span className="font-medium">{t(`${k}.overview.sourcesLabel`)}</span>
      {sourceKeys.map((key) => {
        const source = sources[key];
        const when = source.loadedAt === undefined ? '' : ` · ${fmt.clock(lang, source.loadedAt)}`;
        const sourceLabel = t(`${k}.sources.${key}`);
        const stateLabel = t(`${k}.state.${source.status}`);
        return (
          <fieldset
            aria-label={`${sourceLabel}: ${stateLabel}${when}`}
            className="m-0 inline-flex min-w-0 items-center gap-1 border-0 p-0"
            data-source={key}
            data-status={source.status}
            key={key}
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
  searchReady,
  sources,
  today,
  unread,
}: {
  readonly deadlines: readonly Deadline[];
  readonly displayName: string | undefined;
  readonly kpis: readonly Kpi[];
  /** `useOverviewSearch().ready` of the page that reads the search. */
  readonly searchReady: ReactNode;
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
    <section className="grid grid-cols-1 gap-6 rounded-lg bg-surface p-6 lg:grid-cols-[minmax(0,1fr)_auto]">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-fg-secondary">{fmt.long(lang, today)}</span>
          <h2 className="m-0 text-2xl font-semibold">
            {t(`${k}.overview.greeting.${greeting}`)}
            {personalName === undefined ? '' : `, ${personalName}`}
          </h2>
          <p className="m-0 text-sm text-fg-secondary">
            {t(`${k}.overview.summary`, { overdue, today: todayCount, unread, week })}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <HeroStat label={t(`${k}.overview.todayLabel`)} tone="primary" value={todayCount} />
          <HeroStat label={t(`${k}.overview.weekLabel`)} tone="info" value={week} />
          <HeroStat label={t(`${k}.overview.overdueLabel`)} tone={overdue > 0 ? 'danger' : 'success'} value={overdue} />
          <Link className="text-inherit no-underline" href={`/${lang}/provoz/agenda?tab=notifikace`} size="current">
            <HeroStat label={t(`${k}.overview.unreadLabel`)} tone={unread > 0 ? 'warning' : 'neutral'} value={unread} />
          </Link>
        </div>
        <FormRoot
          className="relative max-w-2xl"
          defaultValues={noOverviewSearch}
          form={overviewSearchForm}
          translateMessage={(message) => t(message)}
        >
          {searchReady}
          <Label className="sr-only" htmlFor="ops-global-search">
            {t(`${k}.search.label`)}
          </Label>
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-secondary">
            <Icon name="magnify" size={20} />
          </span>
          <overviewSearchForm.query
            className="h-auto rounded-lg py-3 pl-10 pr-3"
            id="ops-global-search"
            placeholder={t(`${k}.search.placeholder`)}
            size="sm"
            type="search"
          />
        </FormRoot>
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
        className="block h-9 w-24 animate-pulse rounded-lg bg-skeleton-bg-primary"
      />
    );
  }
  if (kpi.status !== 'ready' || kpi.value === undefined) {
    const state = kpi.status === 'ready' ? 'noData' : kpi.status;
    return (
      <span className="inline-flex items-center gap-2 text-lg font-semibold text-fg-secondary">
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
          <Button
            aria-describedby={`kpi-${kpi.id}-definition`}
            aria-pressed={active}
            className={[
              'flex min-h-[184px] flex-col items-stretch justify-start rounded-lg border bg-surface p-4 text-left text-inherit transition-shadow hover:shadow-lg',
              ...(active ? ['ring-2', colors.border, colors.ring] : ['border-transparent']),
            ].join(' ')}
            composition
            data-kpi={kpi.id}
            data-value={ready ? String(kpi.value) : kpi.status}
            key={kpi.id}
            onClick={() => onSelect(kpi.id)}
            size="current"
            unstyled
          >
            <span className="flex flex-1 flex-col gap-3">
              <span hidden id={`kpi-${kpi.id}-definition`}>
                {t(`${k}.kpi.${kpi.id}.definition`)}
              </span>
              <div className="flex items-start justify-between gap-2">
                <IconBadge name={kpiIcon[kpi.id]} tone={ready ? kpi.tone : 'neutral'} />
                <span className="inline-flex items-center gap-1 text-xs font-medium text-fg-secondary">
                  {t(`${k}.overview.drill`)}
                  <Icon name="arrowRight" size={14} />
                </span>
              </div>
              <span className="text-sm font-medium text-fg-secondary">{t(`${k}.kpi.${kpi.id}.label`)}</span>
              <KpiValue kpi={kpi} />
              {kpi.kind === 'percent' && ready && (
                <Meter aria-hidden max={1} severity={kpi.tone} value={kpi.value ?? 0} />
              )}
              {ready && kpi.secondary !== undefined && (
                <span className="text-sm">{t(`${k}.kpi.${kpi.id}.secondary`, secondaryValues(kpi))}</span>
              )}
              <span className="mt-auto text-[11px] leading-snug text-fg-secondary">
                {t(`${k}.overview.sourceLine`, {
                  sources: kpi.sources.map((source) => t(`${k}.sources.${source}`)).join(', ') || '—',
                  time: kpi.loadedAt === undefined ? '—' : fmt.clock(lang, kpi.loadedAt),
                })}
              </span>
            </span>
          </Button>
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
          <tr className="text-left text-fg-secondary">
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
            <tr className="border-t border-border-primary/60" key={row.id}>
              <td className="px-3 py-2.5">
                <div className="font-medium">{row.title}</div>
                {row.subtitle !== undefined && row.subtitle !== '' && (
                  <div className="text-xs text-fg-secondary">{row.subtitle}</div>
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
                <Link
                  className="inline-flex items-center gap-1 font-medium text-inherit no-underline"
                  href={linkTo(lang, row.href)}
                  size="current"
                >
                  {t(`${k}.open`)}
                  <Icon name="arrowRight" size={14} />
                </Link>
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
    <div className="scroll-mt-4" id="ops-overview-drilldown">
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
        <div className="flex flex-col gap-1 rounded-lg bg-surface p-3 text-sm">
          <span>
            <strong>{t(`${k}.overview.definition`)}:</strong> {t(`${k}.kpi.${kpi.id}.definition`)}
          </span>
          <span className="text-fg-secondary">
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
      <p className="m-0 text-xs text-fg-secondary">
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
              <Link
                className={`flex items-center gap-3 rounded-lg p-3 text-inherit no-underline transition-colors hover:shadow-md ${card}`}
                href={linkTo(lang, row.href)}
                size="current"
              >
                <Pill tone={kindTone[row.kind]}>{t(`${k}.search.kind.${row.kind}`)}</Pill>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{row.title}</span>
                  {row.subtitle !== undefined && (
                    <span className="truncate text-xs text-fg-secondary">{row.subtitle}</span>
                  )}
                </span>
                <span className="ml-auto text-fg-secondary">
                  <Icon name="chevronRight" size={18} />
                </span>
              </Link>
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
        <Link
          className="inline-flex items-center gap-1 text-sm font-medium text-inherit no-underline"
          href={`/${lang}/provoz/agenda`}
          size="current"
        >
          {t(`${k}.overview.fullCalendar`)}
          <Icon name="arrowRight" size={14} />
        </Link>
      }
      title={t(`${k}.overview.upcomingTitle`)}
    >
      {overdue.length > 0 && (
        <Link
          className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium no-underline ${toneColors('danger').tint} ${toneColors('danger').fg}`}
          href={`/${lang}/provoz/agenda?view=seznam&filtr=po-terminu`}
          size="current"
        >
          <Icon name="alert" size={18} />
          {t(`${k}.overview.overdueBanner`, { count: overdue.length })}
        </Link>
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
                  className={`flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-lg ${toneColors(tone).tint} ${toneColors(tone).fg}`}
                >
                  <span className="text-lg font-semibold leading-none">{Number(date.slice(8, 10))}</span>
                  <span className="text-[11px] uppercase">{fmt.weekday(lang, date)}</span>
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className="text-xs font-medium text-fg-secondary">
                    {fmt.dayMonth(lang, date)} ·{' '}
                    {days === 0 ? t(`${k}.relative.today`) : t(`${k}.relative.inDays`, { count: days })}
                  </span>
                  {rows.map((row) => (
                    <Link
                      className="flex items-center gap-2 rounded-lg bg-surface px-2 py-1.5 text-inherit no-underline hover:shadow-sm"
                      href={linkTo(lang, row.href)}
                      key={row.key}
                      size="current"
                    >
                      <Pill tone={categoryTone[row.category]}>{t(`${k}.category.${row.category}`)}</Pill>
                      <span className="truncate text-sm font-medium">{row.title}</span>
                      {row.location !== undefined && (
                        <span className="hidden truncate text-xs text-fg-secondary md:inline">{row.location}</span>
                      )}
                    </Link>
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
        <p className="m-0 text-xs text-fg-secondary">
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
                <Link
                  className="truncate font-medium text-inherit no-underline"
                  href={`/${lang}/nemovitosti?resourceId=${building.id}`}
                  size="current"
                >
                  {building.name}
                </Link>
                <span className="text-sm tabular-nums text-fg-secondary">
                  {building.total === 0
                    ? t(`${k}.state.noData`)
                    : `${formatPercent(building.occupied / building.total)} · ${building.occupied}/${building.total}`}
                </span>
              </div>
              <Meter
                aria-hidden
                max={building.total}
                segments={[
                  { severity: 'primary', value: building.occupied },
                  { severity: 'warning', value: building.reserved },
                ]}
                size="md"
              />
              <span className="text-xs text-fg-secondary">
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
            <Link
              className={`flex flex-col gap-2 rounded-lg p-3 text-inherit no-underline hover:shadow-md ${card}${locked ? ' opacity-70' : ''}`}
              data-agenda={agenda}
              href={`/${lang}/provoz/${opsSegments[agenda] ?? agenda}`}
              key={agenda}
              size="current"
            >
              <IconBadge
                name={locked ? 'lock' : (agendaIcon[agenda] ?? 'clipboard')}
                size={34}
                tone={locked ? 'neutral' : 'primary'}
              />
              <span className="text-sm font-medium">{t(`facility-operations.${agenda}.title`)}</span>
              <span className="text-xs text-fg-secondary">{summary}</span>
            </Link>
          );
        })}
      </div>
    </SectionCard>
  );
};
