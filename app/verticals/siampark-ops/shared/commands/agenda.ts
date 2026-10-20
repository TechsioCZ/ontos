// Siampark provoz — commands of agenda `agenda` (S13 kalendář, notifikace, Moje agenda + S15 přehled, vyhledávání, export).
// OWNED BY THE `agenda` LANE (ops-agenda). Tags are prefixed `Agenda…` (globally unique across agendas).
//
// Rules the reducer enforces (pure, unit-tested in tests/unit/agenda-commands.test.ts):
//   - own calendar events can be created, rescheduled, reassigned, completed and cancelled;
//   - assigning someone (other than yourself) notifies them once; rescheduling notifies the assignee once per new date;
//   - AgendaNotificationsDeliver stores at most ONE notification per (recipient, eventKey): repeated delivery of the
//     same source event is a no-op (S13-03), also within one batch;
//   - a person can mark only their own notifications read;
//   - every CSV export is logged (who, which list, row count, filter).
import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import type { PrincipalRef } from '@app/core-runtime/permissions/principal-ref';
import { Effect, Match, Schema } from 'effect';
import {
  auditCreated,
  auditUpdated,
  defineAgenda,
  entityIdOf,
  IsoDateSchema,
  mintId,
  NoteSchema,
  opsConflict,
  opsNotFound,
  PropertyRefSchema,
  TextSchema,
} from '../domain/common.ts';
import type { EntityId, OpsCommandInput } from '../domain/common.ts';
import {
  AgendaStateSchema,
  CalendarEventIdSchema,
  CalendarEventKindSchema,
  CalendarEventStatusSchema,
  EventKeySchema,
  ExportRecordSchema,
  LeadDaysSchema,
  MAX_EXPORTS,
  MAX_NOTIFICATIONS,
  NotificationCategorySchema,
  NotificationIdSchema,
  emptyAgendaState,
} from '../domain/agenda.ts';
import type { AgendaState, CalendarEvent, ExportRecord, Notification, NotificationPreference } from '../domain/agenda.ts';

/** One source event offered for delivery to the acting person's inbox. */
export const NotificationDeliveryItemSchema = Schema.Struct({
  eventKey: EventKeySchema,
  category: NotificationCategorySchema,
  title: TextSchema(300),
  detail: Schema.optionalKey(TextSchema(500)),
  source: TextSchema(80),
  href: Schema.optionalKey(TextSchema(500)),
  dueDate: Schema.optionalKey(IsoDateSchema),
});
export type NotificationDeliveryItem = typeof NotificationDeliveryItemSchema.Type;

export const agendaCommandSchemas = [
  Schema.TaggedStruct('AgendaEventCreate', {
    title: TextSchema(300),
    date: IsoDateSchema,
    kind: CalendarEventKindSchema,
    related: Schema.optionalKey(PropertyRefSchema),
    assignee: Schema.optionalKey(PrincipalRefSchema),
    assigneeLabel: Schema.optionalKey(TextSchema(200)),
    note: Schema.optionalKey(NoteSchema),
  }),
  Schema.TaggedStruct('AgendaEventUpdate', {
    eventId: CalendarEventIdSchema,
    title: Schema.optionalKey(TextSchema(300)),
    date: Schema.optionalKey(IsoDateSchema),
    kind: Schema.optionalKey(CalendarEventKindSchema),
    /** `null` removes the link. */
    related: Schema.optionalKey(Schema.NullOr(PropertyRefSchema)),
    /** `null` removes the assignee. */
    assignee: Schema.optionalKey(Schema.NullOr(PrincipalRefSchema)),
    assigneeLabel: Schema.optionalKey(TextSchema(200)),
    note: Schema.optionalKey(NoteSchema),
    status: Schema.optionalKey(CalendarEventStatusSchema),
  }),
  Schema.TaggedStruct('AgendaNotificationsDeliver', {
    items: Schema.Array(NotificationDeliveryItemSchema).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  }),
  Schema.TaggedStruct('AgendaNotificationsMarkRead', {
    notificationIds: Schema.Array(NotificationIdSchema).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  }),
  Schema.TaggedStruct('AgendaNotificationsMarkAllRead', {}),
  Schema.TaggedStruct('AgendaExportRecord', {
    list: ExportRecordSchema.fields.list,
    rowCount: ExportRecordSchema.fields.rowCount,
    filter: Schema.optionalKey(TextSchema(500)),
  }),
  Schema.TaggedStruct('AgendaPreferencesSet', {
    leadDays: LeadDaysSchema,
    emailOptIn: Schema.Boolean,
  }),
] as const;

