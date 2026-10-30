// Facility operations — Moje agenda (S13). OWNED BY THE `agenda` LANE (ops-agenda).
// Tabs: shared calendar (month/week/list, read from source modules), Moje agenda (per person), notification centre
// (deduplicated in-app notices), settings + export log.
import type { ModulePageContext, ModulePageProps } from '@app/shared-contracts/page-data';
import { Effect, Option, Schema, SchemaGetter } from 'effect';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import type { Notification } from '../../../../../shared/domain/agenda.ts';
import { AgendaPeopleContext } from '../../../../ui/ops-agenda/agenda-people.tsx';
import { PageHeader } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { Tabs } from '@techsio/ui-kit/molecules/tabs';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { DEFAULT_LEAD_DAYS } from '../../../../../shared/domain/agenda.ts';
import { AgendaFrame } from '../../../../ui/agenda-frame.tsx';
import { notificationCandidates, taskAssignmentCandidates, pragueToday } from '../../../../ui/ops-agenda/deadlines.ts';
import type { Deadline } from '../../../../../shared/domain/ops-overview.ts';
import { currentAgendaState, buildDeadlines, agendaPeople } from '../../../../ui/ops-agenda/model.ts';
import { allSettled, useRentalOverviewSources } from '../../../../ui/ops-agenda/sources.ts';
import { SourceHealth } from '../prehled/dashboard-parts.tsx';
import { useAgendaCommands } from '../../../../ui/ops-agenda/use-agenda-commands.ts';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import { CalendarModeSchema, CalendarView } from './calendar.tsx';
import type { CalendarMode } from './calendar.tsx';
import { CreateEventPanel, DeadlinePanel } from './event-panel.tsx';
import { MyAgenda, NotificationCenter, SettingsPanel, myNotifications, myPreference } from './inbox.tsx';

const tabs = ['kalendar', 'moje', 'notifikace', 'nastaveni'] as const;
const TabSchema = Schema.Literals(tabs);
type Tab = typeof TabSchema.Type;
const k = 'facility-operations.agenda';

const AgendaSearchSchema = Schema.Struct({
  event: Schema.optionalKey(Schema.String.pipe(Schema.brand('AgendaRouteEventId'))),
  filtr: Schema.optionalKey(Schema.String),
  tab: Schema.optionalKey(Schema.String),
  view: Schema.optionalKey(Schema.String),
});
const queryString = Schema.toCodecJson(Schema.URLSearchParams);
const AgendaQuerySchema = queryString.pipe(
  Schema.decodeTo<typeof AgendaSearchSchema, typeof queryString>(AgendaSearchSchema, {
    decode: SchemaGetter.transform((params) => {
      const search: {
        -readonly [Key in keyof typeof AgendaSearchSchema.Encoded]: (typeof AgendaSearchSchema.Encoded)[Key];
      } = {};
      for (const key of ['event', 'filtr', 'tab', 'view'] as const) {
        const value = params.get(key);
        if (value !== null) {
          search[key] = value;
        }
      }
      return search;
    }),
    encode: SchemaGetter.encodeURLSearchParams(),
  }),
);

const initialAgendaLocation = (search: string) => {
  const input = Option.match(Schema.decodeOption(AgendaQuerySchema)(search), {
    onNone: (): typeof AgendaSearchSchema.Type => ({}),
    onSome: (value) => value,
  });
  const tab: Tab = Schema.is(TabSchema)(input.tab) ? input.tab : 'kalendar';
  const overdue = input.filtr === 'po-terminu';
  let mode: CalendarMode = 'mesic';
  if (Schema.is(CalendarModeSchema)(input.view)) {
    mode = input.view;
  }
  if (overdue) {
    mode = 'seznam';
  }
  return { event: input.event === '' ? undefined : input.event, mode, overdue, tab };
};

interface DeliveryContext {
  readonly deadlines: readonly Deadline[];
  readonly leadDays: number;
  readonly me: string | undefined;
  readonly run: ReturnType<typeof useAgendaCommands>['run'];
  readonly state: ReturnType<typeof currentAgendaState>;
  readonly today: string;
  readonly workItems: Parameters<typeof taskAssignmentCandidates>[0];
}

const deliverNotifications = Effect.fn('FacilityOperations.AgendaPage.deliver')(function* deliverNotifications(
  all: boolean,
  context: DeliveryContext,
) {
  const candidates = [
    ...taskAssignmentCandidates(context.workItems, context.me),
    ...notificationCandidates(context.deadlines, context.today, context.leadDays, context.me),
  ];
  const known = new Set(myNotifications(context.state, context.me).map((entry) => entry.eventKey));
  const items = (all ? candidates : candidates.filter((entry) => !known.has(entry.eventKey))).slice(0, 200);
  if (items.length === 0) {
    return { delivered: 0, duplicates: 0, offered: 0 };
  }
  const outcome = yield* context.run({ _tag: 'AgendaNotificationsDeliver', items });
  const delivered = outcome.ok ? outcome.result.entityIds.length : 0;
  return {
    delivered,
    duplicates: outcome.ok ? items.length - delivered : 0,
    failed: !outcome.ok,
    offered: items.length,
  };
});

