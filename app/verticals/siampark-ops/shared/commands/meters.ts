// Siampark provoz — commands of agenda `meters` (S04 média, měřidla a odečty).
// OWNED BY THE `meters` LANE (ops-meters). Tags are globally unique (`Meter…`).
// The central dispatcher (shared/agendas.ts) picks the agenda by tag; nothing else needs editing.
import { DateTime, Effect, Match, Schema } from 'effect';
import {
  auditCreated,
  auditUpdated,
  defineAgenda,
  entityIdOf,
  IsoDateSchema,
  MinorAmountSchema,
  mintId,
  NoteSchema,
  opsConflict,
  opsNotFound,
  PropertyRefSchema,
  TextSchema,
} from '../domain/common.ts';
import type { OpsCommandInput } from '../domain/common.ts';
import {
  MeterIdSchema,
  MeterMediumSchema,
  MeterPhotoSchema,
  MeterReadingIdSchema,
  MeterValueSchema,
  MetersStateSchema,
  emptyMetersState,
  readingProblem,
} from '../domain/meters.ts';
import type { Meter, MeterReading, MetersState, ReadingProblem } from '../domain/meters.ts';

/** Editable meter master data (shared by create and update; omitted optional fields are cleared on update). */
const meterFields = {
  serialNumber: TextSchema(64),
  medium: MeterMediumSchema,
  unit: TextSchema(16),
  location: Schema.optionalKey(PropertyRefSchema),
  note: Schema.optionalKey(NoteSchema),
  supplyPoint: Schema.optionalKey(TextSchema(120)),
  supplier: Schema.optionalKey(TextSchema(200)),
  consumer: Schema.optionalKey(TextSchema(200)),
  contract: Schema.optionalKey(TextSchema(200)),
};

export const metersCommandSchemas = [
  Schema.TaggedStruct('MeterCreate', meterFields),
  Schema.TaggedStruct('MeterUpdate', {
    ...meterFields,
    meterId: MeterIdSchema,
    status: Schema.optionalKey(Schema.Literals(['ACTIVE', 'RETIRED'])),
  }),
  Schema.TaggedStruct('MeterReadingRecord', {
    meterId: MeterIdSchema,
    date: IsoDateSchema,
    value: MeterValueSchema,
    readBy: Schema.optionalKey(TextSchema(120)),
    note: Schema.optionalKey(NoteSchema),
    costMinor: Schema.optionalKey(MinorAmountSchema),
    photo: Schema.optionalKey(MeterPhotoSchema),
  }),
  Schema.TaggedStruct('MeterReadingVoid', {
    meterId: MeterIdSchema,
    readingId: MeterReadingIdSchema,
    reason: TextSchema(500),
  }),
] as const;

export const MetersCommandSchema = Schema.Union(metersCommandSchemas);
export type MetersCommand = typeof MetersCommandSchema.Type;
type CommandOf<Tag extends MetersCommand['_tag']> = Extract<MetersCommand, { readonly _tag: Tag }>;

/** Human-readable (English, logged) reason per validation problem; the UI shows its own Czech text. */
export const readingProblemReason: Readonly<Record<ReadingProblem, string>> = {
  duplicateDate: 'The meter already has a valid reading on this date',
  future: 'A reading cannot be dated in the future',
  higherThanNext: 'The value is higher than the next reading of this meter',
  lowerThanPrevious: 'The value is lower than the previous reading of this meter',
  retired: 'The meter is retired',
};

const pragueDateFormat = new Intl.DateTimeFormat('en-CA', {
  day: '2-digit',
  month: '2-digit',
  timeZone: 'Europe/Prague',
  year: 'numeric',
});
/** Business date (`YYYY-MM-DD`) of `now` in Europe/Prague. */
export const pragueDate = (now: DateTime.Utc): string => pragueDateFormat.format(DateTime.toDateUtc(now));

const findMeter = (state: MetersState, meterId: string) =>
  Effect.gen(function* findMeter() {
    const meter = state.meters.find((entry) => entry.id === meterId);
    if (meter === undefined) {
      return yield* opsNotFound('Meter not found');
    }
    return meter;
  });

const replaceMeter = (state: MetersState, meter: Meter): MetersState => ({
  ...state,
  meters: state.meters.map((entry) => (entry.id === meter.id ? meter : entry)),
});

const serialTaken = (state: MetersState, serialNumber: string, except?: string) =>
  state.meters.some(
    (entry) => entry.id !== except && entry.serialNumber.toLowerCase() === serialNumber.toLowerCase(),
  );

