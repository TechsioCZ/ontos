// S13 notification centre, „Moje agenda“ and notification settings + export log. Owned by the ops-agenda lane.
import {
  EmptyState,
  SaveBar,
  SectionCard,
  StatCard,
  StatRow,
  UnsavedChangesDialog,
  formatNumber,
  saveLabelsFor,
  useRecordDraft,
} from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import {
  ChoiceField,
  FormReact,
  FormRoot,
  SwitchField,
  fromPayload,
  makeMemberCheckboxField,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { DateTime, Effect, Option, Schema, Struct } from 'effect';
import { useEffect, useRef, useState } from 'react';
import { agendaCommandSchemas } from '../../../../../shared/commands/agenda.ts';
import { browserAtomRuntime, browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { useEditGuard } from '../../../../ui/edit-guard.tsx';
import type {
  AgendaState,
  Notification,
  NotificationCategory,
  NotificationPreference,
} from '../../../../../shared/domain/agenda.ts';
import {
  DEFAULT_LEAD_DAYS,
  MANDATORY_EMAIL_CATEGORIES,
  NotificationCategorySchema,
  OPTIONAL_EMAIL_CATEGORIES,
} from '../../../../../shared/domain/agenda.ts';
import { daysUntil, urgencyOf } from '../../../../ui/ops-agenda/deadlines.ts';
import type { Deadline } from '../../../../../shared/domain/ops-overview.ts';
import { useAgendaPeople } from '../../../../ui/ops-agenda/agenda-people.tsx';
import {
  Icon,
  IconBadge,
  Pill,
  categoryTone,
  fmt,
  langOf,
  toneColors,
  urgencyTone,
} from '../../../../ui/ops-agenda/ui-bits.tsx';
import type { Tone } from '../../../../ui/ops-agenda/model.ts';
import type { AgendaEmailReceipts, EmailProviderState } from './agenda-email.tsx';
import { agendaEmailKey, useAgendaEmailReceipts, useEmailProvider } from './agenda-email.tsx';

const k = 'facility-operations.agenda';

const notificationTone = {
  ASSIGNED: 'primary',
  CHANGE: 'info',
  DEADLINE: 'warning',
  OVERDUE: 'danger',
} as const satisfies Record<Notification['category'], Tone>;
const notificationIcon = { ASSIGNED: 'tasks', CHANGE: 'refresh', DEADLINE: 'timer', OVERDUE: 'alert' } as const;

export const myNotifications = (state: AgendaState | undefined, me: string | undefined) =>
  (state?.notifications ?? [])
    .filter((entry) => entry.recipient.principalId === me)
    .toSorted((left, right) => DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt));

export const myPreference = (
  state: AgendaState | undefined,
  me: string | undefined,
): NotificationPreference | undefined => state?.preferences?.find((entry) => entry.principal.principalId === me);

const emailKeyOf = (entry: Notification) =>
  agendaEmailKey(entry.recipient.principalId, DateTime.formatIso(entry.createdAt));

type Translate = ReturnType<typeof useModernI18n>['t'];

const notificationEmailLabel = (
  receipt: NonNullable<ReturnType<AgendaEmailReceipts['get']>>,
  lang: ReturnType<typeof langOf>,
  t: Translate,
) => {
  if (receipt.status === 'SENT' && receipt.sentAt !== null) {
    return t(`${k}.notifications.emailSent`, { time: fmt.stamp(lang, receipt.sentAt) });
  }
  if (receipt.status === 'SKIPPED') {
    return t(`${k}.notifications.emailSkipped`);
  }
  if (receipt.status === 'FAILED' || receipt.status === 'UNKNOWN') {
    return t(`${k}.notifications.emailFailed`);
  }
  return t(`${k}.notifications.emailPending`);
};

const providerPillOf = (provider: EmailProviderState, t: Translate) => {
  if (provider.kind === 'ready' && provider.provider.configured) {
    return <Pill tone="success">{t(`${k}.settings.emailOn`)}</Pill>;
  }
  if (provider.kind === 'loading') {
    return null;
  }
  return <Pill tone="warning">{t(`${k}.settings.emailOff`)}</Pill>;
};

const providerTextOf = (provider: EmailProviderState, address: string, t: Translate) => {
  if (provider.kind === 'loading') {
    return t(`${k}.settings.emailChecking`);
  }
  if (provider.kind === 'unavailable') {
    return t(`${k}.settings.emailUnknown`);
  }
  return provider.provider.configured
    ? t(`${k}.settings.emailReal`, { address, provider: provider.provider.label ?? 'SMTP' })
    : t(`${k}.settings.emailNotConfigured`);
};

const exportListLabel = (list: string, t: Translate) => {
  if (list.startsWith('overview:')) {
    return t(`${k}.kpi.${list.slice('overview:'.length)}.label`);
  }
  if (list === 'search') {
    return t(`${k}.search.label`);
  }
  return list === 'calendar' ? t(`${k}.tabs.kalendar`) : t(`${k}.exportsLog.other`);
};

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
  readonly onMarkRead: (id: Notification['id']) => void;
  readonly state: AgendaState | undefined;
}) => {
  const { language, t } = useModernI18n();
  const people = useAgendaPeople();
  const personOf = (id: string | undefined) => people.find((person) => person.principalId === id);
  const lang = langOf(language);
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const all = myNotifications(state, me);
  const unread = all.filter((entry) => entry.readAt === undefined);
  const rows = filter === 'unread' ? unread : all;
  const emailOn = myPreference(state, me)?.emailOptIn === true;
  const receipts = useAgendaEmailReceipts(emailOn ? rows.slice(0, 100).map(emailKeyOf) : []);
  return (
    <SectionCard
      actions={
        <>
          <div className="inline-flex rounded-lg bg-surface p-0.5">
            {(['all', 'unread'] as const).map((value) => (
              <Button
                aria-pressed={filter === value}
                className={`rounded-md border-0 px-3 py-1 text-sm font-medium text-inherit ${filter === value ? 'bg-base shadow-sm' : 'bg-transparent'}`}
                composition
                key={value}
                onClick={() => setFilter(value)}
                size="current"
                unstyled
              >
                {t(`${k}.notifications.filter.${value}`, { count: value === 'all' ? all.length : unread.length })}
              </Button>
            ))}
          </div>
          {canWrite && (
            <>
              <Button appearance="outline" isLoading={busy} onClick={onCheck} severity="secondary" size="sm">
                {t(`${k}.notifications.check`)}
              </Button>
              <Button disabled={unread.length === 0} onClick={onMarkAll} severity="primary" size="sm">
                {t(`${k}.notifications.markAll`)}
              </Button>
            </>
          )}
        </>
      }
      title={t(`${k}.notifications.title`)}
    >
      <p className="m-0 text-xs text-fg-secondary">
        {canWrite ? t(`${k}.notifications.explain`) : t(`${k}.notifications.readOnly`)}
      </p>
      {rows.length === 0 ? (
        <EmptyState
          description={t(`${k}.notifications.emptyDescription`)}
          title={filter === 'unread' ? t(`${k}.notifications.emptyUnread`) : t(`${k}.notifications.empty`)}
        />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="notification-list">
          {rows.map((entry) => {
            const tone = notificationTone[entry.category];
            const isUnread = entry.readAt === undefined;
            const from = personOf(entry.createdBy.principalId);
            return (
              <li
                className={[
                  'items-start gap-3 rounded-lg border p-3',
                  ...(isUnread
                    ? [toneColors(tone).tint, toneColors(tone).ringBorder]
                    : ['border-transparent bg-surface']),
                ].join(' ')}
                data-event-key={entry.eventKey}
                data-unread={isUnread}
                key={entry.id}
              >
                <IconBadge name={notificationIcon[entry.category]} size={36} tone={tone} />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill solid={isUnread} tone={tone}>
                      {t(`${k}.notifications.category.${entry.category}`)}
                    </Pill>
                    <span className="w-full font-medium">{entry.title}</span>
                  </div>
                  <span className="text-xs text-fg-secondary">
                    {[
                      t(`${k}.sources.${entry.source}`),
                      entry.dueDate === undefined
                        ? undefined
                        : t(`${k}.notifications.due`, { date: fmt.short(lang, entry.dueDate) }),
                      entry.detail === undefined
                        ? undefined
                        : t(`${k}.category.${entry.detail}`, { defaultValue: entry.detail }),
                      from === undefined || entry.category !== 'ASSIGNED' || entry.source === 'work'
                        ? undefined
                        : t(`${k}.notifications.from`, { who: from.displayName }),
                      fmt.stamp(lang, DateTime.formatIso(entry.createdAt)),
                    ]
                      .filter((part) => part !== undefined)
                      .join(' · ')}
                  </span>
                </div>
                <div className="">
                  {entry.href !== undefined && (
                    <Link
                      className="inline-flex items-center gap-1 text-sm font-medium text-inherit no-underline"
                      href={`/${lang}${entry.href}`}
                      size="current"
                    >
                      {t(`${k}.open`)}
                      <Icon name="arrowRight" size={14} />
                    </Link>
                  )}
                  {isUnread && canWrite && (
                    <Button appearance="ghost" onClick={() => onMarkRead(entry.id)} severity="secondary" size="sm">
                      {t(`${k}.notifications.markRead`)}
                    </Button>
                  )}
                  {(() => {
                    const receipt = receipts.get(emailKeyOf(entry));
                    if (receipt === undefined) {
                      return null;
                    }
                    const label = notificationEmailLabel(receipt, lang, t);
                    return (
                      <span
                        className="inline-flex items-center gap-1 text-xs text-fg-secondary"
                        data-testid="notification-email"
                      >
                        <Icon name="mail" size={14} />
                        {label}
                      </span>
                    );
                  })()}
                  {!isUnread && entry.readAt !== undefined && (
                    <span className="inline-flex items-center gap-1 text-xs text-fg-secondary">
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

const addDaysBack = (today: string) => `${today.slice(0, 8)}01`;

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
  const people = useAgendaPeople();
  const personOf = (id: string | undefined) => people.find((person) => person.principalId === id);
  const lang = langOf(language);
  const mine = deadlines.filter((row) => row.ownerPrincipalId === me && !row.done);
  const tasks = mine.filter((row) => row.category === 'task');
  const events = mine.filter((row) => row.category === 'event' && row.date >= addDaysBack(today));
  const overdue = mine.filter((row) => row.date < today);
  const todayRows = mine.filter((row) => row.date === today);
  const week = mine.filter((row) => row.date >= today && daysUntil(row.date, today) <= 7);
  const unread = myNotifications(state, me).filter((entry) => entry.readAt === undefined);
  const person = personOf(me);
  const list = (rows: readonly Deadline[], empty: string) =>
    rows.length === 0 ? (
      <p className="m-0 text-sm text-fg-secondary">{empty}</p>
    ) : (
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {rows.slice(0, 12).map((row) => {
          const urgency = urgencyOf(row, today);
          return (
            <li key={row.key}>
              <Button
                className="block w-full rounded-lg border-0 bg-surface px-2 py-2 text-left text-inherit hover:shadow-sm"
                composition
                data-key={row.key}
                onClick={() => onOpen(row)}
                size="current"
                unstyled
              >
                <span className="flex items-center gap-3">
                  <span
                    className={`flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-lg text-xs font-semibold ${toneColors(urgencyTone[urgency]).tint} ${toneColors(urgencyTone[urgency]).fg}`}
                  >
                    <span className="text-base leading-none">{Number(row.date.slice(8, 10))}</span>
                    <span className="text-[10px] uppercase">{fmt.weekday(lang, row.date)}</span>
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{row.title}</span>
                    <span className="truncate text-xs text-fg-secondary">
                      {row.location ?? t(`${k}.sources.${row.source}`)}
                    </span>
                  </span>
                  <Pill tone={urgencyTone[urgency]}>{t(`${k}.urgency.${urgency}`)}</Pill>
                </span>
              </Button>
            </li>
          );
        })}
      </ul>
    );
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-sm text-fg-secondary">
        {t(`${k}.mine.intro`, { who: person?.displayName ?? t(`${k}.mine.you`) })}
      </p>
      <StatRow>
        <StatCard label={t(`${k}.mine.overdue`)} value={formatNumber(overdue.length)} />
        <StatCard label={t(`${k}.mine.today`)} value={formatNumber(todayRows.length)} />
        <StatCard label={t(`${k}.mine.week`)} value={formatNumber(week.length)} />
        <StatCard label={t(`${k}.mine.unread`)} value={formatNumber(unread.length)} />
      </StatRow>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard
          actions={
            <Link className="text-sm font-medium text-inherit no-underline" href={`/${lang}/ukoly`} size="current">
              {t(`${k}.mine.allTasks`)}
            </Link>
          }
          title={t(`${k}.mine.tasks`, { count: tasks.length })}
        >
          {workStatus === 'ready' ? (
            list(tasks, t(`${k}.mine.noTasks`))
          ) : (
            <p className="m-0 text-sm text-fg-secondary">{t(`${k}.state.${workStatus}`)}</p>
          )}
        </SectionCard>
        <SectionCard title={t(`${k}.mine.events`, { count: events.length })}>
          {list(events, t(`${k}.mine.noEvents`))}
        </SectionCard>
      </div>
      <SectionCard title={t(`${k}.mine.byCategory`)}>
        <div className="flex flex-wrap gap-2">
          {[...new Set(mine.map((row) => row.category))].map((category) => (
            <Pill key={category} tone={categoryTone[category]}>
              {t(`${k}.category.${category}`)}: {mine.filter((row) => row.category === category).length}
            </Pill>
          ))}
          {mine.length === 0 && <span className="text-sm text-fg-secondary">{t(`${k}.mine.nothing`)}</span>}
        </div>
      </SectionCard>
    </div>
  );
};

// ---- Settings + export log ---------------------------------------------------------------------------------------

type OptionalCategory = (typeof OPTIONAL_EMAIL_CATEGORIES)[number];

/** The notification settings as the form edits them; `optional` lists the chosen optional categories in order. */
export interface PreferenceDraft {
  readonly email: boolean;
  readonly leadDays: string;
  readonly optional: readonly OptionalCategory[];
}

const preferenceDraftOf = (current: NotificationPreference | undefined): PreferenceDraft => ({
  email: current?.emailOptIn ?? false,
  leadDays: String(current?.leadDays ?? DEFAULT_LEAD_DAYS),
  optional: OPTIONAL_EMAIL_CATEGORIES.filter(
    (category) => current?.emailCategories === undefined || current.emailCategories.includes(category),
  ),
});

const samePreferenceDraft = (left: PreferenceDraft, right: PreferenceDraft): boolean =>
  left.email === right.email &&
  left.leadDays === right.leadDays &&
  left.optional.length === right.optional.length &&
  left.optional.every((category, index) => category === right.optional[index]);

const leadDayChoices = ['3', '7', '14', '30', '60'];

/**
 * The notification settings as the panel edits them: the lead time, whether e-mail is on and the categories e-mailed
 * (the mandatory ones always ticked). Uložit sends the draft through the save bar, so the form itself submits nothing.
 */
const preferencesForm = FormReact.make(
  // The e-mail switch is the `AgendaPreferencesSet` payload's own field.
  fromPayload(agendaCommandSchemas[6].mapFields(Struct.pick(['emailOptIn'])))
    .addField('emailCategories', Schema.Array(NotificationCategorySchema))
    .addField('leadDays', Schema.String),
  {
    fields: {
      emailCategories: makeMemberCheckboxField((category: NotificationCategory) => category),
      emailOptIn: SwitchField,
      leadDays: ChoiceField,
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);

type PreferenceValues = typeof preferencesForm.schema.Encoded;

const preferenceValuesOf = (draft: PreferenceDraft): PreferenceValues => ({
  emailCategories: [...MANDATORY_EMAIL_CATEGORIES, ...draft.optional],
  emailOptIn: draft.email,
  leadDays: draft.leadDays,
});

const preferenceDraftFrom = (values: PreferenceValues): PreferenceDraft => ({
  email: values.emailOptIn,
  leadDays: values.leadDays === '' ? String(DEFAULT_LEAD_DAYS) : values.leadDays,
  optional: OPTIONAL_EMAIL_CATEGORIES.filter((category) => values.emailCategories.includes(category)),
});

export const SettingsPanel = ({
  canWrite,
  me,
  onSave,
  state,
}: {
  readonly canWrite: boolean;
  readonly me: string | undefined;
  readonly onSave: (value: PreferenceDraft) => Effect.Effect<SaveOutcome>;
  /** The agenda read; undefined while it loads. */
  readonly state?: AgendaState | undefined;
}) => {
  const { language, t } = useModernI18n();
  const people = useAgendaPeople();
  const personOf = (id: string | undefined) => people.find((person) => person.principalId === id);
  const lang = langOf(language);
  const current = myPreference(state, me);
  // Nothing is sent until Uložit; a clean draft follows the reloaded preferences.
  const record = useRecordDraft<PreferenceDraft, never>({
    equals: samePreferenceDraft,
    isValid: () => true,
    runtime: browserRuntime,
    save: (value) => onSave(value),
    server: preferenceDraftOf(current),
  });
  const { draft, setDraft } = record;
  const shown = useAtomValue(preferencesForm.values);
  const setValues = useAtomSet(preferencesForm.setValues);
  // The fields are the draft: a change in the form changes it at once.
  useAtomSubscribe(
    preferencesForm.values,
    (next) => {
      if (Option.isSome(next)) {
        setDraft(preferenceDraftFrom(next.value));
      }
    },
    { immediate: false },
  );
  // The draft also moves without the form (a newer read while nothing is pending, Zahodit změny, the latest version):
  // the fields follow it.
  const shownDraft = useRef(draft);
  useEffect(() => {
    if (shownDraft.current === draft) {
      return;
    }
    shownDraft.current = draft;
    if (Option.exists(shown, (values) => !samePreferenceDraft(preferenceDraftFrom(values), draft))) {
      setValues(preferenceValuesOf(draft));
    }
  }, [draft, setValues, shown]);
  const labels = saveLabelsFor(language);
  const guard = useEditGuard(record, record.discard);
  const provider = useEmailProvider();
  const address = t(`${k}.settings.yourAddress`);
  const providerPill = providerPillOf(provider, t);
  const providerText = providerTextOf(provider, address, t);
  const exports = (state?.exports ?? [])
    .toSorted((left, right) => DateTime.toEpochMillis(right.exportedAt) - DateTime.toEpochMillis(left.exportedAt))
    .slice(0, 25);
  const handleReloadLatest = record.reloadLatest;
  const handleSave = record.save;
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
      <div className="xl:col-span-2">
        <SectionCard title={t(`${k}.settings.title`)}>
          <div className="flex flex-col gap-4">
            <FormRoot
              className="flex flex-col gap-4"
              defaultValues={preferenceValuesOf(draft)}
              form={preferencesForm}
              translateMessage={(message) => t(message)}
            >
              <preferencesForm.leadDays
                disabled={!canWrite}
                items={leadDayChoices.map((value) => ({
                  label: t(`${k}.settings.days`, { count: Number(value) }),
                  value,
                }))}
                label={t(`${k}.settings.leadDays`)}
              />
              <div className="flex flex-col gap-1">
                <preferencesForm.emailOptIn disabled={!canWrite}>{t(`${k}.settings.email`)}</preferencesForm.emailOptIn>
                <span
                  className="flex flex-col items-start gap-1 text-xs text-fg-secondary"
                  data-testid="email-provider"
                >
                  {providerPill}
                  <span>{providerText}</span>
                </span>
              </div>
              {draft.email && (
                <fieldset className="m-0 flex flex-col gap-2 border-0 p-0" data-testid="email-events">
                  <legend className="mb-1 p-0 text-sm font-medium">{t(`${k}.settings.emailEvents`)}</legend>
                  {MANDATORY_EMAIL_CATEGORIES.map((category) => (
                    <preferencesForm.emailCategories
                      disabled
                      helpText={t(`${k}.settings.mandatory`)}
                      id={`email-category-${category}`}
                      key={category}
                      label={t(`${k}.notifications.category.${category}`)}
                      member={category}
                    />
                  ))}
                  {OPTIONAL_EMAIL_CATEGORIES.map((category) => (
                    <preferencesForm.emailCategories
                      disabled={!canWrite}
                      id={`email-category-${category}`}
                      key={category}
                      label={t(`${k}.notifications.category.${category}`)}
                      member={category}
                    />
                  ))}
                  <span className="text-xs text-fg-secondary">{t(`${k}.settings.optionalHint`)}</span>
                </fieldset>
              )}
            </FormRoot>
            <p className="m-0 text-xs text-fg-secondary">
              {current === undefined
                ? t(`${k}.settings.default`, { count: DEFAULT_LEAD_DAYS })
                : t(`${k}.settings.savedAt`, { time: fmt.stamp(lang, DateTime.formatIso(current.updatedAt)) })}
            </p>
            {canWrite && (
              <>
                <SaveBar
                  labels={labels}
                  onReloadLatest={handleReloadLatest}
                  onSave={handleSave}
                  size="sm"
                  status={record.status}
                />
                <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
              </>
            )}
          </div>
        </SectionCard>
      </div>
      <div className="xl:col-span-3">
        <SectionCard title={t(`${k}.exportsLog.title`)}>
          {exports.length === 0 ? (
            <EmptyState description={t(`${k}.exportsLog.emptyDescription`)} title={t(`${k}.exportsLog.empty`)} />
          ) : (
            <table className="w-full border-collapse text-sm" data-testid="export-log">
              <thead>
                <tr className="text-left text-fg-secondary">
                  <th className="px-2 py-1.5 font-medium">{t(`${k}.exportsLog.when`)}</th>
                  <th className="px-2 py-1.5 font-medium">{t(`${k}.exportsLog.who`)}</th>
                  <th className="px-2 py-1.5 font-medium">{t(`${k}.exportsLog.list`)}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t(`${k}.exportsLog.rows`)}</th>
                </tr>
              </thead>
              <tbody>
                {exports.map((entry) => (
                  <tr className="border-t border-border-primary/60" key={entry.id}>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      {fmt.stamp(lang, DateTime.formatIso(entry.exportedAt))}
                    </td>
                    <td className="px-2 py-1.5">{personOf(entry.exportedBy.principalId)?.displayName ?? ''}</td>
                    <td className="px-2 py-1.5">
                      <div>{exportListLabel(entry.list, t)}</div>
                      {entry.filter !== undefined && !entry.filter.startsWith('kpi=') && (
                        <div className="text-xs text-fg-secondary">{entry.filter}</div>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{entry.rowCount}</td>
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