const useAgendaView = ({ context }: { readonly context: ModulePageContext | undefined }) => {
  const { t } = useModernI18n();
  const toast = useToast();
  const { names, reload, sources } = useRentalOverviewSources();
  const commands = useAgendaCommands(sources, reload);
  const search = useRouterState({ select: (router) => router.location.searchStr });
  const [view, setView] = useState(() => ({ ...initialAgendaLocation(search), today: pragueToday() }));
  const { mode, overdue: overdueFilter, tab, today } = view;
  const [openKey, setOpenKey] = useState<string | undefined>();
  const [requestedEvent, setRequestedEvent] = useState<string | undefined>(() => view.event);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const synced = useRef(false);

  const deadlines = buildDeadlines(sources, names);
  // Consume a deep link once its event arrives, before committing a stale selection to the screen.
  if (requestedEvent !== undefined && deadlines.some((row) => row.eventId === requestedEvent)) {
    setOpenKey(`event:${requestedEvent}`);
    setRequestedEvent(undefined);
  }
  const state = currentAgendaState(sources, deadlines, today);
  const me = sources.ops.data?.actorPrincipalRef.principalId;
  const settled = allSettled(sources);
  const unread = myNotifications(state, me).filter((entry) => entry.readAt === undefined).length;
  const leadDays = myPreference(state, me)?.leadDays ?? DEFAULT_LEAD_DAYS;

  const openRow = (row: Deadline) => setOpenKey(row.eventId === undefined ? row.key : `event:${row.eventId}`);

  const changeTab = (next: Tab) => {
    setView((current) => ({ ...current, tab: next }));
    if (globalThis.window !== undefined) {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', next);
      window.history.replaceState(window.history.state, '', url);
    }
  };

  const deliveryContext: DeliveryContext = {
    deadlines,
    leadDays,
    me,
    run: commands.run,
    state,
    today,
    workItems: sources.work.data?.items ?? [],
  };
  const deliverAutomatically = useEffectEvent(() => {
    browserRuntime.runFork(
      deliverNotifications(false, deliveryContext).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            if (result.delivered > 0) {
              toast.create({ title: t(`${k}.notifications.newToast`, { count: result.delivered }), type: 'info' });
            }
          }),
        ),
      ),
    );
  });
  useEffect(() => {
    if (!settled || synced.current || !commands.canWrite || me === undefined) {
      return;
    }
    synced.current = true;
    deliverAutomatically();
  }, [settled, commands.canWrite, me]);

  const check = () => {
    setBusy(true);
    browserRuntime.runFork(
      deliverNotifications(true, deliveryContext).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            setBusy(false);
            if (result.failed === true) {
              toast.create({ title: t('facility-operations.common.errors.unavailable'), type: 'error' });
              return;
            }
            toast.create({
              description: t(`${k}.notifications.checkDescription`),
              title: t(`${k}.notifications.checkResult`, {
                delivered: result.delivered,
                duplicates: result.duplicates,
              }),
              type: result.delivered > 0 ? 'success' : 'info',
            });
          }),
        ),
      ),
    );
  };
  const markRead = (id: Notification['id']) => {
    browserRuntime.runFork(commands.run({ _tag: 'AgendaNotificationsMarkRead', notificationIds: [id] }));
  };
  const markAll = () => {
    setBusy(true);
    browserRuntime.runFork(
      commands.run({ _tag: 'AgendaNotificationsMarkAllRead' }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            setBusy(false);
          }),
        ),
      ),
    );
  };
  const savePreferences = (days: number, emailOptIn: boolean, emailCategories: readonly ('DEADLINE' | 'CHANGE')[]) => {
    setSaving(true);
    browserRuntime.runFork(
      commands.run({ _tag: 'AgendaPreferencesSet', emailCategories, emailOptIn, leadDays: days }).pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            setSaving(false);
            toast.create({
              title: outcome.ok
                ? t('facility-operations.common.saved')
                : t(`facility-operations.common.errors.${outcome.reason}`),
              type: outcome.ok ? 'success' : 'error',
            });
          }),
        ),
      ),
    );
  };

  const opened: Deadline | undefined = deadlines.find((row) =>
    openKey?.startsWith('event:') === true ? `event:${row.eventId ?? ''}` === openKey : row.key === openKey,
  );
  const agendaReadable = sources.ops.status === 'ready' && sources.ops.data?.agenda !== undefined;

  return {
    agendaReadable,
    busy,
    changeTab,
    check,
    commands,
    context,
    creating,
    deadlines,
    markAll,
    markRead,
    me,
    mode,
    opened,
    openRow,
    overdueFilter,
    savePreferences,
    saving,
    setCreating,
    setOpenKey,
    sources,
    state,
    t,
    tab,
    today,
    unread,
  };
};

