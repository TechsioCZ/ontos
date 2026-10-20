// @effect-diagnostics asyncFunction:off globalDate:off
// Building blocks of the Siampark overview dashboard (S15). Owned by the ops-agenda lane.
import { EmptyState, SectionCard, formatMoney, formatNumber, formatPercent } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { agendaIds } from '../../../../../../shared/agendas.ts';
import { daysUntil, opsSegments, urgencyOf } from '../../../../../ui/ops-agenda/deadlines.ts';
import type { Deadline } from '../../../../../ui/ops-agenda/deadlines.ts';
import { searchRows, unitAvailability } from '../../../../../ui/ops-agenda/model.ts';
import type { DrillRow, Kpi, KpiId, SearchKind, SearchRow, Tone } from '../../../../../ui/ops-agenda/model.ts';
import { personaOf } from '../../../../../ui/ops-agenda/personas.ts';
import { sourceKeys } from '../../../../../ui/ops-agenda/sources.ts';
import type { SiamparkSources } from '../../../../../ui/ops-agenda/sources.ts';
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
} from '../../../../../ui/ops-agenda/ui-bits.tsx';
import type { IconName } from '../../../../../ui/ops-agenda/ui-bits.tsx';

const k = 'siampark-ops.agenda';
const muted = { color: 'var(--color-fg-secondary, #6b7280)' } as const;
const card = {
  background: '#ffffff',
  border: '1px solid var(--color-border-primary, #e5e7eb)',
} as const;

const useLang = () => {
  const { language, t } = useModernI18n();
  return { lang: langOf(language), t };
};

const linkTo = (lang: string, href: string) => `/${lang}${href}`;

// ---- Hero ----------------------------------------------------------------------------------------------------------

const pragueHour = () =>
  Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Europe/Prague' }).format(new Date()));

const OccupancyFigure = ({ kpi }: { readonly kpi: Kpi | undefined }) => {
  const { t } = useLang();
  const total = Number(kpi?.secondary?.['total'] ?? 0);
  const occupied = Number(kpi?.secondary?.['occupied'] ?? 0);
  const reserved = Number(kpi?.secondary?.['reserved'] ?? 0);
  const ready = kpi?.status === 'ready' && kpi.value !== undefined && total > 0;
  return (
    <div className="siamparkops:flex siamparkops:w-full siamparkops:flex-col siamparkops:gap-3" style={{ maxWidth: 300 }}>
      <span className="siamparkops:text-sm siamparkops:font-medium" style={muted}>{t(`${k}.overview.occupiedToday`)}</span>
      <strong style={{ fontSize: 56, fontWeight: 600, letterSpacing: '-0.04em', lineHeight: 1.1 }}>
        {ready ? formatPercent(kpi.value ?? 0) : '—'}
      </strong>
      {ready ? (
        <>
          <div
            aria-label={t(`${k}.kpi.occupancy.label`)}
            aria-valuemax={total}
            aria-valuemin={0}
            aria-valuenow={occupied}
            aria-valuetext={t(`${k}.kpi.occupancy.secondary`, { occupied, total, reserved })}
            role="meter"
            style={{ background: '#fef3c7', borderRadius: 4, height: 10, overflow: 'hidden' }}
          >
            <span style={{ background: 'var(--color-primary-500, #ffc627)', display: 'block', height: '100%', width: `${(occupied / total) * 100}%` }} />
          </div>
          <div className="siamparkops:flex siamparkops:flex-wrap siamparkops:gap-x-4 siamparkops:gap-y-1 siamparkops:text-xs" style={muted}>
            <span>{t(`${k}.overview.legend.occupied`, { count: occupied })}</span>
            <span>{t(`${k}.overview.legend.reserved`, { count: reserved })}</span>
            <span>{t(`${k}.overview.legend.free`, { count: total - occupied - reserved })}</span>
          </div>
        </>
      ) : (
        <span className="siamparkops:text-sm" style={muted}>
          {kpi === undefined || kpi.status === 'loading' ? t('siampark-ops.common.loading') : t(`${k}.state.${kpi.status === 'ready' ? 'noData' : kpi.status}`)}
        </span>
      )}
    </div>
  );
};

