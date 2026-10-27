import { Schema as Shapes } from 'effect';
import { AuditSchema, resourceId, text } from './imported-device-parts.ts';

export { CalendarDateWireSchema as CivilDaySchema } from '@app/shared-contracts';
const DeviceSchema = Shapes.Struct({
  ...AuditSchema.fields,
  id: resourceId('DeviceId'),
  name: text(200),
  state: Shapes.Literals(['active', 'retired']),
  notes: Shapes.optionalKey(Shapes.Array(Shapes.String)),
});
export type Device = typeof DeviceSchema.Type;
