// Siampark provoz — agenda `agenda` (S13 kalendář, notifikace, Moje agenda + S15 přehled, vyhledávání, export).
// OWNED BY THE `agenda` LANE (ops-agenda). Old JSONB rows must still decode: new fields are `Schema.optionalKey(...)`.
//
// What lives here (everything else in the calendar is READ from its source module and never copied):
//   events         own calendar entries (meetings, reminders, internal deadlines) — editable here
//   notifications  in-app inbox, one entry per (recipient, eventKey); the reducer refuses duplicates (S13-03)
//   exports        audit log of CSV exports (who, which list, how many rows, which filter) (S15)
//   preferences    per-person notification preferences (lead time, optional e-mail opt-in — e-mail is simulated)
import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { Schema } from 'effect';
import { AuditFieldsSchema, IsoDateSchema, NoteSchema, PropertyRefSchema, TextSchema, opsIdOf } from './common.ts';

export const CalendarEventIdSchema = opsIdOf('SiamparkCalendarEventId');
export type CalendarEventId = typeof CalendarEventIdSchema.Type;

export const CalendarEventKindSchema = Schema.Literals(['DEADLINE', 'INSPECTION', 'MEETING', 'REMINDER']);
export type CalendarEventKind = typeof CalendarEventKindSchema.Type;

export const CalendarEventStatusSchema = Schema.Literals(['PLANNED', 'DONE', 'CANCELLED']);
export type CalendarEventStatus = typeof CalendarEventStatusSchema.Type;

export const CalendarEventSchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  id: CalendarEventIdSchema,
  title: TextSchema(300),
  date: IsoDateSchema,
  kind: CalendarEventKindSchema,
  related: Schema.optionalKey(PropertyRefSchema),
  assignee: Schema.optionalKey(PrincipalRefSchema),
  /** Display snapshot of the assignee (e-mail or name) taken when assigned. */
  assigneeLabel: Schema.optionalKey(TextSchema(200)),
  note: Schema.optionalKey(NoteSchema),
  /** Missing = PLANNED (rows written before the field existed). */
  status: Schema.optionalKey(CalendarEventStatusSchema),
});
export type CalendarEvent = typeof CalendarEventSchema.Type;

export const NotificationIdSchema = opsIdOf('SiamparkNotificationId');
export type NotificationId = typeof NotificationIdSchema.Type;

/** ASSIGNED = someone assigned me; DEADLINE = approaching; OVERDUE = past due; CHANGE = significant change. */
export const NotificationCategorySchema = Schema.Literals(['ASSIGNED', 'DEADLINE', 'OVERDUE', 'CHANGE']);
export type NotificationCategory = typeof NotificationCategorySchema.Type;

/** Stable identity of the source event (e.g. `contract-end:<contractId>:2026-10-31`). Dedup key per recipient. */
export const EventKeySchema = TextSchema(400);

export const NotificationSchema = Schema.Struct({
  id: NotificationIdSchema,
  recipient: PrincipalRefSchema,
  eventKey: EventKeySchema,
  category: NotificationCategorySchema,
  title: TextSchema(300),
  detail: Schema.optionalKey(TextSchema(500)),
  /** Source module id (agreements, occupancy, work, finance, property, ops). */
  source: TextSchema(80),
  /** Link to the source record (in-app path). */
  href: Schema.optionalKey(TextSchema(500)),
  dueDate: Schema.optionalKey(IsoDateSchema),
  createdAt: Schema.DateTimeUtcFromString,
  createdBy: PrincipalRefSchema,
  readAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
});
export type Notification = typeof NotificationSchema.Type;

export const ExportRecordSchema = Schema.Struct({
  id: opsIdOf('SiamparkExportId'),
  list: TextSchema(120),
  rowCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  filter: Schema.optionalKey(TextSchema(500)),
  exportedAt: Schema.DateTimeUtcFromString,
  exportedBy: PrincipalRefSchema,
});
export type ExportRecord = typeof ExportRecordSchema.Type;

export const LeadDaysSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(90));

export const NotificationPreferenceSchema = Schema.Struct({
  principal: PrincipalRefSchema,
  /** Deadlines within this many days create a DEADLINE notification. */
  leadDays: LeadDaysSchema,
  /** E-mail delivery is not configured in the demo; the preference is stored, delivery is simulated. */
  emailOptIn: Schema.Boolean,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type NotificationPreference = typeof NotificationPreferenceSchema.Type;

export const AgendaStateSchema = Schema.Struct({
  events: Schema.Array(CalendarEventSchema),
  notifications: Schema.optionalKey(Schema.Array(NotificationSchema)),
  exports: Schema.optionalKey(Schema.Array(ExportRecordSchema)),
  preferences: Schema.optionalKey(Schema.Array(NotificationPreferenceSchema)),
});
export type AgendaState = typeof AgendaStateSchema.Type;
export type AgendaStateEncoded = typeof AgendaStateSchema.Encoded;

/** State written by the seed when nothing else is known. Must decode with AgendaStateSchema. */
export const emptyAgendaState: AgendaStateEncoded = { events: [], exports: [], notifications: [], preferences: [] };

/** Default lead time for DEADLINE notifications when a person has not set a preference. */
export const DEFAULT_LEAD_DAYS = 14;
/** Upper bound of notifications kept in the state; oldest read ones are dropped first. */
export const MAX_NOTIFICATIONS = 1500;
/** Upper bound of the export log. */
export const MAX_EXPORTS = 300;
