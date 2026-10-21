// @effect-diagnostics asyncFunction:off globalDate:off
// S13 notification centre, „Moje agenda“ and notification settings + export log. Owned by the ops-agenda lane.
import { EmptyState, SectionCard, StatCard, StatRow, formatNumber } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { DateTime } from 'effect';
import { useState } from 'react';
import type { Notification, NotificationPreference } from '../../../../../shared/domain/agenda.ts';
import type { AgendaState } from '../../../../../shared/domain/agenda.ts';
import { DEFAULT_LEAD_DAYS, MANDATORY_EMAIL_CATEGORIES, OPTIONAL_EMAIL_CATEGORIES } from '../../../../../shared/domain/agenda.ts';
import { daysUntil, urgencyOf } from '../../../../ui/ops-agenda/deadlines.ts';
import type { Deadline } from '../../../../ui/ops-agenda/deadlines.ts';
import { personaOf } from '../../../../ui/ops-agenda/personas.ts';
import { Icon, IconBadge, Pill, categoryTone, fmt, langOf, toneColors, urgencyTone } from '../../../../ui/ops-agenda/ui-bits.tsx';
import type { Tone } from '../../../../ui/ops-agenda/model.ts';
import { agendaEmailKey, useAgendaEmailReceipts, useEmailProvider } from './agenda-email.tsx';

