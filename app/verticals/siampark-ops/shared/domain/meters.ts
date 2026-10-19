// Siampark provoz — agenda `meters` (S04 média, měřidla a odečty).
// OWNED BY THE `meters` LANE. Change freely; keep exporting MetersStateSchema and emptyMetersState.
// Old JSONB rows must still decode: add new fields as `Schema.optionalKey(...)` or reseed (pnpm demo:seed:siampark-ops).
import { Schema } from 'effect';
import { AuditFieldsSchema, NoteSchema, PropertyRefSchema, TextSchema, opsIdOf } from './common.ts';

export const MeterIdSchema = opsIdOf('SiamparkMeterId');
export type MeterId = typeof MeterIdSchema.Type;

export const MeterSchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  id: MeterIdSchema,
  serialNumber: TextSchema(64),
  medium: Schema.Literals(['ELECTRICITY', 'WATER', 'GAS', 'HEAT']),
  unit: TextSchema(16),
  location: Schema.optionalKey(PropertyRefSchema),
  note: Schema.optionalKey(NoteSchema),
});
export type Meter = typeof MeterSchema.Type;

export const MetersStateSchema = Schema.Struct({
  meters: Schema.Array(MeterSchema),
});
export type MetersState = typeof MetersStateSchema.Type;
export type MetersStateEncoded = typeof MetersStateSchema.Encoded;

/** State written by the seed when nothing else is known. Must decode with MetersStateSchema. */
export const emptyMetersState: MetersStateEncoded = { meters: [] };
