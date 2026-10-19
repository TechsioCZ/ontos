// Siampark provoz — commands of agenda `agenda` (S13 kalendář, notifikace, Moje agenda + S15 přehled, vyhledávání, export).
// OWNED BY THE `agenda` LANE. To add a command: append a Schema.TaggedStruct to `agendaCommandSchemas`
// (tag must be globally unique, prefix it like `AgendaEvent…`), then handle it in `evolveAgenda`.
// The central dispatcher (shared/agendas.ts) picks the agenda by tag; nothing else needs editing.
import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { Effect, Match, Schema } from 'effect';
import { auditCreated, defineAgenda, entityIdOf, IsoDateSchema, mintId, NoteSchema, PropertyRefSchema, TextSchema } from '../domain/common.ts';
import type { OpsCommandInput } from '../domain/common.ts';
import { AgendaStateSchema, CalendarEventIdSchema, emptyAgendaState } from '../domain/agenda.ts';
import type { AgendaState, CalendarEvent } from '../domain/agenda.ts';

export const agendaCommandSchemas = [
  Schema.TaggedStruct('AgendaEventCreate', {
    title: TextSchema(300),
    date: IsoDateSchema,
    kind: Schema.Literals(['DEADLINE', 'INSPECTION', 'MEETING', 'REMINDER']),
    related: Schema.optionalKey(PropertyRefSchema),
    assignee: Schema.optionalKey(PrincipalRefSchema),
    note: Schema.optionalKey(NoteSchema),
  }),
] as const;

export const AgendaCommandSchema = Schema.Union(agendaCommandSchemas);
export type AgendaCommand = typeof AgendaCommandSchema.Type;
type CommandOf<Tag extends AgendaCommand['_tag']> = Extract<AgendaCommand, { readonly _tag: Tag }>;

const createCalendarEvent = Effect.fn('SiamparkOps.Agenda.create')(function* createCalendarEvent(
  state: AgendaState,
  value: CommandOf<'AgendaEventCreate'>,
  input: OpsCommandInput,
) {
  const id = yield* mintId(CalendarEventIdSchema, input.resourceId);
  const { _tag, ...fields } = value;
  void _tag;
  const record: CalendarEvent = { ...fields, ...auditCreated(input), id };
  const entity = yield* entityIdOf(id);
  return { entityIds: [entity], state: { ...state, events: [...state.events, record] } };
});

/** Pure reducer: applies one command to the `agenda` state. Persistence decides when it is saved. */
export const evolveAgenda = (state: AgendaState, command: AgendaCommand, input: OpsCommandInput) =>
  Match.value(command).pipe(
    Match.tag('AgendaEventCreate', (value) => createCalendarEvent(state, value, input)),
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
