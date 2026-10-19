// Siampark provoz — commands of agenda `meters` (S04 média, měřidla a odečty).
// OWNED BY THE `meters` LANE. To add a command: append a Schema.TaggedStruct to `metersCommandSchemas`
// (tag must be globally unique, prefix it like `Meter…`), then handle it in `evolveMeters`.
// The central dispatcher (shared/agendas.ts) picks the agenda by tag; nothing else needs editing.
import { Effect, Match, Schema } from 'effect';
import { auditCreated, defineAgenda, entityIdOf, mintId, NoteSchema, opsConflict, PropertyRefSchema, TextSchema } from '../domain/common.ts';
import type { OpsCommandInput } from '../domain/common.ts';
import { MetersStateSchema, MeterIdSchema, emptyMetersState } from '../domain/meters.ts';
import type { MetersState, Meter } from '../domain/meters.ts';

export const metersCommandSchemas = [
  Schema.TaggedStruct('MeterCreate', {
    serialNumber: TextSchema(64),
    medium: Schema.Literals(['ELECTRICITY', 'WATER', 'GAS', 'HEAT']),
    unit: TextSchema(16),
    location: Schema.optionalKey(PropertyRefSchema),
    note: Schema.optionalKey(NoteSchema),
  }),
] as const;

export const MetersCommandSchema = Schema.Union(metersCommandSchemas);
export type MetersCommand = typeof MetersCommandSchema.Type;
type CommandOf<Tag extends MetersCommand['_tag']> = Extract<MetersCommand, { readonly _tag: Tag }>;

const createMeter = Effect.fn('SiamparkOps.Meters.create')(function* createMeter(
  state: MetersState,
  value: CommandOf<'MeterCreate'>,
  input: OpsCommandInput,
) {
  if (state.meters.some((entry) => entry.serialNumber.toLowerCase() === value.serialNumber.toLowerCase())) {
    return yield* opsConflict('A meter with this serial number already exists');
  }
  const id = yield* mintId(MeterIdSchema, input.resourceId);
  const { _tag, ...fields } = value;
  void _tag;
  const record: Meter = { ...fields, ...auditCreated(input), id };
  const entity = yield* entityIdOf(id);
  return { entityIds: [entity], state: { ...state, meters: [...state.meters, record] } };
});

/** Pure reducer: applies one command to the `meters` state. Persistence decides when it is saved. */
export const evolveMeters = (state: MetersState, command: MetersCommand, input: OpsCommandInput) =>
  Match.value(command).pipe(
    Match.tag('MeterCreate', (value) => createMeter(state, value, input)),
    Match.exhaustive,
  );

export const metersAgenda = defineAgenda({
  commandSchema: MetersCommandSchema,
  empty: emptyMetersState,
  evolve: evolveMeters,
  id: 'meters',
  sensitivity: 'operational',
  stateSchema: MetersStateSchema,
});