export const Hero = ({
  deadlines,
  kpis,
  me,
  onQuery,
  query,
  sources,
  today,
  unread,
}: {
  readonly deadlines: readonly Deadline[];
  readonly kpis: readonly Kpi[];
  readonly me: string | undefined;
  readonly onQuery: (value: string) => void;
  readonly query: string;
  readonly sources: SiamparkSources;
  readonly today: string;
  readonly unread: number;
}) => {
  const { lang, t } = useLang();
  const hour = pragueHour();
  const greeting = hour < 10 ? 'morning' : hour < 18 ? 'day' : 'evening';
  const persona = personaOf(me);
  const open = deadlines.filter((row) => !row.done);
  const todayCount = open.filter((row) => row.date === today).length;
  const overdue = open.filter((row) => row.date < today && daysUntil(row.date, today) >= -60).length;
  const week = open.filter((row) => row.date >= today && daysUntil(row.date, today) <= 7).length;
  return (
    <section
      className="siamparkops:grid siamparkops:grid-cols-1 siamparkops:gap-6 siamparkops:rounded-2xl siamparkops:p-6 siamparkops:lg:grid-cols-[minmax(0,1fr)_auto]"
      style={{
        background:
          'radial-gradient(1200px 300px at 0% 0%, var(--color-primary-100, #fef3c7) 0%, transparent 60%), linear-gradient(135deg, #ffffff 0%, var(--color-surface-subtle, #f8fafc) 100%)',
        border: '1px solid var(--color-border-primary, #e5e7eb)',
      }}
    >
      <div className="siamparkops:flex siamparkops:min-w-0 siamparkops:flex-col siamparkops:gap-4">
        <div className="siamparkops:flex siamparkops:flex-col siamparkops:gap-1">
          <span className="siamparkops:text-xs siamparkops:font-medium siamparkops:uppercase siamparkops:tracking-wider" style={muted}>
            Siampark · {fmt.long(lang, today)}
          </span>
          <h2 className="siamparkops:m-0 siamparkops:text-2xl siamparkops:font-semibold">
            {t(`${k}.overview.greeting.${greeting}`)}
            {persona === undefined ? '' : `, ${t(`${k}.personas.${persona.role}`)}`}
          </h2>
          <p className="siamparkops:m-0 siamparkops:text-sm" style={muted}>
            {t(`${k}.overview.summary`, { overdue, today: todayCount, unread, week })}
          </p>
        </div>
        <div className="siamparkops:flex siamparkops:flex-wrap siamparkops:gap-2">
          <HeroStat label={t(`${k}.overview.todayLabel`)} tone="primary" value={todayCount} />
          <HeroStat label={t(`${k}.overview.weekLabel`)} tone="info" value={week} />
          <HeroStat label={t(`${k}.overview.overdueLabel`)} tone={overdue > 0 ? 'danger' : 'success'} value={overdue} />
          <a className="siamparkops:no-underline" href={`/${lang}/siampark/provoz/agenda?tab=notifikace`} style={{ color: 'inherit' }}>
            <HeroStat label={t(`${k}.overview.unreadLabel`)} tone={unread > 0 ? 'warning' : 'neutral'} value={unread} />
          </a>
        </div>
        <label className="siamparkops:relative siamparkops:block siamparkops:max-w-2xl">
          <span className="siamparkops:sr-only">{t(`${k}.search.label`)}</span>
          <span className="siamparkops:pointer-events-none siamparkops:absolute siamparkops:left-3 siamparkops:top-1/2 siamparkops:-translate-y-1/2" style={muted}>
            <Icon name="magnify" size={20} />
          </span>
          <input
            className="siamparkops:w-full siamparkops:rounded-xl siamparkops:py-3 siamparkops:pl-10 siamparkops:pr-3 siamparkops:text-base siamparkops:outline-none"
            id="ops-global-search"
            onChange={(event) => onQuery(event.target.value)}
            placeholder={t(`${k}.search.placeholder`)}
            style={{ background: '#ffffff', border: '1px solid var(--color-border-primary, #d1d5db)', boxShadow: '0 1px 2px rgba(0,0,0,.04)' }}
            type="search"
            value={query}
          />
        </label>
        <SourceHealth sources={sources} />
      </div>
      <div className="siamparkops:flex siamparkops:items-center siamparkops:justify-center">
        <OccupancyFigure kpi={kpis.find((kpi) => kpi.id === 'occupancy')} />
      </div>
    </section>
  );
};

