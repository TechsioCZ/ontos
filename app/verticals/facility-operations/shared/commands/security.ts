// Facility operations — commands of agenda `security` (S11 evidence bezpečnostních zařízení).
// OWNED BY THE `security` LANE. Tags are globally unique (`SecurityDevice…`, `SecurityIncident…`).
// The central dispatcher (shared/agendas.ts) picks the agenda by tag; nothing else needs editing.
// Evidence only („pouze evidence“): no command ever talks to a physical device.
import { Effect, Match, Schema } from 'effect';
import {
  auditCreated,
  auditUpdated,
  defineAgenda,
  entityIdOf,
  IsoDateSchema,
  mintId,
  NoteSchema,
  opsConflict,
  opsNotFound,
  PropertyRefSchema,
  TextSchema,
} from '../domain/common.ts';
import type { OpsCommandInput } from '../domain/common.ts';
import { StoredFileRefSchema } from '../domain/documents.ts';
import {
  SecurityAttachmentKindSchema,
  SecurityDeviceIdSchema,
  SecurityDeviceStateSchema,
  SecurityDeviceTypeSchema,
  SecurityIncidentIdSchema,
  SecurityIncidentStateSchema,
  SecuritySeveritySchema,
  SecurityStateSchema,
  emptySecurityState,
  isOpenIncident,
} from '../domain/security.ts';
import type {
  SecurityDevice,
  SecurityHistoryEntry,
  SecurityIncident,
  SecurityIncidentState,
  SecurityState,
} from '../domain/security.ts';

const deviceFields = {
  administrator: Schema.optionalKey(TextSchema(200)),
  lastInspectionDate: Schema.optionalKey(IsoDateSchema),
  location: Schema.optionalKey(PropertyRefSchema),
  locationDetail: Schema.optionalKey(TextSchema(300)),
  nextInspectionDate: Schema.optionalKey(IsoDateSchema),
  note: Schema.optionalKey(NoteSchema),
  serialNumber: Schema.optionalKey(TextSchema(120)),
  supplier: Schema.optionalKey(TextSchema(200)),
};

/** Fields an update may clear (empty form value → key removed from the card). */
const ClearableDeviceFieldSchema = Schema.Literals([
  'administrator',
  'lastInspectionDate',
  'location',
  'locationDetail',
  'nextInspectionDate',
  'note',
  'serialNumber',
  'supplier',
]);

export const securityCommandSchemas = [
  Schema.TaggedStruct('SecurityDeviceCreate', {
    ...deviceFields,
    deviceType: SecurityDeviceTypeSchema,
    name: TextSchema(200),
    state: Schema.optionalKey(SecurityDeviceStateSchema),
  }),
  Schema.TaggedStruct('SecurityDeviceUpdate', {
    ...deviceFields,
    clear: Schema.optionalKey(Schema.Array(ClearableDeviceFieldSchema)),
    deviceId: SecurityDeviceIdSchema,
    deviceType: Schema.optionalKey(SecurityDeviceTypeSchema),
    name: Schema.optionalKey(TextSchema(200)),
    state: Schema.optionalKey(SecurityDeviceStateSchema),
  }),
  Schema.TaggedStruct('SecurityDeviceRecordInspection', {
    deviceId: SecurityDeviceIdSchema,
    inspectionDate: IsoDateSchema,
    nextInspectionDate: Schema.optionalKey(IsoDateSchema),
    note: Schema.optionalKey(NoteSchema),
  }),
  Schema.TaggedStruct('SecurityDeviceAttach', {
    deviceId: SecurityDeviceIdSchema,
    file: StoredFileRefSchema,
    kind: SecurityAttachmentKindSchema,
  }),
  Schema.TaggedStruct('SecurityIncidentReport', {
    description: Schema.optionalKey(NoteSchema),
    deviceId: SecurityDeviceIdSchema,
    occurredOn: IsoDateSchema,
    severity: SecuritySeveritySchema,
    title: TextSchema(200),
  }),
  Schema.TaggedStruct('SecurityIncidentLinkTask', {
    incidentId: SecurityIncidentIdSchema,
    task: Schema.Struct({ resourceId: TextSchema(300), tenantId: TextSchema(64), title: TextSchema(200) }),
  }),
  Schema.TaggedStruct('SecurityIncidentChangeState', {
    incidentId: SecurityIncidentIdSchema,
    resolution: Schema.optionalKey(NoteSchema),
    state: SecurityIncidentStateSchema,
  }),
] as const;

