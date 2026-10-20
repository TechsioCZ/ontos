// Siampark provoz — agenda `security` (S11 evidence bezpečnostních zařízení).
// OWNED BY THE `security` LANE. Evidence only: OntOS never controls cameras, alarms, readers or doors.
// Old JSONB rows must still decode: add new fields as `Schema.optionalKey(...)` or reseed.
import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { Schema } from 'effect';
import { AuditFieldsSchema, IsoDateSchema, NoteSchema, PropertyRefSchema, TextSchema, opsIdOf } from './common.ts';
import { StoredFileRefSchema } from './documents.ts';

export const SecurityDeviceIdSchema = opsIdOf('SiamparkSecurityDeviceId');
export type SecurityDeviceId = typeof SecurityDeviceIdSchema.Type;
export const SecurityIncidentIdSchema = opsIdOf('SiamparkSecurityIncidentId');
export type SecurityIncidentId = typeof SecurityIncidentIdSchema.Type;

/** S11: camera / access control / alarm / other. */
export const SecurityDeviceTypeSchema = Schema.Literals(['camera', 'access', 'alarm', 'other']);
export type SecurityDeviceType = typeof SecurityDeviceTypeSchema.Type;
export const securityDeviceTypes = SecurityDeviceTypeSchema.literals;

/** Operating state as recorded by people (evidence only, never read from the device). */
export const SecurityDeviceStateSchema = Schema.Literals(['in_operation', 'fault', 'in_service', 'decommissioned']);
export type SecurityDeviceState = typeof SecurityDeviceStateSchema.Type;
export const securityDeviceStates = SecurityDeviceStateSchema.literals;

/** Attachment kinds required by S11: revision protocol, manual, service contract. */
export const SecurityAttachmentKindSchema = Schema.Literals(['revision_protocol', 'manual', 'contract', 'other']);
export type SecurityAttachmentKind = typeof SecurityAttachmentKindSchema.Type;
export const securityAttachmentKinds = SecurityAttachmentKindSchema.literals;

export const SecuritySeveritySchema = Schema.Literals(['low', 'medium', 'high', 'critical']);
export type SecuritySeverity = typeof SecuritySeveritySchema.Type;
export const securitySeverities = SecuritySeveritySchema.literals;

export const SecurityIncidentStateSchema = Schema.Literals(['reported', 'in_progress', 'resolved']);
export type SecurityIncidentState = typeof SecurityIncidentStateSchema.Type;
export const securityIncidentStates = SecurityIncidentStateSchema.literals;

export const SecurityAttachmentSchema = Schema.Struct({
  addedAt: Schema.DateTimeUtcFromString,
  addedBy: PrincipalRefSchema,
  file: StoredFileRefSchema,
  kind: SecurityAttachmentKindSchema,
});
export type SecurityAttachment = typeof SecurityAttachmentSchema.Type;

/** Append-only change log of one device (S00: history of sensitive changes is never lost). */
export const SecurityHistoryEntrySchema = Schema.Struct({
  at: Schema.DateTimeUtcFromString,
  by: PrincipalRefSchema,
  event: Schema.Literals([
    'created',
    'updated',
    'inspection',
    'attachment',
    'incident_reported',
    'incident_state',
    'task_linked',
    'state_changed',
  ]),
  summary: TextSchema(500),
});
export type SecurityHistoryEntry = typeof SecurityHistoryEntrySchema.Type;

export const SecurityDeviceSchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  administrator: Schema.optionalKey(TextSchema(200)),
  attachments: Schema.optionalKey(Schema.Array(SecurityAttachmentSchema)),
  deviceType: SecurityDeviceTypeSchema,
  history: Schema.optionalKey(Schema.Array(SecurityHistoryEntrySchema)),
  id: SecurityDeviceIdSchema,
  lastInspectionDate: Schema.optionalKey(IsoDateSchema),
  location: Schema.optionalKey(PropertyRefSchema),
  /** Free-text placement inside the property/unit, e.g. „Vstupní hala, strop u recepce“. */
  locationDetail: Schema.optionalKey(TextSchema(300)),
  name: TextSchema(200),
  nextInspectionDate: Schema.optionalKey(IsoDateSchema),
  note: Schema.optionalKey(NoteSchema),
  serialNumber: Schema.optionalKey(TextSchema(120)),
  state: SecurityDeviceStateSchema,
  supplier: Schema.optionalKey(TextSchema(200)),
});
export type SecurityDevice = typeof SecurityDeviceSchema.Type;

/** Snapshot of a task created in siampark-work (opaque cross-module reference + display title). */
export const LinkedTaskSchema = Schema.Struct({
  linkedAt: Schema.DateTimeUtcFromString,
  linkedBy: PrincipalRefSchema,
  resourceId: TextSchema(300),
  tenantId: TextSchema(64),
  title: TextSchema(200),
});
export type LinkedTask = typeof LinkedTaskSchema.Type;

export const SecurityIncidentSchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  description: Schema.optionalKey(NoteSchema),
  deviceId: SecurityDeviceIdSchema,
  id: SecurityIncidentIdSchema,
  occurredOn: IsoDateSchema,
  resolution: Schema.optionalKey(NoteSchema),
  resolvedAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  severity: SecuritySeveritySchema,
  state: SecurityIncidentStateSchema,
  task: Schema.optionalKey(LinkedTaskSchema),
  title: TextSchema(200),
});
export type SecurityIncident = typeof SecurityIncidentSchema.Type;

export const SecurityStateSchema = Schema.Struct({
  devices: Schema.Array(SecurityDeviceSchema),
  incidents: Schema.optionalKey(Schema.Array(SecurityIncidentSchema)),
});
export type SecurityState = typeof SecurityStateSchema.Type;
export type SecurityStateEncoded = typeof SecurityStateSchema.Encoded;

/** State written by the seed when nothing else is known. Must decode with SecurityStateSchema. */
export const emptySecurityState: SecurityStateEncoded = { devices: [], incidents: [] };

export const isOpenIncident = (incident: SecurityIncident) => incident.state !== 'resolved';
