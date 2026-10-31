// Facility operations — commands of agenda `agenda` (S13 kalendář, notifikace, Moje agenda + S15 přehled, vyhledávání, export).
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
import { Effect, Match, Option, Schema } from 'effect';
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
import type { OpsCommandCall, OpsCommandInput } from '../domain/common.ts';
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
  OptionalEmailCategorySchema,
  emptyAgendaState,
} from '../domain/agenda.ts';
import type {
  AgendaState,
  CalendarEvent,
  ExportRecord,
  Notification,
  NotificationPreference,
} from '../domain/agenda.ts';

/** One source event offered for delivery to the acting person's inbox. */
export const NotificationDeliveryItemSchema = Schema.Struct({
  category: NotificationCategorySchema,
  detail: Schema.optionalKey(TextSchema(500)),
  dueDate: Schema.optionalKey(IsoDateSchema),
  eventKey: EventKeySchema,
  href: Schema.optionalKey(TextSchema(500)),
  source: TextSchema(80),
  title: TextSchema(300),
});
export type NotificationDeliveryItem = typeof NotificationDeliveryItemSchema.Type;

export const agendaCommandSchemas = [
  Schema.TaggedStruct('AgendaEventCreate', {
    assignee: Schema.optionalKey(PrincipalRefSchema),
    assigneeLabel: Schema.optionalKey(TextSchema(200)),
    date: IsoDateSchema,
    kind: CalendarEventKindSchema,
    note: Schema.optionalKey(NoteSchema),
    related: Schema.optionalKey(PropertyRefSchema),
    title: TextSchema(300),
  }),
  Schema.TaggedStruct('AgendaEventUpdate', {
    date: Schema.optionalKey(IsoDateSchema),
    eventId: CalendarEventIdSchema,
    kind: Schema.optionalKey(CalendarEventKindSchema),
    title: Schema.optionalKey(TextSchema(300)),
    /** `null` removes the link. */
    related: Schema.optionalKey(Schema.OptionFromNullOr(PropertyRefSchema)),
    /** `null` removes the assignee. */
    assignee: Schema.optionalKey(Schema.OptionFromNullOr(PrincipalRefSchema)),
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
    filter: Schema.optionalKey(TextSchema(500)),
    list: ExportRecordSchema.fields.list,
    rowCount: ExportRecordSchema.fields.rowCount,
  }),
  Schema.TaggedStruct('AgendaPreferencesSet', {
    emailOptIn: Schema.Boolean,
    leadDays: LeadDaysSchema,
    /** Optional categories also e-mailed; missing keeps the stored choice. */
    emailCategories: Schema.optionalKey(Schema.Array(OptionalEmailCategorySchema).check(Schema.isMaxLength(2))),
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
  readonly item: NotificationDeliveryItem;
  readonly recipient: PrincipalRef;
}

/**
 * Appends notifications that are not yet present for their recipient. Returns the new state, ids of the created
 * notifications and how many offered items were duplicates.
 */
const appendNotifications = Effect.fn('FacilityOperations.Agenda.appendNotifications')(function* appendNotifications(
  state: AgendaState,
  pending: readonly PendingNotification[],
  input: OpsCommandInput,
) {
  const initial: readonly Notification[] = [];
  const accepted = yield* Effect.reduce(
    pending.entries(),
    () => initial,
    (records, [index, entry]) => {
      if (hasNotification([...notificationsOf(state), ...records], entry.recipient, entry.item.eventKey)) {
        return Effect.succeed(records);
      }
      return mintId(NotificationIdSchema, `${input.resourceId}:n${index}`).pipe(
        Effect.map((id) => [
          ...records,
          { ...entry.item, createdAt: input.now, createdBy: input.actor, id, recipient: entry.recipient },
        ]),
      );
    },
  );
  const entityIds = yield* Effect.forEach(accepted, (record) => entityIdOf(record.id), { concurrency: 1 });
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
            href: `/provoz/agenda?event=${encodeURIComponent(record.id)}`,
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
            href: `/provoz/agenda?event=${encodeURIComponent(record.id)}`,
            source: 'ops',
            title: record.title,
          },
          recipient: record.assignee,
        },
      ];

const createCalendarEvent = Effect.fn('FacilityOperations.Agenda.create')(function* createCalendarEvent(
  state: AgendaState,
  { input, value }: OpsCommandCall<CommandOf<'AgendaEventCreate'>>,
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

const updateCalendarEvent = Effect.fn('FacilityOperations.Agenda.update')(function* updateCalendarEvent(
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
  const { _tag, assignee, assigneeLabel, eventId, related, ...changes } = value;
  void _tag;
  void eventId;
  const { assignee: _oldAssignee, assigneeLabel: _oldLabel, related: _oldRelated, ...rest } = current;
  void _oldRelated;
  void _oldAssignee;
  void _oldLabel;
  const nextRelated = related === undefined ? current.related : Option.getOrUndefined(related);
  const nextAssignee = assignee === undefined ? current.assignee : Option.getOrUndefined(assignee);
  const nextLabel =
    assignee !== undefined && Option.isNone(assignee)
      ? undefined
      : (assigneeLabel ?? (assignee === undefined ? current.assigneeLabel : undefined));
  let updatedFields: CalendarEvent = { ...rest, ...changes };
  if (nextRelated !== undefined) {
    updatedFields = { ...updatedFields, related: nextRelated };
  }
  if (nextAssignee !== undefined) {
    updatedFields = { ...updatedFields, assignee: nextAssignee };
  }
  if (nextLabel !== undefined) {
    updatedFields = { ...updatedFields, assigneeLabel: nextLabel };
  }
  const updated = auditUpdated(updatedFields, input);
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
  const entityIds = yield* Effect.map(entityIdOf(current.id), (entity) => [entity, ...notified.entityIds]);
  return { entityIds, state: notified.state };
});

const deliverNotifications = Effect.fn('FacilityOperations.Agenda.deliver')(function* deliverNotifications(
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

const markRead = Effect.fn('FacilityOperations.Agenda.markRead')(function* markRead(
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
    const own = new Set<string>();
    for (const entry of notificationsOf(state)) {
      if (samePrincipal(entry.recipient, input.actor)) {
        own.add(entry.id);
      }
    }
    if ([...ids].some((id) => !own.has(id))) {
      return yield* opsNotFound('notification not found');
    }
  }
  const entityIds = yield* Effect.forEach(touched, entityIdOf, { concurrency: 1 });
  return { entityIds, state: { ...state, notifications } };
});

const recordExport = Effect.fn('FacilityOperations.Agenda.export')(function* recordExport(
  state: AgendaState,
  value: CommandOf<'AgendaExportRecord'>,
  input: OpsCommandInput,
) {
  const id = yield* mintId(ExportRecordSchema.fields.id, input.resourceId);
  let record: ExportRecord = {
    exportedAt: input.now,
    exportedBy: input.actor,
    id,
    list: value.list,
    rowCount: value.rowCount,
  };
  if (value.filter !== undefined) {
    record = { ...record, filter: value.filter };
  }
  const exports = [...(state.exports ?? []), record].slice(-MAX_EXPORTS);
  return { entityIds: [yield* entityIdOf(id)], state: { ...state, exports } };
});

const setPreferences = Effect.fn('FacilityOperations.Agenda.preferences')(function* setPreferences(
  state: AgendaState,
  value: CommandOf<'AgendaPreferencesSet'>,
  input: OpsCommandInput,
) {
  const previous = (state.preferences ?? []).find((entry) => samePrincipal(entry.principal, input.actor));
  const emailCategories = value.emailCategories ?? previous?.emailCategories;
  // Keep the original switch-on instant while e-mail stays on, so changing the lead time never re-sends anything.
  let emailSince: NotificationPreference['emailSince'];
  if (value.emailOptIn) {
    emailSince = previous?.emailOptIn === true ? (previous.emailSince ?? previous.updatedAt) : input.now;
  }
  let preference: NotificationPreference = {
    emailOptIn: value.emailOptIn,
    leadDays: value.leadDays,
    principal: input.actor,
    updatedAt: input.now,
  };
  if (emailCategories !== undefined) {
    preference = { ...preference, emailCategories: [...new Set(emailCategories)] };
  }
  if (emailSince !== undefined) {
    preference = { ...preference, emailSince };
  }
  const others = (state.preferences ?? []).filter((entry) => !samePrincipal(entry.principal, input.actor));
  return {
    entityIds: [yield* entityIdOf(`preference:${input.actor.principalId}`)],
    state: { ...state, preferences: [...others, preference] },
  };
});

/** Pure reducer: applies one command to the `agenda` state. Persistence decides when it is saved. */
export const evolveAgenda = (state: AgendaState, command: AgendaCommand, input: OpsCommandInput) =>
  Match.value(command).pipe(
    Match.tag('AgendaEventCreate', (value) => createCalendarEvent(state, { input, value })),
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