export const SecurityCommandSchema = Schema.Union(securityCommandSchemas);
export type SecurityCommand = typeof SecurityCommandSchema.Type;
type CommandOf<Tag extends SecurityCommand['_tag']> = Extract<SecurityCommand, { readonly _tag: Tag }>;

const historyEntry = (
  input: OpsCommandInput,
  event: SecurityHistoryEntry['event'],
  summary: string,
): SecurityHistoryEntry => ({ at: input.now, by: input.actor, event, summary: summary.slice(0, 500) });

const withHistory = (device: SecurityDevice, entry: SecurityHistoryEntry): SecurityDevice => ({
  ...device,
  history: [...(device.history ?? []), entry],
});

const findDevice = (state: SecurityState, deviceId: string) =>
  Effect.fromNullishOr(state.devices.find((device) => device.id === deviceId)).pipe(
    Effect.mapError(() => opsNotFound('Bezpečnostní zařízení neexistuje.')),
  );

const findIncident = (state: SecurityState, incidentId: string) =>
  Effect.fromNullishOr((state.incidents ?? []).find((incident) => incident.id === incidentId)).pipe(
    Effect.mapError(() => opsNotFound('Porucha neexistuje.')),
  );

const replaceDevice = (state: SecurityState, device: SecurityDevice): SecurityState => ({
  ...state,
  devices: state.devices.map((entry) => (entry.id === device.id ? device : entry)),
});

const replaceIncident = (state: SecurityState, incident: SecurityIncident): SecurityState => ({
  ...state,
  incidents: (state.incidents ?? []).map((entry) => (entry.id === incident.id ? incident : entry)),
});

const definedOnly = <Value extends object>(value: Value): Partial<Value> =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<Value>;

const createDevice = Effect.fn('FacilityOperations.Security.createDevice')(function* createDevice(
  state: SecurityState,
  value: CommandOf<'SecurityDeviceCreate'>,
  input: OpsCommandInput,
) {
  const id = yield* mintId(SecurityDeviceIdSchema, input.resourceId);
  if (state.devices.some((device) => device.id === id)) {
    return yield* opsConflict('Zařízení s tímto identifikátorem už existuje.');
  }
  const { _tag, state: initialState, ...fields } = value;
  void _tag;
  const record: SecurityDevice = {
    ...fields,
    ...auditCreated(input),
    attachments: [],
    history: [historyEntry(input, 'created', `Karta založena: ${value.name}`)],
    id,
    state: initialState ?? 'in_operation',
  };
  const entity = yield* entityIdOf(id);
  return { entityIds: [entity], state: { ...state, devices: [...state.devices, record] } };
});

const updateDevice = Effect.fn('FacilityOperations.Security.updateDevice')(function* updateDevice(
  state: SecurityState,
  value: CommandOf<'SecurityDeviceUpdate'>,
  input: OpsCommandInput,
) {
  const device = yield* findDevice(state, value.deviceId);
  const { _tag, clear, deviceId, ...changes } = value;
  void _tag;
  void deviceId;
  const cleared: Record<string, unknown> = { ...device, ...definedOnly(changes) };
  for (const key of clear ?? []) {
    delete cleared[key];
  }
  const next = auditUpdated(cleared as SecurityDevice, input);
  const changedState = value.state !== undefined && value.state !== device.state;
  const summary = changedState ? `Změna stavu: ${device.state} → ${value.state}` : 'Údaje karty upraveny';
  const updated = withHistory(next, historyEntry(input, changedState ? 'state_changed' : 'updated', summary));
  return { entityIds: [yield* entityIdOf(device.id)], state: replaceDevice(state, updated) };
});

