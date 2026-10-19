// Siampark provoz — agenda `documents` (S12 dokumenty a verze + S14 komentáře a vlákna).
// OWNED BY THE `documents` LANE. Change freely; keep exporting DocumentsStateSchema and emptyDocumentsState.
// Old JSONB rows must still decode: add new fields as `Schema.optionalKey(...)` or reseed (pnpm demo:seed:siampark-ops).
import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { Schema } from 'effect';
import { AuditFieldsSchema, FileIdSchema, MinorAmountSchema, NoteSchema, PropertyRefSchema, TextSchema, opsIdOf } from './common.ts';

export const DocumentIdSchema = opsIdOf('SiamparkDocumentId');
export type DocumentId = typeof DocumentIdSchema.Type;

/** Snapshot of a stored file, as returned by the FileUpload command (`result.file`). */
export const StoredFileRefSchema = Schema.Struct({
  id: FileIdSchema,
  mime: TextSchema(200),
  name: TextSchema(300),
  size: MinorAmountSchema,
});
export type StoredFileRef = typeof StoredFileRefSchema.Type;

export const DocumentVersionSchema = Schema.Struct({
  file: StoredFileRefSchema,
  note: Schema.optionalKey(NoteSchema),
  uploadedAt: Schema.DateTimeUtcFromString,
  uploadedBy: PrincipalRefSchema,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type DocumentVersion = typeof DocumentVersionSchema.Type;

export const DocumentSchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  id: DocumentIdSchema,
  title: TextSchema(300),
  category: TextSchema(120),
  related: Schema.optionalKey(PropertyRefSchema),
  /** Newest last. Each version points to a stored file (FileUpload command → records read `fileId`). */
  versions: Schema.Array(DocumentVersionSchema),
});
export type DocumentRecord = typeof DocumentSchema.Type;

export const DocumentsStateSchema = Schema.Struct({
  documents: Schema.Array(DocumentSchema),
});
export type DocumentsState = typeof DocumentsStateSchema.Type;
export type DocumentsStateEncoded = typeof DocumentsStateSchema.Encoded;

/** State written by the seed when nothing else is known. Must decode with DocumentsStateSchema. */
export const emptyDocumentsState: DocumentsStateEncoded = { documents: [] };