export const AgendaCommandSchema = Schema.Union(agendaCommandSchemas);
export type AgendaCommand = typeof AgendaCommandSchema.Type;
type CommandOf<Tag extends AgendaCommand['_tag']> = Extract<AgendaCommand, { readonly _tag: Tag }>;

const samePrincipal = (left: PrincipalRef | undefined, right: PrincipalRef | undefined) =>
  left !== undefined &&
  right !== undefined &&
  left.principalId === right.principalId &&
  left.tenantId === right.tenantId;

const notificationsOf = (state: AgendaState): readonly Notification[] => state.notifications ?? [];

/** Keeps the inbox bounded: drops the oldest READ notifications first, never unread ones. */
export const pruneNotifications = (notifications: readonly Notification[]): readonly Notification[] => {
  if (notifications.length <= MAX_NOTIFICATIONS) {
    return notifications;
  }
  let surplus = notifications.length - MAX_NOTIFICATIONS;
  return notifications.filter((entry) => {
    if (surplus > 0 && entry.readAt !== undefined) {
      surplus -= 1;
      return false;
    }
    return true;
  });
};

/** `true` when the recipient already holds a notification for this source event (dedup key, S13-03). */
export const hasNotification = (notifications: readonly Notification[], recipient: PrincipalRef, eventKey: string) =>
  notifications.some((entry) => entry.eventKey === eventKey && samePrincipal(entry.recipient, recipient));

interface PendingNotification {
  readonly recipient: PrincipalRef;
  readonly item: NotificationDeliveryItem;
}

/**
 * Appends notifications that are not yet present for their recipient. Returns the new state, ids of the created
 * notifications and how many offered items were duplicates.
 */
const appendNotifications = Effect.fn('SiamparkOps.Agenda.appendNotifications')(function* appendNotifications(
  state: AgendaState,
  pending: readonly PendingNotification[],
  input: OpsCommandInput,
) {
  const accepted: Notification[] = [];
  for (const [index, entry] of pending.entries()) {
    if (hasNotification([...notificationsOf(state), ...accepted], entry.recipient, entry.item.eventKey)) {
      continue;
    }
    const id = yield* mintId(NotificationIdSchema, `${input.resourceId}:n${index}`);
    accepted.push({ ...entry.item, createdAt: input.now, createdBy: input.actor, id, recipient: entry.recipient });
  }
  const entityIds: EntityId[] = [];
  for (const record of accepted) {
    entityIds.push(yield* entityIdOf(record.id));
  }
  return {
    duplicates: pending.length - accepted.length,
    entityIds,
    state: { ...state, notifications: pruneNotifications([...notificationsOf(state), ...accepted]) },
  };
});

const assignmentNotice = (record: CalendarEvent, input: OpsCommandInput): PendingNotification[] =>
  record.assignee === undefined || samePrincipal(record.assignee, input.actor)
    ? []
    : [
        {
          item: {
            category: 'ASSIGNED',
            dueDate: record.date,
            eventKey: `agenda-event:${record.id}:assigned:${record.assignee.principalId}`,
            href: `/siampark/provoz/agenda?event=${encodeURIComponent(record.id)}`,
            source: 'ops',
            title: record.title,
          },
          recipient: record.assignee,
        },
      ];

