// @effect-diagnostics asyncFunction:off globalDate:off
// S13 notification centre, „Moje agenda“ and notification settings + export log. Owned by the ops-agenda lane.
import { EmptyState, SectionCard, StatCard, StatRow, formatNumber } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { DateTime } from 'effect';
import { useState } from 'react';
import type { Notification, NotificationPreference } from '../../../../../../shared/domain/agenda.ts';
import type { AgendaState } from '../../../../../../shared/domain/agenda.ts';
import { DEFAULT_LEAD_DAYS } from '../../../../../../shared/domain/agenda.ts';
import { daysUntil, urgencyOf } from '../../../../../ui/ops-agenda/deadlines.ts';
import type { Deadline } from '../../../../../ui/ops-agenda/deadlines.ts';
import { personaOf } from '../../../../../ui/ops-agenda/personas.ts';
import { Icon, IconBadge, Pill, categoryTone, fmt, langOf, toneColors, urgencyTone } from '../../../../../ui/ops-agenda/ui-bits.tsx';
import type { Tone } from '../../../../../ui/ops-agenda/model.ts';

const k = 'siampark-ops.agenda';
const muted = { color: 'var(--color-fg-secondary, #6b7280)' } as const;

const notificationTone: Record<Notification['category'], Tone> = {
  ASSIGNED: 'primary',
  CHANGE: 'info',
  DEADLINE: 'warning',
  OVERDUE: 'danger',
};
const notificationIcon = { ASSIGNED: 'tasks', CHANGE: 'refresh', DEADLINE: 'timer', OVERDUE: 'alert' } as const;

export const myNotifications = (state: AgendaState | undefined, me: string | undefined) =>
  (state?.notifications ?? [])
    .filter((entry) => entry.recipient.principalId === me)
    .toSorted((left, right) => DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt));

export const myPreference = (state: AgendaState | undefined, me: string | undefined): NotificationPreference | undefined =>
  state?.preferences?.find((entry) => entry.principal.principalId === me);

// ---- Notification centre -----------------------------------------------------------------------------------------

