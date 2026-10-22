// @effect-diagnostics asyncFunction:off globalDate:off
// Facility operations — Moje agenda (S13). OWNED BY THE `agenda` LANE (ops-agenda).
// Tabs: shared calendar (month/week/list, read from source modules), Moje agenda (per person), notification centre
// (deduplicated in-app notices), settings + export log.
import { PageHeader } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { Tabs } from '@techsio/ui-kit/molecules/tabs';
import { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_LEAD_DAYS } from '../../../../../shared/domain/agenda.ts';
import { AgendaFrame } from '../../../../ui/agenda-frame.tsx';
import { notificationCandidates, taskAssignmentCandidates, pragueToday } from '../../../../ui/ops-agenda/deadlines.ts';
import type { Deadline } from '../../../../../shared/domain/ops-overview.ts';
import { currentAgendaState, buildDeadlines } from '../../../../ui/ops-agenda/model.ts';
import { allSettled, useRentalOverviewSources } from '../../../../ui/ops-agenda/sources.ts';
import { SourceHealth } from '../prehled/dashboard-parts.tsx';
import { useAgendaCommands } from '../../../../ui/ops-agenda/use-agenda-commands.ts';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import { CalendarView } from './calendar.tsx';
import type { CalendarMode } from './calendar.tsx';
import { CreateEventPanel, DeadlinePanel } from './event-panel.tsx';
import { MyAgenda, NotificationCenter, SettingsPanel, myNotifications, myPreference } from './inbox.tsx';

type Tab = 'kalendar' | 'moje' | 'notifikace' | 'nastaveni';
const tabs: readonly Tab[] = ['kalendar', 'moje', 'notifikace', 'nastaveni'];
const k = 'facility-operations.agenda';

const params = () => (typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search));