const AgendaView = (props: Parameters<typeof useAgendaView>[0]) => {
  const {
    agendaReadable,
    busy,
    changeTab,
    check,
    commands,
    context,
    creating,
    deadlines,
    markAll,
    markRead,
    me,
    mode,
    opened,
    openRow,
    overdueFilter,
    savePreferences,
    saving,
    setCreating,
    setOpenKey,
    sources,
    state,
    t,
    tab,
    today,
    unread,
  } = useAgendaView(props);

  return (
    <AgendaPeopleContext value={agendaPeople(state, context)}>
      <PageHeader
        actions={
          commands.canWrite ? (
            <Button onClick={() => setCreating(true)} size="sm" variant="primary">
              {t(`${k}.create.title`)}
            </Button>
          ) : undefined
        }
        description={t(`${k}.description`)}
        meta={
          unread > 0 ? (
            <Badge size="sm" variant="warning">
              {t(`${k}.notifications.unreadBadge`, { count: unread })}
            </Badge>
          ) : undefined
        }
        title={t(`${k}.title`)}
      />
      <SourceHealth sources={sources} />
      {sources.ops.data?.agenda?.assignedOnly === true && (
        <p
          className="facilityoperations:m-0 facilityoperations:text-sm"
          style={{ color: 'var(--color-fg-secondary, #6b7280)' }}
        >
          {t(`${k}.state.readOnly`)}
        </p>
      )}
      {!agendaReadable && sources.ops.status !== 'loading' && (
        <p
          className="facilityoperations:m-0 facilityoperations:text-sm"
          style={{ color: 'var(--color-fg-secondary, #6b7280)' }}
        >
          {t(`${k}.state.agendaUnavailable`)}
        </p>
      )}
      <Tabs
        onValueChange={(value) => {
          if (Schema.is(TabSchema)(value)) {
            changeTab(value);
          }
        }}
        size="sm"
        value={tab}
        variant="line"
      >
        <Tabs.List>
          <Tabs.Trigger value="kalendar">{t(`${k}.tabs.kalendar`)}</Tabs.Trigger>
          <Tabs.Trigger value="moje">{t(`${k}.tabs.moje`)}</Tabs.Trigger>
          <Tabs.Trigger value="notifikace">
            {unread > 0 ? [t(`${k}.tabs.notifikace`), `(${unread})`].join(' ') : t(`${k}.tabs.notifikace`)}
          </Tabs.Trigger>
          <Tabs.Trigger value="nastaveni">{t(`${k}.tabs.nastaveni`)}</Tabs.Trigger>
        </Tabs.List>
      </Tabs>
      {tab === 'kalendar' && (
        <CalendarView
          agendaRevision={commands.revision}
          canLog={commands.canWrite}
          deadlines={deadlines}
          initialMode={mode}
          initialOverdue={overdueFilter}
          key={`${mode}:${overdueFilter}`}
          me={me}
          onOpen={openRow}
          sources={sources}
          today={today}
        />
      )}
      {tab === 'moje' && (
        <MyAgenda
          deadlines={deadlines}
          me={me}
          onOpen={openRow}
          state={state}
          today={today}
          workStatus={sources.work.status}
        />
      )}
      {tab === 'notifikace' && (
        <NotificationCenter
          busy={busy}
          canWrite={commands.canWrite}
          me={me}
          onCheck={() => {
            check();
          }}
          onMarkAll={() => {
            markAll();
          }}
          onMarkRead={(id) => {
            markRead(id);
          }}
          state={state}
        />
      )}
      {tab === 'nastaveni' && (
        <SettingsPanel
          canWrite={commands.canWrite}
          key={`${me ?? ''}:${myPreference(state, me)?.leadDays ?? ''}:${myPreference(state, me)?.emailOptIn ?? ''}:${(myPreference(state, me)?.emailCategories ?? []).join(',')}`}
          me={me}
          onSave={(days, email, categories) => {
            savePreferences(days, email, categories);
          }}
          saving={saving}
          state={state}
        />
      )}
      <DeadlinePanel
        canWrite={commands.canWrite}
        deadline={opened}
        onClose={() => setOpenKey(undefined)}
        onRun={(command) => commands.run(command)}
        state={state}
        today={today}
      />
      <CreateEventPanel
        initialDate={today}
        onClose={() => setCreating(false)}
        onRun={(command) => commands.run(command)}
        open={creating}
      />
    </AgendaPeopleContext>
  );
};

export const AgendaPage = ({ context }: Partial<ModulePageProps>) => (
  <AgendaFrame>
    <UltramodernRouteHead titleKey="facility-operations.agenda.title" />
    <AgendaView context={context} />
  </AgendaFrame>
);

/** The Shell awaits this before it reveals the page, so the calendar opens with its sources loaded. */
export { preloadRentalOverviewSources as preloadPage } from '../../../../ui/ops-agenda/sources.ts';
export default AgendaPage;