const k = 'facility-operations.agenda';
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
  const emailOn = myPreference(state, me)?.emailOptIn === true;
  const emailKeyOf = (entry: Notification) => agendaEmailKey(entry.recipient.principalId, DateTime.formatIso(entry.createdAt));
  const receipts = useAgendaEmailReceipts(emailOn ? rows.slice(0, 100).map(emailKeyOf) : []);
  return (
    <SectionCard
      actions={
        <>
          <div className="facilityoperations:inline-flex facilityoperations:rounded-lg facilityoperations:p-0.5" style={{ background: 'var(--color-surface-subtle, #f1f5f9)' }}>
            {(['all', 'unread'] as const).map((value) => (
              <button
                aria-pressed={filter === value}
                className="facilityoperations:cursor-pointer facilityoperations:rounded-md facilityoperations:border-0 facilityoperations:px-3 facilityoperations:py-1 facilityoperations:text-sm facilityoperations:font-medium"
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
      <style>{`
        .ops-inbox-card { display: grid; grid-template-columns: 36px minmax(0, 1fr); }
        .ops-inbox-actions { grid-column: 2; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; min-width: 0; }
        .ops-inbox-title { overflow-wrap: anywhere; }
        @media (min-width: 768px) {
          .ops-inbox-card { grid-template-columns: 36px minmax(0, 1fr) auto; }
          .ops-inbox-actions { grid-column: 3; grid-row: 1; max-width: 260px; justify-content: flex-end; }
        }
        @media (max-width: 639px) {
          .ops-inbox-title { font-size: 16px; line-height: 1.5; }
          .ops-inbox-meta { font-size: 14px; line-height: 1.5; }
          .ops-inbox-actions > a, .ops-inbox-actions > button { min-height: 44px; }
        }
      `}</style>
      <p className="facilityoperations:m-0 facilityoperations:text-xs" style={muted}>
        {canWrite ? t(`${k}.notifications.explain`) : t(`${k}.notifications.readOnly`)}
      </p>
      {rows.length === 0 ? (
        <EmptyState
          description={t(`${k}.notifications.emptyDescription`)}
          title={filter === 'unread' ? t(`${k}.notifications.emptyUnread`) : t(`${k}.notifications.empty`)}
        />
      ) : (
        <ul className="facilityoperations:m-0 facilityoperations:flex facilityoperations:list-none facilityoperations:flex-col facilityoperations:gap-2 facilityoperations:p-0" data-testid="notification-list">
          {rows.map((entry) => {
            const tone = notificationTone[entry.category];
            const isUnread = entry.readAt === undefined;
            const from = personaOf(entry.createdBy.principalId);
            return (
              <li
                className="ops-inbox-card facilityoperations:items-start facilityoperations:gap-3 facilityoperations:rounded-xl facilityoperations:p-3"
                data-event-key={entry.eventKey}
                data-unread={isUnread}
                key={entry.id}
                style={{
                  background: isUnread ? toneColors(tone).bg : '#ffffff',
                  border: `1px solid ${isUnread ? toneColors(tone).ring : 'var(--color-border-primary, #e5e7eb)'}`,
                }}
              >
                <IconBadge name={notificationIcon[entry.category]} size={36} tone={tone} />
                <div className="facilityoperations:flex facilityoperations:min-w-0 facilityoperations:flex-1 facilityoperations:flex-col facilityoperations:gap-0.5">
                  <div className="facilityoperations:flex facilityoperations:flex-wrap facilityoperations:items-center facilityoperations:gap-2">
                    <Pill solid={isUnread} tone={tone}>
                      {t(`${k}.notifications.category.${entry.category}`)}
                    </Pill>
                    <span className="ops-inbox-title facilityoperations:w-full facilityoperations:font-medium">{entry.title}</span>
                  </div>
                  <span className="ops-inbox-meta facilityoperations:text-xs" style={muted}>
                    {[
                      t(`${k}.sources.${entry.source}`),
                      entry.dueDate === undefined ? undefined : t(`${k}.notifications.due`, { date: fmt.short(lang, entry.dueDate) }),
                      entry.detail === undefined ? undefined : t(`${k}.category.${entry.detail}`, { defaultValue: entry.detail }),
                      from === undefined || entry.category !== 'ASSIGNED' || entry.source === 'work' ? undefined : t(`${k}.notifications.from`, { who: from.email }),
                      fmt.stamp(lang, DateTime.formatIso(entry.createdAt)),
                    ]
                      .filter((part) => part !== undefined)
                      .join(' · ')}
                  </span>
                </div>
                <div className="ops-inbox-actions">
                  {entry.href !== undefined && (
                    <a className="facilityoperations:inline-flex facilityoperations:items-center facilityoperations:gap-1 facilityoperations:text-sm facilityoperations:font-medium" href={`/${lang}${entry.href}`}>
                      {t(`${k}.open`)}
                      <Icon name="arrowRight" size={14} />
                    </a>
                  )}
                  {isUnread && canWrite && (
                    <Button onClick={() => onMarkRead(entry.id)} size="sm" theme="borderless" variant="secondary">
                      {t(`${k}.notifications.markRead`)}
                    </Button>
                  )}
                  {(() => {
                    const receipt = receipts.get(emailKeyOf(entry));
                    if (receipt === undefined) return null;
                    const label =
                      receipt.status === 'SENT' && receipt.sentAt !== null
                        ? t(`${k}.notifications.emailSent`, { time: fmt.stamp(lang, receipt.sentAt) })
                        : receipt.status === 'FAILED' || receipt.status === 'UNKNOWN'
                          ? t(`${k}.notifications.emailFailed`)
                          : t(`${k}.notifications.emailPending`);
                    return (
                      <span className="facilityoperations:inline-flex facilityoperations:items-center facilityoperations:gap-1 facilityoperations:text-xs" data-testid="notification-email" style={muted}>
                        <Icon name="mail" size={14} />
                        {label}
                      </span>
                    );
                  })()}
                  {!isUnread && entry.readAt !== undefined && (
                    <span className="facilityoperations:inline-flex facilityoperations:items-center facilityoperations:gap-1 facilityoperations:text-xs" style={muted}>
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
      <p className="facilityoperations:m-0 facilityoperations:text-sm" style={muted}>
        {empty}
      </p>
    ) : (
      <ul className="facilityoperations:m-0 facilityoperations:flex facilityoperations:list-none facilityoperations:flex-col facilityoperations:gap-1.5 facilityoperations:p-0">
        {rows.slice(0, 12).map((row) => {
          const urgency = urgencyOf(row, today);
          return (
            <li key={row.key}>
              <button
                className="facilityoperations:flex facilityoperations:w-full facilityoperations:cursor-pointer facilityoperations:items-center facilityoperations:gap-3 facilityoperations:rounded-lg facilityoperations:px-2 facilityoperations:py-2 facilityoperations:text-left facilityoperations:hover:shadow-sm"
                data-key={row.key}
                onClick={() => onOpen(row)}
                style={{ background: 'var(--color-surface-subtle, #f8fafc)', border: 0, color: 'inherit', font: 'inherit' }}
                type="button"
              >
                <span
                  className="facilityoperations:flex facilityoperations:h-10 facilityoperations:w-10 facilityoperations:shrink-0 facilityoperations:flex-col facilityoperations:items-center facilityoperations:justify-center facilityoperations:rounded-lg facilityoperations:text-xs facilityoperations:font-semibold"
                  style={{ background: toneColors(urgencyTone[urgency]).bg, color: toneColors(urgencyTone[urgency]).fg }}
                >
                  <span className="facilityoperations:text-base facilityoperations:leading-none">{Number(row.date.slice(8, 10))}</span>
                  <span className="facilityoperations:text-[10px] facilityoperations:uppercase">{fmt.weekday(lang, row.date)}</span>
                </span>
                <span className="facilityoperations:flex facilityoperations:min-w-0 facilityoperations:flex-1 facilityoperations:flex-col">
                  <span className="facilityoperations:truncate facilityoperations:font-medium">{row.title}</span>
                  <span className="facilityoperations:truncate facilityoperations:text-xs" style={muted}>
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
    <div className="facilityoperations:flex facilityoperations:flex-col facilityoperations:gap-4">
      <p className="facilityoperations:m-0 facilityoperations:text-sm" style={muted}>
        {t(`${k}.mine.intro`, { who: persona?.email ?? t(`${k}.mine.you`) })}
      </p>
      <StatRow>
        <StatCard label={t(`${k}.mine.overdue`)} value={formatNumber(overdue.length)} />
        <StatCard label={t(`${k}.mine.today`)} value={formatNumber(todayRows.length)} />
        <StatCard label={t(`${k}.mine.week`)} value={formatNumber(week.length)} />
        <StatCard label={t(`${k}.mine.unread`)} value={formatNumber(unread.length)} />
      </StatRow>
      <div className="facilityoperations:grid facilityoperations:grid-cols-1 facilityoperations:gap-4 facilityoperations:lg:grid-cols-2">
        <SectionCard
          actions={
            <a className="facilityoperations:text-sm facilityoperations:font-medium" href={`/${lang}/ukoly`}>
              {t(`${k}.mine.allTasks`)}
            </a>
          }
          title={t(`${k}.mine.tasks`, { count: tasks.length })}
        >
          {workStatus === 'ready' ? list(tasks, t(`${k}.mine.noTasks`)) : <p className="facilityoperations:m-0 facilityoperations:text-sm" style={muted}>{t(`${k}.state.${workStatus}`)}</p>}
        </SectionCard>
        <SectionCard title={t(`${k}.mine.events`, { count: events.length })}>{list(events, t(`${k}.mine.noEvents`))}</SectionCard>
      </div>
      <SectionCard title={t(`${k}.mine.byCategory`)}>
        <div className="facilityoperations:flex facilityoperations:flex-wrap facilityoperations:gap-2">
          {[...new Set(mine.map((row) => row.category))].map((category) => (
            <Pill key={category} tone={categoryTone[category]}>
              {t(`${k}.category.${category}`)}: {mine.filter((row) => row.category === category).length}
            </Pill>
          ))}
          {mine.length === 0 && (
            <span className="facilityoperations:text-sm" style={muted}>
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
  readonly onSave: (leadDays: number, emailOptIn: boolean, emailCategories: readonly ('DEADLINE' | 'CHANGE')[]) => void;
  readonly saving: boolean;
  readonly state: AgendaState | undefined;
}) => {
  const { language, t } = useModernI18n();
  const lang = langOf(language);
  const current = myPreference(state, me);
  const [leadDays, setLeadDays] = useState(String(current?.leadDays ?? DEFAULT_LEAD_DAYS));
  const [email, setEmail] = useState(current?.emailOptIn ?? false);
  const [optional, setOptional] = useState<ReadonlySet<'DEADLINE' | 'CHANGE'>>(
    new Set(
      current?.emailCategories === undefined
        ? OPTIONAL_EMAIL_CATEGORIES
        : OPTIONAL_EMAIL_CATEGORIES.filter((category) => current.emailCategories?.includes(category) === true),
    ),
  );
  const provider = useEmailProvider();
  const address = personaOf(me)?.email ?? t(`${k}.settings.yourAddress`);
  const providerPill =
    provider.kind === 'ready' && provider.provider.configured ? (
      <Pill tone="success">{t(`${k}.settings.emailOn`)}</Pill>
    ) : provider.kind === 'loading' ? undefined : (
      <Pill tone="warning">{t(`${k}.settings.emailOff`)}</Pill>
    );
  const providerText =
    provider.kind === 'loading'
      ? t(`${k}.settings.emailChecking`)
      : provider.kind === 'unavailable'
        ? t(`${k}.settings.emailUnknown`)
        : provider.provider.configured
          ? t(`${k}.settings.emailReal`, { address, provider: provider.provider.label ?? 'SMTP' })
          : t(`${k}.settings.emailNotConfigured`);
  const exports = (state?.exports ?? []).toSorted((left, right) => DateTime.toEpochMillis(right.exportedAt) - DateTime.toEpochMillis(left.exportedAt)).slice(0, 25);
  return (
    <div className="facilityoperations:grid facilityoperations:grid-cols-1 facilityoperations:gap-4 facilityoperations:xl:grid-cols-5">
      <div className="facilityoperations:xl:col-span-2">
        <SectionCard title={t(`${k}.settings.title`)}>
          <div className="facilityoperations:flex facilityoperations:flex-col facilityoperations:gap-4">
            <Select
              disabled={!canWrite}
              items={['3', '7', '14', '30', '60'].map((value) => ({ displayValue: t(`${k}.settings.days`, { count: Number(value) }), label: t(`${k}.settings.days`, { count: Number(value) }), value }))}
              label={t(`${k}.settings.leadDays`)}
              name="leadDays"
              onValueChange={({ value }) => setLeadDays(value[0] ?? String(DEFAULT_LEAD_DAYS))}
              size="md"
              value={[leadDays]}
            />
            <div className="facilityoperations:flex facilityoperations:flex-col facilityoperations:gap-1">
              <Switch checked={email} disabled={!canWrite} onCheckedChange={setEmail}>
                {t(`${k}.settings.email`)}
              </Switch>
              <span className="facilityoperations:flex facilityoperations:flex-col facilityoperations:items-start facilityoperations:gap-1 facilityoperations:text-xs" data-testid="email-provider" style={muted}>
                {providerPill}
                <span>{providerText}</span>
              </span>
            </div>
            {email && (
              <fieldset className="facilityoperations:m-0 facilityoperations:flex facilityoperations:flex-col facilityoperations:gap-2 facilityoperations:border-0 facilityoperations:p-0" data-testid="email-events">
                <legend className="facilityoperations:mb-1 facilityoperations:p-0 facilityoperations:text-sm facilityoperations:font-medium">{t(`${k}.settings.emailEvents`)}</legend>
                {MANDATORY_EMAIL_CATEGORIES.map((category) => (
                  <FormCheckbox
                    checked
                    disabled
                    helpText={t(`${k}.settings.mandatory`)}
                    id={`email-category-${category}`}
                    key={category}
                    label={t(`${k}.notifications.category.${category}`)}
                    size="sm"
                  />
                ))}
                {OPTIONAL_EMAIL_CATEGORIES.map((category) => (
                  <FormCheckbox
                    checked={optional.has(category)}
                    disabled={!canWrite}
                    id={`email-category-${category}`}
                    key={category}
                    label={t(`${k}.notifications.category.${category}`)}
                    onCheckedChange={(checked) =>
                      setOptional((previous) => {
                        const next = new Set(previous);
                        if (checked) next.add(category);
                        else next.delete(category);
                        return next;
                      })
                    }
                    size="sm"
                  />
                ))}
                <span className="facilityoperations:text-xs" style={muted}>
                  {t(`${k}.settings.optionalHint`)}
                </span>
              </fieldset>
            )}
            <p className="facilityoperations:m-0 facilityoperations:text-xs" style={muted}>
              {current === undefined
                ? t(`${k}.settings.default`, { count: DEFAULT_LEAD_DAYS })
                : t(`${k}.settings.savedAt`, { time: fmt.stamp(lang, DateTime.formatIso(current.updatedAt)) })}
            </p>
            {canWrite && (
              <Button isLoading={saving} onClick={() => onSave(Number(leadDays), email, OPTIONAL_EMAIL_CATEGORIES.filter((category) => optional.has(category)))} size="sm" variant="primary">
                {t('facility-operations.common.save')}
              </Button>
            )}
          </div>
        </SectionCard>
      </div>
      <div className="facilityoperations:xl:col-span-3">
        <SectionCard title={t(`${k}.exportsLog.title`)}>
          {exports.length === 0 ? (
            <EmptyState description={t(`${k}.exportsLog.emptyDescription`)} title={t(`${k}.exportsLog.empty`)} />
          ) : (
            <table className="facilityoperations:w-full facilityoperations:border-collapse facilityoperations:text-sm" data-testid="export-log">
              <thead>
                <tr className="facilityoperations:text-left" style={muted}>
                  <th className="facilityoperations:px-2 facilityoperations:py-1.5 facilityoperations:font-medium">{t(`${k}.exportsLog.when`)}</th>
                  <th className="facilityoperations:px-2 facilityoperations:py-1.5 facilityoperations:font-medium">{t(`${k}.exportsLog.who`)}</th>
                  <th className="facilityoperations:px-2 facilityoperations:py-1.5 facilityoperations:font-medium">{t(`${k}.exportsLog.list`)}</th>
                  <th className="facilityoperations:px-2 facilityoperations:py-1.5 facilityoperations:text-right facilityoperations:font-medium">{t(`${k}.exportsLog.rows`)}</th>
                </tr>
              </thead>
              <tbody>
                {exports.map((entry) => (
                  <tr key={entry.id} style={{ borderTop: '1px solid var(--color-border-muted, #f1f5f9)' }}>
                    <td className="facilityoperations:whitespace-nowrap facilityoperations:px-2 facilityoperations:py-1.5">{fmt.stamp(lang, DateTime.formatIso(entry.exportedAt))}</td>
                    <td className="facilityoperations:px-2 facilityoperations:py-1.5">{personaOf(entry.exportedBy.principalId)?.email ?? entry.exportedBy.principalId}</td>
                    <td className="facilityoperations:px-2 facilityoperations:py-1.5">
                      <div>{entry.list.startsWith('overview:')
                        ? t(`${k}.kpi.${entry.list.slice('overview:'.length)}.label`)
                        : entry.list === 'search' ? t(`${k}.search.label`)
                          : entry.list === 'calendar' ? t(`${k}.tabs.kalendar`) : t(`${k}.exportsLog.other`)}</div>
                      {entry.filter !== undefined && !entry.filter.startsWith('kpi=') && (
                        <div className="facilityoperations:text-xs" style={muted}>
                          {entry.filter}
                        </div>
                      )}
                    </td>
                    <td className="facilityoperations:px-2 facilityoperations:py-1.5 facilityoperations:text-right facilityoperations:tabular-nums">{entry.rowCount}</td>
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