const AgendaView = () => {
  const { t } = useModernI18n();
  const toast = useToast();
  const { names, reload, sources } = useRentalOverviewSources();
  const commands = useAgendaCommands(sources, reload);
  const [today] = useState(() => pragueToday());
  const [tab, setTab] = useState<Tab>('kalendar');
  const [mode, setMode] = useState<CalendarMode>('mesic');
  const [overdueFilter, setOverdueFilter] = useState(false);
  const [openKey, setOpenKey] = useState<string | undefined>(undefined);
  const [requestedEvent, setRequestedEvent] = useState<string | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const synced = useRef(false);

  useEffect(() => {
    const search = params();
    const requested = tabs.find((value) => value === search.get('tab'));
    if (requested !== undefined) {
      setTab(requested);
    }
    const view = search.get('view');
    if (view === 'tyden' || view === 'seznam' || view === 'mesic') {
      setMode(view);
    }
    if (search.get('filtr') === 'po-terminu') {
      setOverdueFilter(true);
      setMode('seznam');
    }
    const event = search.get('event');
    if (event !== null && event !== '') {
      setRequestedEvent(event);
    }
  }, []);

  const deadlines = useMemo(() => buildDeadlines(sources, names), [sources, names]);
  const state = useMemo(() => currentAgendaState(sources, deadlines, today), [sources, deadlines, today]);
  const me = sources.ops.data?.actorPrincipalRef.principalId;
  const settled = allSettled(sources);
  const unread = myNotifications(state, me).filter((entry) => entry.readAt === undefined).length;
  const leadDays = myPreference(state, me)?.leadDays ?? DEFAULT_LEAD_DAYS;

  useEffect(() => {
    if (requestedEvent === undefined) {
      return;
    }
    const match = deadlines.find((row) => row.eventId === requestedEvent);
    if (match !== undefined) {
      setOpenKey(`event:${requestedEvent}`);
      setRequestedEvent(undefined);
    }
  }, [requestedEvent, deadlines]);

  const openRow = (row: Deadline) => setOpenKey(row.eventId === undefined ? row.key : `event:${row.eventId}`);

  const changeTab = (next: Tab) => {
    setTab(next);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', next);
      window.history.replaceState(window.history.state, '', url);
    }
  };

  /** Sync readable native assignments as well as deadlines; the reducer persists and deduplicates both. */
  const deliver = async (all: boolean) => {
    const candidates = [...taskAssignmentCandidates(sources.work.data?.items ?? [], me), ...notificationCandidates(deadlines, today, leadDays, me)];
    const known = new Set(myNotifications(state, me).map((entry) => entry.eventKey));
    const items = (all ? candidates : candidates.filter((entry) => !known.has(entry.eventKey))).slice(0, 200);
    if (items.length === 0) {
      return { duplicates: 0, offered: 0, delivered: 0 };
    }
    const outcome = await commands.run({ _tag: 'AgendaNotificationsDeliver', items });
    const delivered = outcome.ok ? outcome.result.entityIds.length : 0;
    return { delivered, duplicates: outcome.ok ? items.length - delivered : 0, offered: items.length, failed: !outcome.ok };
  };

  useEffect(() => {
    if (!settled || synced.current || !commands.canWrite || me === undefined) {
      return;
    }
    synced.current = true;
    void deliver(false).then((result) => {
      if (result.delivered > 0) {
        toast.create({ title: t(`${k}.notifications.newToast`, { count: result.delivered }), type: 'info' });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, commands.canWrite, me]);

  const check = async () => {
    setBusy(true);
    const result = await deliver(true);
    setBusy(false);
    if (result.failed === true) {
      toast.create({ title: t('facility-operations.common.errors.unavailable'), type: 'error' });
      return;
    }
    toast.create({
      description: t(`${k}.notifications.checkDescription`),
      title: t(`${k}.notifications.checkResult`, { delivered: result.delivered, duplicates: result.duplicates }),
      type: result.delivered > 0 ? 'success' : 'info',
    });
  };

  const markRead = async (id: string) => {
    await commands.run({ _tag: 'AgendaNotificationsMarkRead', notificationIds: [id] } as never);
  };
  const markAll = async () => {
    setBusy(true);
    await commands.run({ _tag: 'AgendaNotificationsMarkAllRead' });
    setBusy(false);
  };
  const savePreferences = async (days: number, emailOptIn: boolean, emailCategories: readonly ('DEADLINE' | 'CHANGE')[]) => {
    setSaving(true);
    const outcome = await commands.run({ _tag: 'AgendaPreferencesSet', emailCategories, emailOptIn, leadDays: days });
    setSaving(false);
    toast.create({ title: outcome.ok ? t('facility-operations.common.saved') : t(`facility-operations.common.errors.${outcome.reason}`), type: outcome.ok ? 'success' : 'error' });
  };

  const opened: Deadline | undefined = deadlines.find((row) =>
    openKey?.startsWith('event:') === true ? `event:${row.eventId ?? ''}` === openKey : row.key === openKey,
  );
  const agendaReadable = sources.ops.status === 'ready' && sources.ops.data?.agenda !== undefined;

  return (
    <>
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
        <p className="facilityoperations:m-0 facilityoperations:text-sm" style={{ color: 'var(--color-fg-secondary, #6b7280)' }}>
          {t(`${k}.state.readOnly`)}
        </p>
      )}
      {!agendaReadable && sources.ops.status !== 'loading' && (
        <p className="facilityoperations:m-0 facilityoperations:text-sm" style={{ color: 'var(--color-fg-secondary, #6b7280)' }}>
          {t(`${k}.state.agendaUnavailable`)}
        </p>
      )}
      <Tabs onValueChange={(value) => changeTab(value as Tab)} size="sm" value={tab} variant="line">
        <Tabs.List>
          <Tabs.Trigger value="kalendar">{t(`${k}.tabs.kalendar`)}</Tabs.Trigger>
          <Tabs.Trigger value="moje">{t(`${k}.tabs.moje`)}</Tabs.Trigger>
          <Tabs.Trigger value="notifikace">{unread > 0 ? `${t(`${k}.tabs.notifikace`)} (${unread})` : t(`${k}.tabs.notifikace`)}</Tabs.Trigger>
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
        <MyAgenda deadlines={deadlines} me={me} onOpen={openRow} state={state} today={today} workStatus={sources.work.status} />
      )}
      {tab === 'notifikace' && (
        <NotificationCenter
          busy={busy}
          canWrite={commands.canWrite}
          me={me}
          onCheck={() => void check()}
          onMarkAll={() => void markAll()}
          onMarkRead={(id) => void markRead(id)}
          state={state}
        />
      )}
      {tab === 'nastaveni' && (
        <SettingsPanel
          canWrite={commands.canWrite}
          key={`${me ?? ''}:${myPreference(state, me)?.leadDays ?? ''}:${myPreference(state, me)?.emailOptIn ?? ''}:${(myPreference(state, me)?.emailCategories ?? []).join(',')}`}
          me={me}
          onSave={(days, email, categories) => void savePreferences(days, email, categories)}
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
      <CreateEventPanel initialDate={today} onClose={() => setCreating(false)} onRun={(command) => commands.run(command)} open={creating} />
    </>
  );
};

export const AgendaPage = () => (
  <AgendaFrame>
    <UltramodernRouteHead titleKey="facility-operations.agenda.title" />
    <AgendaView />
  </AgendaFrame>
);

export default AgendaPage;