const HeroStat = ({ label, tone, value }: { readonly label: string; readonly tone: Tone; readonly value: number }) => {
  const colors = toneColors(tone);
  return (
    <span
      className="siamparkops:inline-flex siamparkops:items-baseline siamparkops:gap-2 siamparkops:rounded-xl siamparkops:px-3 siamparkops:py-2"
      style={{ background: colors.bg, color: 'var(--color-fg-primary, #111827)' }}
    >
      <span className="siamparkops:text-xl siamparkops:font-semibold siamparkops:tabular-nums">{formatNumber(value)}</span>
      <span className="siamparkops:text-xs siamparkops:font-medium">{label}</span>
    </span>
  );
};

export const SourceHealth = ({ sources }: { readonly sources: SiamparkSources }) => {
  const { lang, t } = useLang();
  return (
    <div className="siamparkops:flex siamparkops:flex-wrap siamparkops:items-center siamparkops:gap-x-3 siamparkops:gap-y-1 siamparkops:text-xs" style={muted}>
      <span className="siamparkops:font-medium">{t(`${k}.overview.sourcesLabel`)}</span>
      {sourceKeys.map((key) => {
        const source = sources[key];
        const when = source.loadedAt === undefined ? '' : ` · ${fmt.clock(lang, source.loadedAt)}`;
        return (
          <span
            className="siamparkops:inline-flex siamparkops:items-center siamparkops:gap-1"
            data-source={key}
            data-status={source.status}
            key={key}
            title={`${t(`${k}.sources.${key}`)}: ${t(`${k}.state.${source.status}`)}${when}`}
          >
            <Dot tone={statusTone[source.status]} />
            {t(`${k}.sources.${key}`)}
            {source.status === 'ready' || source.status === 'loading' ? '' : ` (${t(`${k}.state.${source.status}`)})`}
          </span>
        );
      })}
    </div>
  );
};

// ---- KPI grid ------------------------------------------------------------------------------------------------------

const kpiIcon: Record<KpiId, IconName> = {
  contracts: 'timer',
  deadlines: 'calendar',
  incidents: 'shield',
  leases: 'contract',
  occupancy: 'key',
  openTasks: 'tasks',
  overdueInvoices: 'invoice',
  properties: 'building',
};

const secondaryValues = (kpi: Kpi): Record<string, string | number> => {
  const values: Record<string, string | number> = { ...kpi.secondary };
  if (typeof values['amountMinor'] === 'number') {
    values['amount'] = formatMoney(values['amountMinor']);
  }
  return values;
};