const recordInspection = Effect.fn('FacilityOperations.Security.recordInspection')(function* recordInspection(
  state: SecurityState,
  value: CommandOf<'SecurityDeviceRecordInspection'>,
  input: OpsCommandInput,
) {
  const device = yield* findDevice(state, value.deviceId);
  if (value.nextInspectionDate !== undefined && value.nextInspectionDate <= value.inspectionDate) {
    return yield* opsConflict('Další kontrola musí být po datu provedené kontroly.');
  }
  const next: SecurityDevice = {
    ...auditUpdated(device, input),
    lastInspectionDate: value.inspectionDate,
    ...(value.nextInspectionDate === undefined ? {} : { nextInspectionDate: value.nextInspectionDate }),
  };
  const summary = `Kontrola provedena ${value.inspectionDate}${value.note === undefined || value.note === '' ? '' : `: ${value.note}`}`;
  return {
    entityIds: [yield* entityIdOf(device.id)],
    state: replaceDevice(state, withHistory(next, historyEntry(input, 'inspection', summary))),
  };
});

const attachFile = Effect.fn('FacilityOperations.Security.attachFile')(function* attachFile(
  state: SecurityState,
  value: CommandOf<'SecurityDeviceAttach'>,
  input: OpsCommandInput,
) {
  const device = yield* findDevice(state, value.deviceId);
  if ((device.attachments ?? []).some((attachment) => attachment.file.id === value.file.id)) {
    return yield* opsConflict('Tento soubor je už k zařízení připojen.');
  }
  const next: SecurityDevice = {
    ...auditUpdated(device, input),
    attachments: [
      ...(device.attachments ?? []),
      { addedAt: input.now, addedBy: input.actor, file: value.file, kind: value.kind },
    ],
  };
  return {
    entityIds: [yield* entityIdOf(device.id), yield* entityIdOf(value.file.id)],
    state: replaceDevice(
      state,
      withHistory(next, historyEntry(input, 'attachment', `Připojen soubor ${value.file.name}`)),
    ),
  };
});

const reportIncident = Effect.fn('FacilityOperations.Security.reportIncident')(function* reportIncident(
  state: SecurityState,
  value: CommandOf<'SecurityIncidentReport'>,
  input: OpsCommandInput,
) {
  const device = yield* findDevice(state, value.deviceId);
  if (device.state === 'decommissioned') {
    return yield* opsConflict('K vyřazenému zařízení nelze hlásit poruchu.');
  }
  const id = yield* mintId(SecurityIncidentIdSchema, input.resourceId);
  if ((state.incidents ?? []).some((incident) => incident.id === id)) {
    return yield* opsConflict('Porucha s tímto identifikátorem už existuje.');
  }
  const { _tag, ...fields } = value;
  void _tag;
  const incident: SecurityIncident = { ...fields, ...auditCreated(input), id, state: 'reported' };
  const faulted: SecurityDevice = device.state === 'in_operation' ? { ...device, state: 'fault' } : device;
  const nextDevice = withHistory(
    auditUpdated(faulted, input),
    historyEntry(input, 'incident_reported', `Nahlášena porucha: ${value.title}`),
  );
  return {
    entityIds: [yield* entityIdOf(id), yield* entityIdOf(device.id)],
    state: { ...replaceDevice(state, nextDevice), incidents: [...(state.incidents ?? []), incident] },
  };
});

const linkTask = Effect.fn('FacilityOperations.Security.linkTask')(function* linkTask(
  state: SecurityState,
  value: CommandOf<'SecurityIncidentLinkTask'>,
  input: OpsCommandInput,
) {
  const incident = yield* findIncident(state, value.incidentId);
  if (incident.task !== undefined) {
    return yield* opsConflict('Porucha už má propojený úkol.');
  }
  const device = yield* findDevice(state, incident.deviceId);
  const next: SecurityIncident = {
    ...auditUpdated(incident, input),
    task: { ...value.task, linkedAt: input.now, linkedBy: input.actor },
  };
  const nextDevice = withHistory(device, historyEntry(input, 'task_linked', `Propojen úkol: ${value.task.title}`));
  return {
    entityIds: [yield* entityIdOf(incident.id)],
    state: replaceDevice(replaceIncident(state, next), nextDevice),
  };
});