const rescheduleNotice = (record: CalendarEvent, input: OpsCommandInput): PendingNotification[] =>
  record.assignee === undefined || samePrincipal(record.assignee, input.actor)
    ? []
    : [
        {
          item: {
            category: 'CHANGE',
            dueDate: record.date,
            eventKey: `agenda-event:${record.id}:date:${record.date}`,
            href: `/siampark/provoz/agenda?event=${encodeURIComponent(record.id)}`,
            source: 'ops',
            title: record.title,
          },
          recipient: record.assignee,
        },
      ];

const createCalendarEvent = Effect.fn('SiamparkOps.Agenda.create')(function* createCalendarEvent(
  state: AgendaState,
  value: CommandOf<'AgendaEventCreate'>,
  input: OpsCommandInput,
) {
  const id = yield* mintId(CalendarEventIdSchema, input.resourceId);
  const { _tag, ...fields } = value;
  void _tag;
  const record: CalendarEvent = { ...fields, ...auditCreated(input), id, status: 'PLANNED' };
  const entity = yield* entityIdOf(id);
  const withEvent: AgendaState = { ...state, events: [...state.events, record] };
  const notified = yield* appendNotifications(withEvent, assignmentNotice(record, input), input);
  return { entityIds: [entity, ...notified.entityIds], state: notified.state };
});

const updateCalendarEvent = Effect.fn('SiamparkOps.Agenda.update')(function* updateCalendarEvent(
  state: AgendaState,
  value: CommandOf<'AgendaEventUpdate'>,
  input: OpsCommandInput,
) {
  const current = state.events.find((event) => event.id === value.eventId);
  if (current === undefined) {
    return yield* opsNotFound('calendar event not found');
  }
  if ((current.status ?? 'PLANNED') === 'CANCELLED' && value.status !== 'PLANNED') {
    return yield* opsConflict('cancelled calendar events can only be reopened');
  }
  const { _tag, eventId, related, assignee, assigneeLabel, ...changes } = value;
  void _tag;
  void eventId;
  const { related: _oldRelated, assignee: _oldAssignee, assigneeLabel: _oldLabel, ...rest } = current;
  void _oldRelated;
  void _oldAssignee;
  void _oldLabel;
  const nextRelated = related === undefined ? current.related : (related ?? undefined);
  const nextAssignee = assignee === undefined ? current.assignee : (assignee ?? undefined);
  const nextLabel =
    assignee === null ? undefined : (assigneeLabel ?? (assignee === undefined ? current.assigneeLabel : undefined));
  const updated: CalendarEvent = auditUpdated(
    {
      ...rest,
      ...changes,
      ...(nextRelated === undefined ? {} : { related: nextRelated }),
      ...(nextAssignee === undefined ? {} : { assignee: nextAssignee }),
      ...(nextLabel === undefined ? {} : { assigneeLabel: nextLabel }),
    },
    input,
  );
  const reassigned = nextAssignee !== undefined && !samePrincipal(nextAssignee, current.assignee);
  const rescheduled = !reassigned && updated.date !== current.date;
  const withEvent: AgendaState = {
    ...state,
    events: state.events.map((event) => (event.id === current.id ? updated : event)),
  };
  const pending = [
    ...(reassigned ? assignmentNotice(updated, input) : []),
    ...(rescheduled ? rescheduleNotice(updated, input) : []),
  ];
  const notified = yield* appendNotifications(withEvent, pending, input);
  const entity = yield* entityIdOf(current.id);
  return { entityIds: [entity, ...notified.entityIds], state: notified.state };
});

const deliverNotifications = Effect.fn('SiamparkOps.Agenda.deliver')(function* deliverNotifications(
  state: AgendaState,
  value: CommandOf<'AgendaNotificationsDeliver'>,
  input: OpsCommandInput,
) {
  const notified = yield* appendNotifications(
    state,
    value.items.map((item) => ({ item, recipient: input.actor })),
    input,
  );
  return { entityIds: notified.entityIds, state: notified.state };
});

