// Siampark provoz — agenda `security` (S11 evidence bezpečnostních zařízení).
// OWNED BY THE `security` LANE. Change freely; keep exporting SecurityStateSchema and emptySecurityState.
// Old JSONB rows must still decode: add new fields as `Schema.optionalKey(...)` or reseed (pnpm demo:seed:siampark-ops).
import { Schema } from 'effect';
import { AuditFieldsSchema, IsoDateSchema, NoteSchema, PropertyRefSchema, TextSchema, opsIdOf } from './common.ts';

export const SecurityDeviceIdSchema = opsIdOf('SiamparkSecurityDeviceId');
export type SecurityDeviceId = typeof SecurityDeviceIdSchema.Type;

export const SecurityDeviceSchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  id: SecurityDeviceIdSchema,
  name: TextSchema(200),
  deviceType: TextSchema(120),
  location: Schema.optionalKey(PropertyRefSchema),
  nextInspectionDate: Schema.optionalKey(IsoDateSchema),
  note: Schema.optionalKey(NoteSchema),
});
export type SecurityDevice = typeof SecurityDeviceSchema.Type;

export const SecurityStateSchema = Schema.Struct({
  devices: Schema.Array(SecurityDeviceSchema),
});
export type SecurityState = typeof SecurityStateSchema.Type;
export type SecurityStateEncoded = typeof SecurityStateSchema.Encoded;

/** State written by the seed when nothing else is known. Must decode with SecurityStateSchema. */
export const emptySecurityState: SecurityStateEncoded = { devices: [] };