const allowedIncidentTransitions: Readonly<Record<SecurityIncidentState, readonly SecurityIncidentState[]>> = {
  in_progress: ['resolved', 'reported'],
  reported: ['in_progress', 'resolved'],
  resolved: ['in_progress'],
};

const changeIncidentState = Effect.fn('FacilityOperations.Security.changeIncidentState')(function* changeIncidentState(
  state: SecurityState,
  value: CommandOf<'SecurityIncidentChangeState'>,
  input: OpsCommandInput,
) {
  const incident = yield* findIncident(state, value.incidentId);
  if (!allowedIncidentTransitions[incident.state].includes(value.state)) {
    return yield* opsConflict('Tuto změnu stavu poruchy nelze provést.');
  }
  const base = auditUpdated(incident, input);
  const next: SecurityIncident =
    value.state === 'resolved'
      ? {
          ...base,
          ...(value.resolution === undefined || value.resolution === '' ? {} : { resolution: value.resolution }),
          resolvedAt: input.now,
          state: 'resolved',
        }
      : (() => {
          const { resolvedAt, ...rest } = base;
          void resolvedAt;
          return { ...rest, state: value.state };
        })();
  const withIncident = replaceIncident(state, next);
  const device = yield* findDevice(withIncident, incident.deviceId);
  const otherOpen = (withIncident.incidents ?? []).some(
    (entry) => entry.deviceId === device.id && entry.id !== incident.id && isOpenIncident(entry),
  );
  const deviceState =
    value.state === 'resolved' && device.state === 'fault' && !otherOpen
      ? 'in_operation'
      : value.state !== 'resolved' && device.state === 'in_operation'
        ? 'fault'
        : device.state;
  const label = { in_progress: 'v řešení', reported: 'nahlášeno', resolved: 'vyřešeno' }[value.state];
  const nextDevice = withHistory(
    deviceState === device.state ? device : auditUpdated({ ...device, state: deviceState }, input),
    historyEntry(input, 'incident_state', `Porucha „${incident.title}“: ${label}`),
  );
  return { entityIds: [yield* entityIdOf(incident.id)], state: replaceDevice(withIncident, nextDevice) };
});

/** Pure reducer: applies one command to the `security` state. Persistence decides when it is saved. */
export const evolveSecurity = (state: SecurityState, command: SecurityCommand, input: OpsCommandInput) =>
  Match.value(command).pipe(
    Match.tag('SecurityDeviceCreate', (value) => createDevice(state, value, input)),
    Match.tag('SecurityDeviceUpdate', (value) => updateDevice(state, value, input)),
    Match.tag('SecurityDeviceRecordInspection', (value) => recordInspection(state, value, input)),
    Match.tag('SecurityDeviceAttach', (value) => attachFile(state, value, input)),
    Match.tag('SecurityIncidentReport', (value) => reportIncident(state, value, input)),
    Match.tag('SecurityIncidentLinkTask', (value) => linkTask(state, value, input)),
    Match.tag('SecurityIncidentChangeState', (value) => changeIncidentState(state, value, input)),
    Match.exhaustive,
  );

/** Next planned inspection at or before `today` (YYYY-MM-DD) — used for the „po termínu“ badge. */
export const isInspectionOverdue = (device: SecurityDevice, today: string) =>
  device.state !== 'decommissioned' && device.nextInspectionDate !== undefined && device.nextInspectionDate < today;

export const securityAgenda = defineAgenda({
  commandSchema: SecurityCommandSchema,
  empty: emptySecurityState,
  evolve: evolveSecurity,
  id: 'security',
  sensitivity: 'restricted',
  stateSchema: SecurityStateSchema,
});
