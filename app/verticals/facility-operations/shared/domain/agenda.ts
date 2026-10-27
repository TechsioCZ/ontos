// Facility operations — agenda `agenda` (S13 kalendář, notifikace, Moje agenda + S15 přehled, vyhledávání, export).
// OWNED BY THE `agenda` LANE (ops-agenda). Old JSONB rows must still decode: new fields are `Schema.optionalKey(...)`.
//
// What lives here (everything else in the calendar is READ from its source module and never copied):
//   events         own calendar entries (meetings, reminders, internal deadlines) — editable here
//   notifications  in-app inbox, one entry per (recipient, eventKey); the reducer refuses duplicates (S13-03)
//   exports        audit log of CSV exports (who, which list, how many rows, which filter) (S15)
//   preferences    per-person notification preferences (lead time, e-mail opt-in + chosen optional categories; the demo
//                  e-mail dispatcher sends real e-mails over SMTP when a provider is configured)
import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import type { PrincipalRef } from '@app/core-runtime/permissions/principal-ref';
import { Schema } from 'effect';
import { AuditFieldsSchema, IsoDateSchema, NoteSchema, PropertyRefSchema, TextSchema, opsIdOf } from './common.ts';

export const CalendarEventIdSchema = opsIdOf('FacilityCalendarEventId');
export type CalendarEventId = typeof CalendarEventIdSchema.Type;

export const CalendarEventKindSchema = Schema.Literals(['DEADLINE', 'INSPECTION', 'MEETING', 'REMINDER']);
export type CalendarEventKind = typeof CalendarEventKindSchema.Type;

export const CalendarEventStatusSchema = Schema.Literals(['PLANNED', 'DONE', 'CANCELLED']);
export type CalendarEventStatus = typeof CalendarEventStatusSchema.Type;

export const CalendarEventSchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  assignee: Schema.optionalKey(PrincipalRefSchema),
  date: IsoDateSchema,
  id: CalendarEventIdSchema,
  kind: CalendarEventKindSchema,
  related: Schema.optionalKey(PropertyRefSchema),
  title: TextSchema(300),
  /** Display snapshot of the assignee (e-mail or name) taken when assigned. */
  assigneeLabel: Schema.optionalKey(TextSchema(200)),
  note: Schema.optionalKey(NoteSchema),
  /** Missing = PLANNED (rows written before the field existed). */
  status: Schema.optionalKey(CalendarEventStatusSchema),
});
export type CalendarEvent = typeof CalendarEventSchema.Type;

export const NotificationIdSchema = opsIdOf('FacilityNotificationId');
export type NotificationId = typeof NotificationIdSchema.Type;

/** ASSIGNED = someone assigned me; DEADLINE = approaching; OVERDUE = past due; CHANGE = significant change. */
export const NotificationCategorySchema = Schema.Literals(['ASSIGNED', 'DEADLINE', 'OVERDUE', 'CHANGE']);
export type NotificationCategory = typeof NotificationCategorySchema.Type;

/** Stable identity of the source event (e.g. `contract-end:<contractId>:2026-10-31`). Dedup key per recipient. */
export const EventKeySchema = TextSchema(400);

export const NotificationSchema = Schema.Struct({
  category: NotificationCategorySchema,
  detail: Schema.optionalKey(TextSchema(500)),
  eventKey: EventKeySchema,
  id: NotificationIdSchema,
  recipient: PrincipalRefSchema,
  title: TextSchema(300),
  /** Source module id (agreements, occupancy, work, finance, property, ops). */
  source: TextSchema(80),
  /** Link to the source record (in-app path). */
  createdAt: Schema.DateTimeUtcFromString,
  createdBy: PrincipalRefSchema,
  dueDate: Schema.optionalKey(IsoDateSchema),
  href: Schema.optionalKey(TextSchema(500)),
  readAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
});
export type Notification = typeof NotificationSchema.Type;

