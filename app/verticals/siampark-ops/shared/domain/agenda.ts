// Siampark provoz — agenda `agenda` (S13 kalendář, notifikace, Moje agenda + S15 přehled, vyhledávání, export).
// OWNED BY THE `agenda` LANE. Change freely; keep exporting AgendaStateSchema and emptyAgendaState.
// Old JSONB rows must still decode: add new fields as `Schema.optionalKey(...)` or reseed (pnpm demo:seed:siampark-ops).
import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { Schema } from 'effect';
import { AuditFieldsSchema, IsoDateSchema, NoteSchema, PropertyRefSchema, TextSchema, opsIdOf } from './common.ts';

export const CalendarEventIdSchema = opsIdOf('SiamparkCalendarEventId');
export type CalendarEventId = typeof CalendarEventIdSchema.Type;

export const CalendarEventSchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  id: CalendarEventIdSchema,
  title: TextSchema(300),
  date: IsoDateSchema,
  kind: Schema.Literals(['DEADLINE', 'INSPECTION', 'MEETING', 'REMINDER']),
  related: Schema.optionalKey(PropertyRefSchema),
  assignee: Schema.optionalKey(PrincipalRefSchema),
  note: Schema.optionalKey(NoteSchema),
});
export type CalendarEvent = typeof CalendarEventSchema.Type;

export const AgendaStateSchema = Schema.Struct({
  events: Schema.Array(CalendarEventSchema),
});
export type AgendaState = typeof AgendaStateSchema.Type;
export type AgendaStateEncoded = typeof AgendaStateSchema.Encoded;

/** State written by the seed when nothing else is known. Must decode with AgendaStateSchema. */
export const emptyAgendaState: AgendaStateEncoded = { events: [] };