const KpiValue = ({ kpi }: { readonly kpi: Kpi }) => {
  const { t } = useLang();
  if (kpi.status === 'loading') {
    return (
      <span
        aria-label={t('siampark-ops.common.loading')}
        className="siamparkops:block siamparkops:h-9 siamparkops:w-24 siamparkops:animate-pulse siamparkops:rounded-lg"
        style={{ background: 'var(--color-neutral-200, #e5e7eb)' }}
      />
    );
  }
  if (kpi.status !== 'ready' || kpi.value === undefined) {
    const state = kpi.status === 'ready' ? 'noData' : kpi.status;
    return (
      <span className="siamparkops:inline-flex siamparkops:items-center siamparkops:gap-2 siamparkops:text-lg siamparkops:font-semibold" style={muted}>
        <Icon name={state === 'forbidden' ? 'lock' : state === 'unavailable' ? 'alert' : 'info'} size={18} />
        {t(`${k}.state.${state}`)}
      </span>
    );
  }
  return (
    <span className="siamparkops:text-4xl siamparkops:font-semibold siamparkops:leading-none">
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
    <section aria-busy={!settled} aria-label={t(`${k}.overview.kpiSection`)} className="siamparkops:grid siamparkops:grid-cols-1 siamparkops:gap-4 siamparkops:sm:grid-cols-2 siamparkops:xl:grid-cols-4">
      {kpis.map((kpi) => {
        const colors = toneColors(kpi.tone);
        const active = kpi.id === selected;
        const ready = kpi.status === 'ready' && kpi.value !== undefined;
        return (
          <button
            aria-pressed={active}
            className="siamparkops:group siamparkops:flex siamparkops:min-h-[184px] siamparkops:cursor-pointer siamparkops:flex-col siamparkops:gap-3 siamparkops:rounded-2xl siamparkops:p-4 siamparkops:text-left siamparkops:transition-shadow siamparkops:hover:shadow-lg"
            data-kpi={kpi.id}
            data-value={ready ? String(kpi.value) : kpi.status}
            key={kpi.id}
            onClick={() => onSelect(kpi.id)}
            style={{
              ...card,
              borderColor: active ? colors.accent : 'var(--color-border-primary, #e5e7eb)',
              boxShadow: active ? `0 0 0 3px ${colors.ring}` : '0 1px 2px rgba(0,0,0,.04)',
              color: 'inherit',
              font: 'inherit',
            }}
            title={t(`${k}.kpi.${kpi.id}.definition`)}
            type="button"
          >
            <div className="siamparkops:flex siamparkops:items-start siamparkops:justify-between siamparkops:gap-2">
              <IconBadge name={kpiIcon[kpi.id]} tone={ready ? kpi.tone : 'neutral'} />
              <span className="siamparkops:inline-flex siamparkops:items-center siamparkops:gap-1 siamparkops:text-xs siamparkops:font-medium" style={{ color: 'var(--color-fg-secondary, #4b5563)' }}>
                {t(`${k}.overview.drill`)}
                <Icon name="arrowRight" size={14} />
              </span>
            </div>
            <span className="siamparkops:text-sm siamparkops:font-medium" style={muted}>
              {t(`${k}.kpi.${kpi.id}.label`)}
            </span>
            <KpiValue kpi={kpi} />
            {kpi.kind === 'percent' && ready && (
              <span className="siamparkops:block siamparkops:h-1.5 siamparkops:w-full siamparkops:overflow-hidden siamparkops:rounded-full" style={{ background: 'var(--color-neutral-200, #e5e7eb)' }}>
                <span className="siamparkops:block siamparkops:h-full siamparkops:rounded-full" style={{ background: colors.accent, width: `${Math.round((kpi.value ?? 0) * 100)}%` }} />
              </span>
            )}
            {ready && kpi.secondary !== undefined && (
              <span className="siamparkops:text-sm">{t(`${k}.kpi.${kpi.id}.secondary`, secondaryValues(kpi))}</span>
            )}
            <span className="siamparkops:mt-auto siamparkops:text-[11px] siamparkops:leading-snug" style={muted}>
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
  const csv = () =>
    void exportCsv({
      fileName: `siampark-${kpi.id}-${new Date().toISOString().slice(0, 10)}.csv`,
      filter: `kpi=${kpi.id}`,
      header: [t(`${k}.columns.title`), t(`${k}.columns.detail`), t(`${k}.columns.date`), t(`${k}.columns.status`), t(`${k}.columns.amount`), t(`${k}.columns.link`)],
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
    });
  return (
    <div id="ops-overview-drilldown" style={{ scrollMarginTop: 16 }}>
      <SectionCard
        actions={
          <>
            {kpi.status === 'ready' && kpi.rows.length > 0 && (
              <Button onClick={csv} size="sm" theme="outlined" variant="secondary">
                {t(`${k}.export.csv`)}
              </Button>
            )}
            <Button onClick={onClose} size="sm" theme="borderless" variant="secondary">
              {t('siampark-ops.common.close')}
            </Button>
          </>
        }
        title={`${label} — ${kpi.status === 'ready' ? t(`${k}.overview.records`, { count: kpi.rows.length }) : t(`${k}.state.${kpi.status}`)}`}
      >
        <div className="siamparkops:flex siamparkops:flex-col siamparkops:gap-1 siamparkops:rounded-xl siamparkops:p-3 siamparkops:text-sm" style={{ background: 'var(--color-surface-subtle, #f8fafc)' }}>
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
        {kpi.status !== 'ready' ? (
          <EmptyState description={t(`${k}.state.${kpi.status}Description`)} title={t(`${k}.state.${kpi.status}`)} />
        ) : kpi.rows.length === 0 ? (
          <EmptyState description={t(`${k}.overview.zeroConfirmed`)} title={t(`${k}.overview.noRecords`)} />
        ) : (
          <RecordTable rows={kpi.rows} />
        )}
      </SectionCard>
    </div>
  );
};

const RecordTable = ({ rows }: { readonly rows: readonly DrillRow[] }) => {
  const { lang, t } = useLang();
  return (
    <div className="siamparkops:overflow-x-auto">
      <table className="siamparkops:w-full siamparkops:border-collapse siamparkops:text-sm" data-testid="ops-drill-table">
        <thead>
          <tr className="siamparkops:text-left" style={muted}>
            <th className="siamparkops:px-3 siamparkops:py-2 siamparkops:font-medium">{t(`${k}.columns.title`)}</th>
            <th className="siamparkops:px-3 siamparkops:py-2 siamparkops:font-medium">{t(`${k}.columns.date`)}</th>
            <th className="siamparkops:px-3 siamparkops:py-2 siamparkops:font-medium">{t(`${k}.columns.status`)}</th>
            <th className="siamparkops:px-3 siamparkops:py-2 siamparkops:text-right siamparkops:font-medium">{t(`${k}.columns.amount`)}</th>
            <th className="siamparkops:px-3 siamparkops:py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} style={{ borderTop: '1px solid var(--color-border-muted, #f1f5f9)' }}>
              <td className="siamparkops:px-3 siamparkops:py-2.5">
                <div className="siamparkops:font-medium">{row.title}</div>
                {row.subtitle !== undefined && row.subtitle !== '' && (
                  <div className="siamparkops:text-xs" style={muted}>
                    {row.subtitle}
                  </div>
                )}
              </td>
              <td className="siamparkops:whitespace-nowrap siamparkops:px-3 siamparkops:py-2.5 siamparkops:tabular-nums">{row.date === undefined ? '—' : fmt.short(lang, row.date)}</td>
              <td className="siamparkops:px-3 siamparkops:py-2.5">{row.status === undefined ? '—' : <Pill tone={row.tone ?? 'neutral'}>{statusLabel(t, row.status)}</Pill>}</td>
              <td className="siamparkops:whitespace-nowrap siamparkops:px-3 siamparkops:py-2.5 siamparkops:text-right siamparkops:tabular-nums">
                {row.amountMinor === undefined ? '' : formatMoney(row.amountMinor)}
              </td>
              <td className="siamparkops:whitespace-nowrap siamparkops:px-3 siamparkops:py-2.5 siamparkops:text-right">
                <a className="siamparkops:inline-flex siamparkops:items-center siamparkops:gap-1 siamparkops:font-medium" href={linkTo(lang, row.href)}>
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

// ---- Search --------------------------------------------------------------------------------------------------------

const kindTone: Record<SearchKind, Tone> = {
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
};

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
  readonly sources: SiamparkSources;
}) => {
  const { lang, t } = useLang();
  const results = useMemo(() => searchRows(index, query, 80), [index, query]);
  const hidden = sourceKeys.filter((key) => sources[key].status === 'forbidden' || sources[key].status === 'unavailable');
  const csv = () =>
    void exportCsv({
      fileName: `siampark-hledani-${new Date().toISOString().slice(0, 10)}.csv`,
      filter: `q=${query}`,
      header: [t(`${k}.columns.type`), t(`${k}.columns.title`), t(`${k}.columns.detail`), t(`${k}.columns.source`), t(`${k}.columns.link`)],
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
    });
  return (
    <SectionCard
      actions={
        <>
          {results.length > 0 && (
            <Button onClick={csv} size="sm" theme="outlined" variant="secondary">
              {t(`${k}.export.csv`)}
            </Button>
          )}
          <Button onClick={onClear} size="sm" theme="borderless" variant="secondary">
            {t(`${k}.search.clear`)}
          </Button>
        </>
      }
      title={t(`${k}.search.results`, { count: results.length, query: query.trim() })}
    >
      <p className="siamparkops:m-0 siamparkops:text-xs" style={muted}>
        {t(`${k}.search.scope`, { count: index.length })}
        {hidden.length > 0 && ` ${t(`${k}.search.hidden`, { sources: hidden.map((key) => t(`${k}.sources.${key}`)).join(', ') })}`}
      </p>
      {results.length === 0 ? (
        <EmptyState description={t(`${k}.search.emptyDescription`)} title={t(`${k}.search.empty`)} />
      ) : (
        <ul className="siamparkops:m-0 siamparkops:grid siamparkops:list-none siamparkops:grid-cols-1 siamparkops:gap-2 siamparkops:p-0 siamparkops:md:grid-cols-2" data-testid="ops-search-results">
          {results.map((row) => (
            <li key={`${row.kind}:${row.id}`}>
              <a
                className="siamparkops:flex siamparkops:items-center siamparkops:gap-3 siamparkops:rounded-xl siamparkops:p-3 siamparkops:no-underline siamparkops:transition-colors siamparkops:hover:shadow-md"
                href={linkTo(lang, row.href)}
                style={{ ...card, color: 'inherit' }}
              >
                <Pill tone={kindTone[row.kind]}>{t(`${k}.search.kind.${row.kind}`)}</Pill>
                <span className="siamparkops:flex siamparkops:min-w-0 siamparkops:flex-col">
                  <span className="siamparkops:truncate siamparkops:font-medium">{row.title}</span>
                  {row.subtitle !== undefined && (
                    <span className="siamparkops:truncate siamparkops:text-xs" style={muted}>
                      {row.subtitle}
                    </span>
                  )}
                </span>
                <span className="siamparkops:ml-auto" style={muted}>
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
  readonly sources: SiamparkSources;
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
  const missing = sourceKeys.filter((key) => key !== 'parties' && sources[key].status !== 'ready' && sources[key].status !== 'loading');
  return (
    <SectionCard
      actions={
        <a className="siamparkops:inline-flex siamparkops:items-center siamparkops:gap-1 siamparkops:text-sm siamparkops:font-medium" href={`/${lang}/siampark/provoz/agenda`}>
          {t(`${k}.overview.fullCalendar`)}
          <Icon name="arrowRight" size={14} />
        </a>
      }
      title={t(`${k}.overview.upcomingTitle`)}
    >
      {overdue.length > 0 && (
        <a
          className="siamparkops:flex siamparkops:items-center siamparkops:gap-2 siamparkops:rounded-xl siamparkops:px-3 siamparkops:py-2 siamparkops:text-sm siamparkops:font-medium siamparkops:no-underline"
          href={`/${lang}/siampark/provoz/agenda?view=seznam&filtr=po-terminu`}
          style={{ background: toneColors('danger').bg, color: toneColors('danger').fg }}
        >
          <Icon name="alert" size={18} />
          {t(`${k}.overview.overdueBanner`, { count: overdue.length })}
        </a>
      )}
      {visible.length === 0 ? (
        <EmptyState description={t(`${k}.overview.noUpcomingDescription`)} title={t(`${k}.overview.noUpcoming`)} />
      ) : (
        <ol className="siamparkops:m-0 siamparkops:flex siamparkops:list-none siamparkops:flex-col siamparkops:gap-3 siamparkops:p-0">
          {[...groups.entries()].map(([date, rows]) => {
            const urgency = urgencyOf({ date, done: false }, today);
            const tone = urgencyTone[urgency];
            const days = daysUntil(date, today);
            return (
              <li className="siamparkops:flex siamparkops:gap-3" key={date}>
                <div
                  className="siamparkops:flex siamparkops:h-14 siamparkops:w-14 siamparkops:shrink-0 siamparkops:flex-col siamparkops:items-center siamparkops:justify-center siamparkops:rounded-xl"
                  style={{ background: toneColors(tone).bg, color: toneColors(tone).fg }}
                >
                  <span className="siamparkops:text-lg siamparkops:font-semibold siamparkops:leading-none">{Number(date.slice(8, 10))}</span>
                  <span className="siamparkops:text-[11px] siamparkops:uppercase">{fmt.weekday(lang, date)}</span>
                </div>
                <div className="siamparkops:flex siamparkops:min-w-0 siamparkops:flex-1 siamparkops:flex-col siamparkops:gap-1.5">
                  <span className="siamparkops:text-xs siamparkops:font-medium" style={muted}>
                    {fmt.dayMonth(lang, date)} · {days === 0 ? t(`${k}.relative.today`) : t(`${k}.relative.inDays`, { count: days })}
                  </span>
                  {rows.map((row) => (
                    <a
                      className="siamparkops:flex siamparkops:items-center siamparkops:gap-2 siamparkops:rounded-lg siamparkops:px-2 siamparkops:py-1.5 siamparkops:no-underline siamparkops:hover:shadow-sm"
                      href={linkTo(lang, row.href)}
                      key={row.key}
                      style={{ color: 'inherit', background: 'var(--color-surface-subtle, #f8fafc)' }}
                    >
                      <Pill tone={categoryTone[row.category]}>{t(`${k}.category.${row.category}`)}</Pill>
                      <span className="siamparkops:truncate siamparkops:text-sm siamparkops:font-medium">{row.title}</span>
                      {row.location !== undefined && (
                        <span className="siamparkops:hidden siamparkops:truncate siamparkops:text-xs siamparkops:md:inline" style={muted}>
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
        <Button onClick={() => setShowAll((value) => !value)} size="sm" theme="borderless" variant="secondary">
          {showAll ? t(`${k}.overview.showLess`) : t(`${k}.overview.showMore`, { count: Math.min(upcoming.length, 24) - 8 })}
        </Button>
      )}
      {missing.length > 0 && (
        <p className="siamparkops:m-0 siamparkops:text-xs" style={muted}>
          {t(`${k}.calendar.missingSources`, { sources: missing.map((key) => `${t(`${k}.sources.${key}`)} (${t(`${k}.state.${sources[key].status}`)})`).join(', ') })}
        </p>
      )}
    </SectionCard>
  );
};

// ---- Occupancy by building -------------------------------------------------------------------------------------------

export const OccupancyByBuilding = ({ sources, today }: { readonly sources: SiamparkSources; readonly today: string }) => {
  const { lang, t } = useLang();
  const property = sources.property.data;
  const occupancy = sources.occupancy.data;
  let body: ReactNode;
  if (property === undefined || occupancy === undefined) {
    const status = sources.property.status !== 'ready' ? sources.property.status : sources.occupancy.status;
    body =
      status === 'loading' ? (
        <p className="siamparkops:m-0 siamparkops:text-sm" style={muted}>
          {t('siampark-ops.common.loading')}
        </p>
      ) : (
        <EmptyState description={t(`${k}.state.${status}Description`)} title={t(`${k}.state.${status}`)} />
      );
  } else {
    const buildings = property.properties
      .filter((entry) => entry.lifecycleState === 'ACTIVE')
      .map((entry) => {
        const units = property.units.filter(
          (unit) => unit.propertyRef.resourceId === entry.propertyRef.resourceId && unit.lifecycleState === 'ACTIVE',
        );
        const states = units.map((unit) => unitAvailability(unit.unitRef.resourceId, occupancy.occupancies, today));
        return {
          code: entry.code,
          free: states.filter((state) => state === 'AVAILABLE').length,
          id: entry.propertyRef.resourceId,
          name: entry.name,
          occupied: states.filter((state) => state === 'OCCUPIED').length,
          reserved: states.filter((state) => state === 'RESERVED').length,
          total: units.length,
        };
      });
    body =
      buildings.length === 0 ? (
        <EmptyState description={t(`${k}.overview.noBuildingsDescription`)} title={t(`${k}.state.noData`)} />
      ) : (
        <ul className="siamparkops:m-0 siamparkops:flex siamparkops:list-none siamparkops:flex-col siamparkops:gap-4 siamparkops:p-0">
          {buildings.map((building) => (
            <li className="siamparkops:flex siamparkops:flex-col siamparkops:gap-1.5" key={building.id}>
              <div className="siamparkops:flex siamparkops:items-baseline siamparkops:justify-between siamparkops:gap-2">
                <a className="siamparkops:truncate siamparkops:font-medium" href={`/${lang}/siampark/properties?resourceId=${building.id}`}>
                  {building.name}
                </a>
                <span className="siamparkops:text-sm siamparkops:tabular-nums" style={muted}>
                  {building.total === 0 ? t(`${k}.state.noData`) : `${formatPercent(building.occupied / building.total)} · ${building.occupied}/${building.total}`}
                </span>
              </div>
              <div className="siamparkops:flex siamparkops:h-3 siamparkops:w-full siamparkops:overflow-hidden siamparkops:rounded-full" style={{ background: 'var(--color-neutral-200, #e5e7eb)' }}>
                {building.total > 0 && (
                  <>
                    <span style={{ background: toneColors('primary').accent, width: `${(building.occupied / building.total) * 100}%` }} />
                    <span style={{ background: toneColors('warning').accent, width: `${(building.reserved / building.total) * 100}%` }} />
                  </>
                )}
              </div>
              <span className="siamparkops:text-xs" style={muted}>
                {t(`${k}.overview.buildingLine`, { free: building.free, occupied: building.occupied, reserved: building.reserved })}
              </span>
            </li>
          ))}
        </ul>
      );
  }
  return <SectionCard title={t(`${k}.overview.byBuilding`)}>{body}</SectionCard>;
};

// ---- Provoz agendas ----------------------------------------------------------------------------------------------

const agendaIcon: Record<string, IconName> = {
  agenda: 'calendar',
  assets: 'building',
  documents: 'contract',
  meters: 'timer',
  purchasing: 'clipboard',
  security: 'shield',
};

const recordCount = (state: unknown): number => {
  if (typeof state !== 'object' || state === null) {
    return 0;
  }
  const first = Object.values(state).find(Array.isArray);
  return Array.isArray(first) ? first.length : 0;
};

export const OpsAgendas = ({ sources }: { readonly sources: SiamparkSources }) => {
  const { lang, t } = useLang();
  const ops = sources.ops;
  return (
    <SectionCard title={t(`${k}.overview.opsTitle`)}>
      <div className="siamparkops:grid siamparkops:grid-cols-2 siamparkops:gap-3 siamparkops:md:grid-cols-3 siamparkops:xl:grid-cols-6">
        {agendaIds.map((agenda) => {
          const envelope = ops.data?.agendas[agenda];
          const locked = ops.status === 'ready' && envelope === undefined;
          return (
            <a
              className="siamparkops:flex siamparkops:flex-col siamparkops:gap-2 siamparkops:rounded-xl siamparkops:p-3 siamparkops:no-underline siamparkops:hover:shadow-md"
              data-agenda={agenda}
              href={`/${lang}/siampark/provoz/${opsSegments[agenda] ?? agenda}`}
              key={agenda}
              style={{ ...card, color: 'inherit', opacity: locked ? 0.7 : 1 }}
            >
              <IconBadge name={locked ? 'lock' : (agendaIcon[agenda] ?? 'clipboard')} size={34} tone={locked ? 'neutral' : 'primary'} />
              <span className="siamparkops:text-sm siamparkops:font-medium">{t(`siampark-ops.${agenda}.title`)}</span>
              <span className="siamparkops:text-xs" style={muted}>
                {ops.status === 'loading'
                  ? t('siampark-ops.common.loading')
                  : locked || ops.status === 'forbidden'
                    ? t(`${k}.state.forbidden`)
                    : envelope === undefined
                      ? t(`${k}.state.unavailable`)
                      : envelope.revision === 0 && recordCount(envelope.state) === 0
                        ? t(`${k}.state.noData`)
                        : t(`${k}.overview.records`, { count: recordCount(envelope.state) })}
              </span>
            </a>
          );
        })}
      </div>
    </SectionCard>
  );
};