export const NotificationCenter = ({
  busy,
  canWrite,
  me,
  onCheck,
  onMarkAll,
  onMarkRead,
  state,
}: {
  readonly busy: boolean;
  readonly canWrite: boolean;
  readonly me: string | undefined;
  readonly onCheck: () => void;
  readonly onMarkAll: () => void;
  readonly onMarkRead: (id: string) => void;
  readonly state: AgendaState | undefined;
}) => {
  const { language, t } = useModernI18n();
  const lang = langOf(language);
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const all = myNotifications(state, me);
  const unread = all.filter((entry) => entry.readAt === undefined);
  const rows = filter === 'unread' ? unread : all;
  return (
    <SectionCard
      actions={
        <>
          <div className="siamparkops:inline-flex siamparkops:rounded-lg siamparkops:p-0.5" style={{ background: 'var(--color-surface-subtle, #f1f5f9)' }}>
            {(['all', 'unread'] as const).map((value) => (
              <button
                aria-pressed={filter === value}
                className="siamparkops:cursor-pointer siamparkops:rounded-md siamparkops:border-0 siamparkops:px-3 siamparkops:py-1 siamparkops:text-sm siamparkops:font-medium"
                key={value}
                onClick={() => setFilter(value)}
                style={{
                  background: filter === value ? '#ffffff' : 'transparent',
                  boxShadow: filter === value ? '0 1px 2px rgba(0,0,0,.08)' : 'none',
                  color: 'inherit',
                }}
                type="button"
              >
                {t(`${k}.notifications.filter.${value}`, { count: value === 'all' ? all.length : unread.length })}
              </button>
            ))}
          </div>
          {canWrite && (
            <>
              <Button isLoading={busy} onClick={onCheck} size="sm" theme="outlined" variant="secondary">
                {t(`${k}.notifications.check`)}
              </Button>
              <Button disabled={unread.length === 0} onClick={onMarkAll} size="sm" variant="primary">
                {t(`${k}.notifications.markAll`)}
              </Button>
            </>
          )}
        </>
      }
      title={t(`${k}.notifications.title`)}
    >
      <p className="siamparkops:m-0 siamparkops:text-xs" style={muted}>
        {canWrite ? t(`${k}.notifications.explain`) : t(`${k}.notifications.readOnly`)}
      </p>
      {rows.length === 0 ? (
        <EmptyState
          description={t(`${k}.notifications.emptyDescription`)}
          title={filter === 'unread' ? t(`${k}.notifications.emptyUnread`) : t(`${k}.notifications.empty`)}
        />
      ) : (
        <ul className="siamparkops:m-0 siamparkops:flex siamparkops:list-none siamparkops:flex-col siamparkops:gap-2 siamparkops:p-0" data-testid="notification-list">
          {rows.map((entry) => {
            const tone = notificationTone[entry.category];
            const isUnread = entry.readAt === undefined;
            const from = personaOf(entry.createdBy.principalId);
            return (
              <li
                className="siamparkops:flex siamparkops:items-start siamparkops:gap-3 siamparkops:rounded-xl siamparkops:p-3"
                data-event-key={entry.eventKey}
                data-unread={isUnread}
                key={entry.id}
                style={{
                  background: isUnread ? toneColors(tone).bg : '#ffffff',
                  border: `1px solid ${isUnread ? toneColors(tone).ring : 'var(--color-border-primary, #e5e7eb)'}`,
                }}
              >
                <IconBadge name={notificationIcon[entry.category]} size={36} tone={tone} />
                <div className="siamparkops:flex siamparkops:min-w-0 siamparkops:flex-1 siamparkops:flex-col siamparkops:gap-0.5">
                  <div className="siamparkops:flex siamparkops:flex-wrap siamparkops:items-center siamparkops:gap-2">
                    <Pill solid={isUnread} tone={tone}>
                      {t(`${k}.notifications.category.${entry.category}`)}
                    </Pill>
                    <span className="siamparkops:font-medium">{entry.title}</span>
                  </div>
                  <span className="siamparkops:text-xs" style={muted}>
                    {[
                      t(`${k}.sources.${entry.source}`),
                      entry.dueDate === undefined ? undefined : t(`${k}.notifications.due`, { date: fmt.short(lang, entry.dueDate) }),
                      entry.detail === undefined ? undefined : t(`${k}.category.${entry.detail}`, { defaultValue: entry.detail }),
                      from === undefined || entry.category !== 'ASSIGNED' ? undefined : t(`${k}.notifications.from`, { who: from.email }),
                      fmt.stamp(lang, DateTime.formatIso(entry.createdAt)),
                    ]
                      .filter((part) => part !== undefined)
                      .join(' · ')}
                  </span>
                </div>
                <div className="siamparkops:flex siamparkops:shrink-0 siamparkops:items-center siamparkops:gap-2">
                  {entry.href !== undefined && (
                    <a className="siamparkops:inline-flex siamparkops:items-center siamparkops:gap-1 siamparkops:text-sm siamparkops:font-medium" href={`/${lang}${entry.href}`}>
                      {t(`${k}.open`)}
                      <Icon name="arrowRight" size={14} />
                    </a>
                  )}
                  {isUnread && canWrite && (
                    <Button onClick={() => onMarkRead(entry.id)} size="sm" theme="borderless" variant="secondary">
                      {t(`${k}.notifications.markRead`)}
                    </Button>
                  )}
                  {!isUnread && entry.readAt !== undefined && (
                    <span className="siamparkops:inline-flex siamparkops:items-center siamparkops:gap-1 siamparkops:text-xs" style={muted}>
                      <Icon name="check" size={14} />
                      {t(`${k}.notifications.readAt`, { time: fmt.stamp(lang, DateTime.formatIso(entry.readAt)) })}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
};

// ---- Moje agenda --------------------------------------------------------------------------------------------------

export const MyAgenda = ({
  deadlines,
  me,
  onOpen,
  state,
  today,
  workStatus,
}: {
  readonly deadlines: readonly Deadline[];
  readonly me: string | undefined;
  readonly onOpen: (deadline: Deadline) => void;
  readonly state: AgendaState | undefined;
  readonly today: string;
  readonly workStatus: string;
}) => {
  const { language, t } = useModernI18n();
  const lang = langOf(language);
  const mine = deadlines.filter((row) => row.ownerPrincipalId === me && !row.done);
  const tasks = mine.filter((row) => row.category === 'task');
  const events = mine.filter((row) => row.category === 'event' && row.date >= addDaysBack(today));
  const overdue = mine.filter((row) => row.date < today);
  const todayRows = mine.filter((row) => row.date === today);
  const week = mine.filter((row) => row.date >= today && daysUntil(row.date, today) <= 7);
  const unread = myNotifications(state, me).filter((entry) => entry.readAt === undefined);
  const persona = personaOf(me);
  const list = (rows: readonly Deadline[], empty: string) =>
    rows.length === 0 ? (
      <p className="siamparkops:m-0 siamparkops:text-sm" style={muted}>
        {empty}
      </p>
    ) : (
      <ul className="siamparkops:m-0 siamparkops:flex siamparkops:list-none siamparkops:flex-col siamparkops:gap-1.5 siamparkops:p-0">
        {rows.slice(0, 12).map((row) => {
          const urgency = urgencyOf(row, today);
          return (
            <li key={row.key}>
              <button
                className="siamparkops:flex siamparkops:w-full siamparkops:cursor-pointer siamparkops:items-center siamparkops:gap-3 siamparkops:rounded-lg siamparkops:px-2 siamparkops:py-2 siamparkops:text-left siamparkops:hover:shadow-sm"
                data-key={row.key}
                onClick={() => onOpen(row)}
                style={{ background: 'var(--color-surface-subtle, #f8fafc)', border: 0, color: 'inherit', font: 'inherit' }}
                type="button"
              >
                <span
                  className="siamparkops:flex siamparkops:h-10 siamparkops:w-10 siamparkops:shrink-0 siamparkops:flex-col siamparkops:items-center siamparkops:justify-center siamparkops:rounded-lg siamparkops:text-xs siamparkops:font-semibold"
                  style={{ background: toneColors(urgencyTone[urgency]).bg, color: toneColors(urgencyTone[urgency]).fg }}
                >
                  <span className="siamparkops:text-base siamparkops:leading-none">{Number(row.date.slice(8, 10))}</span>
                  <span className="siamparkops:text-[10px] siamparkops:uppercase">{fmt.weekday(lang, row.date)}</span>
                </span>
                <span className="siamparkops:flex siamparkops:min-w-0 siamparkops:flex-1 siamparkops:flex-col">
                  <span className="siamparkops:truncate siamparkops:font-medium">{row.title}</span>
                  <span className="siamparkops:truncate siamparkops:text-xs" style={muted}>
                    {row.location ?? t(`${k}.sources.${row.source}`)}
                  </span>
                </span>
                <Pill tone={urgencyTone[urgency]}>{t(`${k}.urgency.${urgency}`)}</Pill>
              </button>
            </li>
          );
        })}
      </ul>
    );
  return (
    <div className="siamparkops:flex siamparkops:flex-col siamparkops:gap-4">
      <p className="siamparkops:m-0 siamparkops:text-sm" style={muted}>
        {t(`${k}.mine.intro`, { who: persona?.email ?? t(`${k}.mine.you`) })}
      </p>
      <StatRow>
        <StatCard label={t(`${k}.mine.overdue`)} value={formatNumber(overdue.length)} />
        <StatCard label={t(`${k}.mine.today`)} value={formatNumber(todayRows.length)} />
        <StatCard label={t(`${k}.mine.week`)} value={formatNumber(week.length)} />
        <StatCard label={t(`${k}.mine.unread`)} value={formatNumber(unread.length)} />
      </StatRow>
      <div className="siamparkops:grid siamparkops:grid-cols-1 siamparkops:gap-4 siamparkops:lg:grid-cols-2">
        <SectionCard
          actions={
            <a className="siamparkops:text-sm siamparkops:font-medium" href={`/${lang}/siampark/work`}>
              {t(`${k}.mine.allTasks`)}
            </a>
          }
          title={t(`${k}.mine.tasks`, { count: tasks.length })}
        >
          {workStatus === 'ready' ? list(tasks, t(`${k}.mine.noTasks`)) : <p className="siamparkops:m-0 siamparkops:text-sm" style={muted}>{t(`${k}.state.${workStatus}`)}</p>}
        </SectionCard>
        <SectionCard title={t(`${k}.mine.events`, { count: events.length })}>{list(events, t(`${k}.mine.noEvents`))}</SectionCard>
      </div>
      <SectionCard title={t(`${k}.mine.byCategory`)}>
        <div className="siamparkops:flex siamparkops:flex-wrap siamparkops:gap-2">
          {[...new Set(mine.map((row) => row.category))].map((category) => (
            <Pill key={category} tone={categoryTone[category]}>
              {t(`${k}.category.${category}`)}: {mine.filter((row) => row.category === category).length}
            </Pill>
          ))}
          {mine.length === 0 && (
            <span className="siamparkops:text-sm" style={muted}>
              {t(`${k}.mine.nothing`)}
            </span>
          )}
        </div>
      </SectionCard>
    </div>
  );
};

const addDaysBack = (today: string) => today.slice(0, 8) + '01';

// ---- Settings + export log ---------------------------------------------------------------------------------------

export const SettingsPanel = ({
  canWrite,
  me,
  onSave,
  saving,
  state,
}: {
  readonly canWrite: boolean;
  readonly me: string | undefined;
  readonly onSave: (leadDays: number, emailOptIn: boolean) => void;
  readonly saving: boolean;
  readonly state: AgendaState | undefined;
}) => {
  const { language, t } = useModernI18n();
  const lang = langOf(language);
  const current = myPreference(state, me);
  const [leadDays, setLeadDays] = useState(String(current?.leadDays ?? DEFAULT_LEAD_DAYS));
  const [email, setEmail] = useState(current?.emailOptIn ?? false);
  const exports = (state?.exports ?? []).toSorted((left, right) => DateTime.toEpochMillis(right.exportedAt) - DateTime.toEpochMillis(left.exportedAt)).slice(0, 25);
  return (
    <div className="siamparkops:grid siamparkops:grid-cols-1 siamparkops:gap-4 siamparkops:xl:grid-cols-5">
      <div className="siamparkops:xl:col-span-2">
        <SectionCard title={t(`${k}.settings.title`)}>
          <div className="siamparkops:flex siamparkops:flex-col siamparkops:gap-4">
            <Select
              disabled={!canWrite}
              items={['3', '7', '14', '30', '60'].map((value) => ({ displayValue: t(`${k}.settings.days`, { count: Number(value) }), label: t(`${k}.settings.days`, { count: Number(value) }), value }))}
              label={t(`${k}.settings.leadDays`)}
              name="leadDays"
              onValueChange={({ value }) => setLeadDays(value[0] ?? String(DEFAULT_LEAD_DAYS))}
              size="md"
              value={[leadDays]}
            />
            <div className="siamparkops:flex siamparkops:flex-col siamparkops:gap-1">
              <Switch checked={email} disabled={!canWrite} onCheckedChange={setEmail}>
                {t(`${k}.settings.email`)}
              </Switch>
              <span className="siamparkops:inline-flex siamparkops:items-center siamparkops:gap-2 siamparkops:text-xs" style={muted}>
                <Pill tone="warning">{t('siampark-ops.common.simulation')}</Pill>
                {t(`${k}.settings.emailNote`)}
              </span>
            </div>
            <p className="siamparkops:m-0 siamparkops:text-xs" style={muted}>
              {current === undefined
                ? t(`${k}.settings.default`, { count: DEFAULT_LEAD_DAYS })
                : t(`${k}.settings.savedAt`, { time: fmt.stamp(lang, DateTime.formatIso(current.updatedAt)) })}
            </p>
            {canWrite && (
              <Button isLoading={saving} onClick={() => onSave(Number(leadDays), email)} size="sm" variant="primary">
                {t('siampark-ops.common.save')}
              </Button>
            )}
          </div>
        </SectionCard>
      </div>
      <div className="siamparkops:xl:col-span-3">
        <SectionCard title={t(`${k}.exportsLog.title`)}>
          {exports.length === 0 ? (
            <EmptyState description={t(`${k}.exportsLog.emptyDescription`)} title={t(`${k}.exportsLog.empty`)} />
          ) : (
            <table className="siamparkops:w-full siamparkops:border-collapse siamparkops:text-sm" data-testid="export-log">
              <thead>
                <tr className="siamparkops:text-left" style={muted}>
                  <th className="siamparkops:px-2 siamparkops:py-1.5 siamparkops:font-medium">{t(`${k}.exportsLog.when`)}</th>
                  <th className="siamparkops:px-2 siamparkops:py-1.5 siamparkops:font-medium">{t(`${k}.exportsLog.who`)}</th>
                  <th className="siamparkops:px-2 siamparkops:py-1.5 siamparkops:font-medium">{t(`${k}.exportsLog.list`)}</th>
                  <th className="siamparkops:px-2 siamparkops:py-1.5 siamparkops:text-right siamparkops:font-medium">{t(`${k}.exportsLog.rows`)}</th>
                </tr>
              </thead>
              <tbody>
                {exports.map((entry) => (
                  <tr key={entry.id} style={{ borderTop: '1px solid var(--color-border-muted, #f1f5f9)' }}>
                    <td className="siamparkops:whitespace-nowrap siamparkops:px-2 siamparkops:py-1.5">{fmt.stamp(lang, DateTime.formatIso(entry.exportedAt))}</td>
                    <td className="siamparkops:px-2 siamparkops:py-1.5">{personaOf(entry.exportedBy.principalId)?.email ?? entry.exportedBy.principalId}</td>
                    <td className="siamparkops:px-2 siamparkops:py-1.5">
                      <div>{entry.list.startsWith('overview:')
                        ? t(`${k}.kpi.${entry.list.slice('overview:'.length)}.label`)
                        : entry.list === 'search' ? t(`${k}.search.label`)
                          : entry.list === 'calendar' ? t(`${k}.tabs.kalendar`) : t(`${k}.exportsLog.other`)}</div>
                      {entry.filter !== undefined && !entry.filter.startsWith('kpi=') && (
                        <div className="siamparkops:text-xs" style={muted}>
                          {entry.filter}
                        </div>
                      )}
                    </td>
                    <td className="siamparkops:px-2 siamparkops:py-1.5 siamparkops:text-right siamparkops:tabular-nums">{entry.rowCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </SectionCard>
      </div>
    </div>
  );
};