const createMeter = Effect.fn('SiamparkOps.Meters.create')(function* createMeter(
  state: MetersState,
  value: CommandOf<'MeterCreate'>,
  input: OpsCommandInput,
) {
  if (serialTaken(state, value.serialNumber)) {
    return yield* opsConflict('A meter with this serial number already exists');
  }
  const id = yield* mintId(MeterIdSchema, input.resourceId);
  const { _tag, ...fields } = value;
  void _tag;
  const record: Meter = { ...fields, ...auditCreated(input), id, readings: [], status: 'ACTIVE' };
  const entity = yield* entityIdOf(id);
  return { entityIds: [entity], state: { ...state, meters: [...state.meters, record] } };
});

const updateMeter = Effect.fn('SiamparkOps.Meters.update')(function* updateMeter(
  state: MetersState,
  value: CommandOf<'MeterUpdate'>,
  input: OpsCommandInput,
) {
  const meter = yield* findMeter(state, value.meterId);
  if (serialTaken(state, value.serialNumber, meter.id)) {
    return yield* opsConflict('A meter with this serial number already exists');
  }
  const { _tag, meterId, ...fields } = value;
  void _tag;
  void meterId;
  const next: Meter = auditUpdated(
    {
      createdAt: meter.createdAt,
      createdBy: meter.createdBy,
      id: meter.id,
      readings: meter.readings ?? [],
      status: fields.status ?? meter.status ?? 'ACTIVE',
      updatedAt: meter.updatedAt,
      updatedBy: meter.updatedBy,
      ...fields,
    },
    input,
  );
  const entity = yield* entityIdOf(meter.id);
  return { entityIds: [entity], state: replaceMeter(state, next) };
});

const recordReading = Effect.fn('SiamparkOps.Meters.recordReading')(function* recordReading(
  state: MetersState,
  value: CommandOf<'MeterReadingRecord'>,
  input: OpsCommandInput,
) {
  const meter = yield* findMeter(state, value.meterId);
  const problem = readingProblem(meter, value, pragueDate(input.now));
  if (problem !== undefined) {
    return yield* opsConflict(readingProblemReason[problem]);
  }
  const id = yield* mintId(MeterReadingIdSchema, input.resourceId);
  const { _tag, meterId, ...fields } = value;
  void _tag;
  void meterId;
  const reading: MeterReading = { ...fields, ...auditCreated(input), id, unit: meter.unit };
  const next: Meter = auditUpdated({ ...meter, readings: [...(meter.readings ?? []), reading] }, input);
  return { entityIds: [yield* entityIdOf(meter.id), yield* entityIdOf(id)], state: replaceMeter(state, next) };
});

const voidReading = Effect.fn('SiamparkOps.Meters.voidReading')(function* voidReading(
  state: MetersState,
  value: CommandOf<'MeterReadingVoid'>,
  input: OpsCommandInput,
) {
  const meter = yield* findMeter(state, value.meterId);
  const reading = (meter.readings ?? []).find((entry) => entry.id === value.readingId);
  if (reading === undefined) {
    return yield* opsNotFound('Meter reading not found');
  }
  if (reading.voided !== undefined) {
    return yield* opsConflict('The reading is already voided');
  }
  const voided: MeterReading = auditUpdated(
    { ...reading, voided: { at: input.now, by: input.actor, reason: value.reason } },
    input,
  );
  const next: Meter = auditUpdated(
    { ...meter, readings: (meter.readings ?? []).map((entry) => (entry.id === reading.id ? voided : entry)) },
    input,
  );
  return { entityIds: [yield* entityIdOf(meter.id), yield* entityIdOf(reading.id)], state: replaceMeter(state, next) };
});

/** Pure reducer: applies one command to the `meters` state. Persistence decides when it is saved. */
export const evolveMeters = (state: MetersState, command: MetersCommand, input: OpsCommandInput) =>
  Match.value(command).pipe(
    Match.tag('MeterCreate', (value) => createMeter(state, value, input)),
    Match.tag('MeterUpdate', (value) => updateMeter(state, value, input)),
    Match.tag('MeterReadingRecord', (value) => recordReading(state, value, input)),
    Match.tag('MeterReadingVoid', (value) => voidReading(state, value, input)),
    Match.exhaustive,
  );

export const metersAgenda = defineAgenda({
  commandSchema: MetersCommandSchema,
  empty: emptyMetersState,
  evolve: evolveMeters,
  id: 'meters',
  // Meter histories include tariffs and financial costs; operational-only identities must not receive them.
  sensitivity: 'restricted',
  stateSchema: MetersStateSchema,
});
