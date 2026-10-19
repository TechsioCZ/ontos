// Central agenda registry (owned by ops-scaffold). Lanes never need to edit this file:
// add commands in shared/commands/<agenda>.ts, state in shared/domain/<agenda>.ts.
import { Schema } from 'effect';
import { agendaAgenda, agendaCommandSchemas } from './commands/agenda.ts';
import { assetsAgenda, assetsCommandSchemas } from './commands/assets.ts';
import { documentsAgenda, documentsCommandSchemas } from './commands/documents.ts';
import { metersAgenda, metersCommandSchemas } from './commands/meters.ts';
import { purchasingAgenda, purchasingCommandSchemas } from './commands/purchasing.ts';
import { securityAgenda, securityCommandSchemas } from './commands/security.ts';
import type { AgendaDefinition, AgendaId } from './domain/common.ts';
import { TextSchema } from './domain/common.ts';

/** Maximum decoded size of one uploaded file (bytes). */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Base64 length of MAX_FILE_BYTES (4 chars per 3 bytes, padded). */
const MAX_FILE_BASE64_LENGTH = Math.ceil(MAX_FILE_BYTES / 3) * 4;

/**
 * Stores one binary file in demo_siampark_ops.files (RLS: tenant + legal entity). Requires write access to the
 * `documents` agenda. `expectedRevision` is ignored. Result: `entityIds: [fileId]` and `file: {id,name,mime,size}`;
 * pass that `file` snapshot to a documents command (e.g. DocumentCreate.file). Download: records read `{ fileId }`.
 */
export const FileUploadCommandSchema = Schema.TaggedStruct('FileUpload', {
  contentBase64: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_FILE_BASE64_LENGTH),
    Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/),
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

// biome-ignore lint: heterogeneous registry; each entry is fully typed in its own module.
type AnyAgenda = AgendaDefinition<any, any, any>;

export const agendaDefinitions: Readonly<Record<AgendaId, AnyAgenda>> = {
  agenda: agendaAgenda,
  assets: assetsAgenda,
  documents: documentsAgenda,
  meters: metersAgenda,
  purchasing: purchasingAgenda,
  security: securityAgenda,
};

export const agendaIds: readonly AgendaId[] = ['assets', 'meters', 'security', 'documents', 'agenda', 'purchasing'];

/** Agenda that owns a command (by schema membership). `undefined` for FileUpload. */
export const agendaOfCommand = (command: OpsCommand): AnyAgenda | undefined =>
  agendaIds.map((id) => agendaDefinitions[id]).find((definition) => Schema.is(definition.commandSchema)(command));
