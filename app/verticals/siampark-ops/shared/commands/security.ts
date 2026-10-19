// Siampark provoz — commands of agenda `security` (S11 evidence bezpečnostních zařízení).
// OWNED BY THE `security` LANE. To add a command: append a Schema.TaggedStruct to `securityCommandSchemas`
// (tag must be globally unique, prefix it like `SecurityDevice…`), then handle it in `evolveSecurity`.
// The central dispatcher (shared/agendas.ts) picks the agenda by tag; nothing else needs editing.
import { Effect, Match, Schema } from 'effect';
import { auditCreated, defineAgenda, entityIdOf, IsoDateSchema, mintId, NoteSchema, PropertyRefSchema, TextSchema } from '../domain/common.ts';
import type { OpsCommandInput } from '../domain/common.ts';
import { SecurityStateSchema, SecurityDeviceIdSchema, emptySecurityState } from '../domain/security.ts';
import type { SecurityState, SecurityDevice } from '../domain/security.ts';

export const securityCommandSchemas = [
  Schema.TaggedStruct('SecurityDeviceCreate', {
    name: TextSchema(200),
    deviceType: TextSchema(120),
    location: Schema.optionalKey(PropertyRefSchema),
    nextInspectionDate: Schema.optionalKey(IsoDateSchema),
    note: Schema.optionalKey(NoteSchema),
  }),
] as const;

export const SecurityCommandSchema = Schema.Union(securityCommandSchemas);
export type SecurityCommand = typeof SecurityCommandSchema.Type;
type CommandOf<Tag extends SecurityCommand['_tag']> = Extract<SecurityCommand, { readonly _tag: Tag }>;

const createSecurityDevice = Effect.fn('SiamparkOps.Security.create')(function* createSecurityDevice(
  state: SecurityState,
  value: CommandOf<'SecurityDeviceCreate'>,
  input: OpsCommandInput,
) {
  const id = yield* mintId(SecurityDeviceIdSchema, input.resourceId);
  const { _tag, ...fields } = value;
  void _tag;
  const record: SecurityDevice = { ...fields, ...auditCreated(input), id };
  const entity = yield* entityIdOf(id);
  return { entityIds: [entity], state: { ...state, devices: [...state.devices, record] } };
});

/** Pure reducer: applies one command to the `security` state. Persistence decides when it is saved. */
export const evolveSecurity = (state: SecurityState, command: SecurityCommand, input: OpsCommandInput) =>
  Match.value(command).pipe(
    Match.tag('SecurityDeviceCreate', (value) => createSecurityDevice(state, value, input)),
    Match.exhaustive,
  );

export const securityAgenda = defineAgenda({
  commandSchema: SecurityCommandSchema,
  empty: emptySecurityState,
  evolve: evolveSecurity,
  id: 'security',
  sensitivity: 'restricted',
  stateSchema: SecurityStateSchema,
});
