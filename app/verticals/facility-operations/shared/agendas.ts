// Central agenda registry (owned by ops-scaffold). Lanes never need to edit this file:
// add commands in shared/commands/<agenda>.ts, state in shared/domain/<agenda>.ts.
import { Schema } from 'effect';
import type { Effect } from 'effect';
import { agendaAgenda, agendaCommandSchemas } from './commands/agenda.ts';
import { assetsAgenda, assetsCommandSchemas } from './commands/assets.ts';
import { documentsAgenda, documentsCommandSchemas } from './commands/documents.ts';
import { metersAgenda, metersCommandSchemas } from './commands/meters.ts';
import { purchasingAgenda, purchasingCommandSchemas } from './commands/purchasing.ts';
import { securityAgenda, securityCommandSchemas } from './commands/security.ts';
import type { AgendaId, AgendaSensitivity, EntityId, OpsCommandError, OpsCommandInput } from './domain/common.ts';
import { TextSchema } from './domain/common.ts';

/** Maximum decoded size of one uploaded file (bytes). */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Base64 length of MAX_FILE_BYTES (4 chars per 3 bytes, padded). */
const MAX_FILE_BASE64_LENGTH = Math.ceil(MAX_FILE_BYTES / 3) * 4;

/**
 * Stores one binary file in facility_operations.files (RLS: tenant + legal entity). Requires write access to the
 * `documents` agenda. `expectedRevision` is ignored. Result: `entityIds: [fileId]` and `file: {id,name,mime,size}`;
 * pass that `file` snapshot to a documents command (e.g. DocumentCreate.file). Download: records read `{ fileId }`.
 */
export const FileUploadCommandSchema = Schema.TaggedStruct('FileUpload', {
  contentBase64: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_FILE_BASE64_LENGTH),
    Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/u),
  ),
  mime: TextSchema(200),
  name: TextSchema(300),
});
export type FileUploadCommand = typeof FileUploadCommandSchema.Type;

export const OpsCommandSchema = Schema.Union([
  ...assetsCommandSchemas,
  ...metersCommandSchemas,
  ...securityCommandSchemas,
  ...documentsCommandSchemas,
  ...agendaCommandSchemas,
  ...purchasingCommandSchemas,
  FileUploadCommandSchema,
]);
export type OpsCommand = typeof OpsCommandSchema.Type;

export const agendaDefinitions = {
  agenda: agendaAgenda,
  assets: assetsAgenda,
  documents: documentsAgenda,
  meters: metersAgenda,
  purchasing: purchasingAgenda,
  security: securityAgenda,
};

export const agendaIds: readonly AgendaId[] = ['assets', 'meters', 'security', 'documents', 'agenda', 'purchasing'];

type DecodedAgendaState = (typeof agendaDefinitions)[AgendaId]['stateSchema']['Type'];
type EncodedAgendaState = (typeof agendaDefinitions)[AgendaId]['stateSchema']['Encoded'];

/** One checked reducer outcome; encoding is deferred until record-conflict checks succeed. */
export interface AgendaDispatchResult {
  readonly encoding: Effect.Effect<EncodedAgendaState, Schema.SchemaError>;
  readonly entityIds: readonly EntityId[];
}

/** A selected owner keeps its schema-specific state behind its checked dispatch boundary. */
export interface AgendaCommandOwner {
  readonly dispatch: (
    state: DecodedAgendaState,
    command: Exclude<OpsCommand, FileUploadCommand>,
    input: OpsCommandInput,
  ) => Effect.Effect<AgendaDispatchResult, Schema.SchemaError | OpsCommandError>;
  readonly id: AgendaId;
  readonly sensitivity: AgendaSensitivity;
}

/** Agenda that owns a command (by schema membership). `undefined` for FileUpload. */
export const agendaOfCommand = (command: OpsCommand): AgendaCommandOwner | undefined =>
  agendaIds.map((id) => agendaDefinitions[id]).find((definition) => Schema.is(definition.commandSchema)(command));