const markRead = Effect.fn('SiamparkOps.Agenda.markRead')(function* markRead(
  state: AgendaState,
  ids: ReadonlySet<string> | 'all',
  input: OpsCommandInput,
) {
  const touched: string[] = [];
  const notifications = notificationsOf(state).map((entry) => {
    if (!samePrincipal(entry.recipient, input.actor) || entry.readAt !== undefined) {
      return entry;
    }
    if (ids !== 'all' && !ids.has(entry.id)) {
      return entry;
    }
    touched.push(entry.id);
    return { ...entry, readAt: input.now };
  });
  if (ids !== 'all') {
    const own = new Set<string>(
      notificationsOf(state)
        .filter((entry) => samePrincipal(entry.recipient, input.actor))
        .map((entry) => entry.id),
    );
    if ([...ids].some((id) => !own.has(id))) {
      return yield* opsNotFound('notification not found');
    }
  }
  const entityIds: EntityId[] = [];
  for (const id of touched) {
    entityIds.push(yield* entityIdOf(id));
  }
  return { entityIds, state: { ...state, notifications } };
});

const recordExport = Effect.fn('SiamparkOps.Agenda.export')(function* recordExport(
  state: AgendaState,
  value: CommandOf<'AgendaExportRecord'>,
  input: OpsCommandInput,
) {
  const id = yield* mintId(ExportRecordSchema.fields.id, input.resourceId);
  const record: ExportRecord = {
    exportedAt: input.now,
    exportedBy: input.actor,
    id,
    list: value.list,
    rowCount: value.rowCount,
    ...(value.filter === undefined ? {} : { filter: value.filter }),
  };
  const exports = [...(state.exports ?? []), record].slice(-MAX_EXPORTS);
  return { entityIds: [yield* entityIdOf(id)], state: { ...state, exports } };
});

const setPreferences = Effect.fn('SiamparkOps.Agenda.preferences')(function* setPreferences(
  state: AgendaState,
  value: CommandOf<'AgendaPreferencesSet'>,
  input: OpsCommandInput,
) {
  const preference: NotificationPreference = {
    emailOptIn: value.emailOptIn,
    leadDays: value.leadDays,
    principal: input.actor,
    updatedAt: input.now,
  };
  const others = (state.preferences ?? []).filter((entry) => !samePrincipal(entry.principal, input.actor));
  return {
    entityIds: [yield* entityIdOf(`preference:${input.actor.principalId}`)],
    state: { ...state, preferences: [...others, preference] },
  };
});

/** Pure reducer: applies one command to the `agenda` state. Persistence decides when it is saved. */
export const evolveAgenda = (state: AgendaState, command: AgendaCommand, input: OpsCommandInput) =>
  Match.value(command).pipe(
    Match.tag('AgendaEventCreate', (value) => createCalendarEvent(state, value, input)),
    Match.tag('AgendaEventUpdate', (value) => updateCalendarEvent(state, value, input)),
    Match.tag('AgendaNotificationsDeliver', (value) => deliverNotifications(state, value, input)),
    Match.tag('AgendaNotificationsMarkRead', (value) => markRead(state, new Set(value.notificationIds), input)),
    Match.tag('AgendaNotificationsMarkAllRead', () => markRead(state, 'all', input)),
    Match.tag('AgendaExportRecord', (value) => recordExport(state, value, input)),
    Match.tag('AgendaPreferencesSet', (value) => setPreferences(state, value, input)),
    Match.exhaustive,
  );

export const agendaAgenda = defineAgenda({
  commandSchema: AgendaCommandSchema,
  empty: emptyAgendaState,
  evolve: evolveAgenda,
  id: 'agenda',
  sensitivity: 'operational',
  stateSchema: AgendaStateSchema,
});