export const ExportRecordSchema = Schema.Struct({
  exportedAt: Schema.DateTimeUtcFromString,
  exportedBy: PrincipalRefSchema,
  filter: Schema.optionalKey(TextSchema(500)),
  id: opsIdOf('FacilityExportId'),
  list: TextSchema(120),
  rowCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ExportRecord = typeof ExportRecordSchema.Type;

export const LeadDaysSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(90));

export const NotificationPreferenceSchema = Schema.Struct({
  principal: PrincipalRefSchema,
  /** Deadlines within this many days create a DEADLINE notification. */
  leadDays: LeadDaysSchema,
  /** Also send notifications by e-mail (real SMTP via the demo e-mail dispatcher once a provider is configured). */
  emailOptIn: Schema.Boolean,
  /** Optional categories also e-mailed (ASSIGNED and OVERDUE are always e-mailed). Missing = every optional one. */
  emailCategories: Schema.optionalKey(Schema.Array(NotificationCategorySchema)),
  /** When e-mail was switched on; only notifications created afterwards are e-mailed. */
  emailSince: Schema.optionalKey(Schema.DateTimeUtcFromString),
  updatedAt: Schema.DateTimeUtcFromString,
});
export type NotificationPreference = typeof NotificationPreferenceSchema.Type;

export const AgendaStateSchema = Schema.Struct({
  events: Schema.Array(CalendarEventSchema),
  exports: Schema.optionalKey(Schema.Array(ExportRecordSchema)),
  notifications: Schema.optionalKey(Schema.Array(NotificationSchema)),
  preferences: Schema.optionalKey(Schema.Array(NotificationPreferenceSchema)),
});
export type AgendaState = typeof AgendaStateSchema.Type;
export type AgendaStateEncoded = typeof AgendaStateSchema.Encoded;

/** State written by the seed when nothing else is known. Must decode with AgendaStateSchema. */
export const emptyAgendaState: AgendaStateEncoded = { events: [], exports: [], notifications: [], preferences: [] };

/** Personal inbox, preferences and export history are filtered before leaving the server, not just in the UI. */
export const agendaStateForPrincipal = (state: AgendaState, actor: PrincipalRef): AgendaState => {
  const mine = (principal: PrincipalRef) =>
    principal.principalId === actor.principalId && principal.tenantId === actor.tenantId;
  return {
    ...state,
    exports: (state.exports ?? []).filter((entry) => mine(entry.exportedBy)),
    notifications: (state.notifications ?? []).filter((entry) => mine(entry.recipient)),
    preferences: (state.preferences ?? []).filter((entry) => mine(entry.principal)),
  };
};

/**
 * Operational-only principals (external partners: `read_operational` without `read_all`/`write_all`) see only
 * the calendar events assigned to them. Filtered on the server, so other people's events never leave it.
 */
export const agendaStateForAssignee = (state: AgendaState, actor: PrincipalRef): AgendaState => ({
  ...state,
  events: state.events.filter(
    (event) => event.assignee?.principalId === actor.principalId && event.assignee.tenantId === actor.tenantId,
  ),
});

/** Inbox, preference and export-log commands touch only the actor's own entries; readers may run them. */
export const PERSONAL_AGENDA_COMMANDS: ReadonlySet<string> = new Set([
  'AgendaExportRecord',
  'AgendaNotificationsMarkAllRead',
  'AgendaNotificationsMarkRead',
  'AgendaPreferencesSet',
]);

/** Always e-mailed when e-mail is on (S13: e-mail notifications; preferences only for optional events). */
export const MANDATORY_EMAIL_CATEGORIES: readonly NotificationCategory[] = ['ASSIGNED', 'OVERDUE'];
/** The person decides whether these are e-mailed too. */
export const OptionalEmailCategorySchema = Schema.Literals(['DEADLINE', 'CHANGE']);
export const OPTIONAL_EMAIL_CATEGORIES: readonly (typeof OptionalEmailCategorySchema.Type)[] = ['DEADLINE', 'CHANGE'];

/** Default lead time for DEADLINE notifications when a person has not set a preference. */
export const DEFAULT_LEAD_DAYS = 14;
/** Upper bound of notifications kept in the state; oldest read ones are dropped first. */
export const MAX_NOTIFICATIONS = 1500;
/** Upper bound of the export log. */
export const MAX_EXPORTS = 300;
