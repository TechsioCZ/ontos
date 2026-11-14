// Facility operations — agenda `documents` (S12 dokumenty a verze + S14 komentáře a vlákna).
// OWNED BY THE `documents` LANE. Change freely; keep exporting DocumentsStateSchema and emptyDocumentsState.
// Old JSONB rows must still decode: add new fields as `Schema.optionalKey(...)` or reseed (pnpm demo:seed:facility-operations).
import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { Schema } from 'effect';
import {
  AuditFieldsSchema,
  FileIdSchema,
  IsoDateSchema,
  MinorAmountSchema,
  NoteSchema,
  PropertyRefSchema,
  TextSchema,
  OpsIdSchema,
} from './common.ts';

export const DocumentIdSchema = OpsIdSchema.pipe(Schema.brand('FacilityDocumentId'));

export const CommentIdSchema = OpsIdSchema.pipe(Schema.brand('FacilityCommentId'));

/** Snapshot of a stored file, as returned by the FileUpload command (`result.file`). */
export const StoredFileRefSchema = Schema.Struct({
  id: FileIdSchema,
  mime: TextSchema(200),
  name: TextSchema(300),
  size: MinorAmountSchema,
});
export type StoredFileRef = typeof StoredFileRefSchema.Type;

/**
 * Typed reference to any record a document or comment belongs to (S12.R3, S14.R1): a Nájempark property, unit,
 * asset, contract, tenant, invoice, task, incident, another document, a conversation channel… `kind` is an open
 * short key (e.g. `property`, `unit`, `asset`, `contract`, `tenant`, `document`, `task`, `incident`, `meter`,
 * `channel`); `label` is a display snapshot taken when the link was made. Never joined to another module's tables.
 */
export const SubjectRefSchema = Schema.Struct({
  id: TextSchema(300),
  kind: TextSchema(60),
  label: TextSchema(300),
});
export type SubjectRef = typeof SubjectRefSchema.Type;

export const DocumentVersionSchema = Schema.Struct({
  file: StoredFileRefSchema,
  note: Schema.optionalKey(NoteSchema),
  uploadedAt: Schema.DateTimeUtcFromString,
  uploadedBy: PrincipalRefSchema,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

/** Contract lifecycle shown on the contract register (S12.R1). Draft parameters, not a legal statement. */
export const ContractStatusSchema = Schema.Literals(['draft', 'active', 'terminated', 'expired']);
export type ContractStatus = typeof ContractStatusSchema.Type;

/** Contract metadata carried by documents of category `contract` / `amendment` (S12.R1, S12.R2). */
export const ContractTermsSchema = Schema.Struct({
  /** Smluvní strany (each a display name). */
  parties: Schema.Array(TextSchema(300)).check(Schema.isMaxLength(10)),
  /** Typ smlouvy, e.g. „Nájemní smlouva“. */
  contractType: TextSchema(120),
  /** Předmět smlouvy. */
  subject: Schema.optionalKey(TextSchema(1000)),
  validFrom: Schema.optionalKey(IsoDateSchema),
  validTo: Schema.optionalKey(IsoDateSchema),
  /** Částka nebo podmínka (free text, e.g. „38 500 Kč měsíčně + zálohy“). */
  amountTerms: Schema.optionalKey(TextSchema(500)),
  /** Výpovědní lhůta (text). */
  noticePeriod: Schema.optionalKey(TextSchema(300)),
  /** Last day to give notice, if known. */
  noticeDate: Schema.optionalKey(IsoDateSchema),
  status: ContractStatusSchema,
  /** Odpovědná osoba (vlastník smlouvy). */
  owner: TextSchema(200),
});
export type ContractTerms = typeof ContractTermsSchema.Type;

/** Manual signature record (S12.R5) — not an e-signature service. Points at the version holding the signed scan. */
export const SignatureRecordSchema = Schema.Struct({
  recordedAt: Schema.DateTimeUtcFromString,
  recordedBy: PrincipalRefSchema,
  signedBy: TextSchema(300),
  signedOn: IsoDateSchema,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

export const DocumentSchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  id: DocumentIdSchema,
  title: TextSchema(300),
  /** Known keys: contract, amendment, annex, protocol, revision, invoice, photo, plan, other (free text tolerated). */
  category: TextSchema(120),
  /** Scaffold-era single property/unit link. New documents use `links`. */
  contract: Schema.optionalKey(ContractTermsSchema),
  description: Schema.optionalKey(NoteSchema),
  links: Schema.optionalKey(Schema.Array(SubjectRefSchema).check(Schema.isMaxLength(20))),
  related: Schema.optionalKey(PropertyRefSchema),
  /** Amendment (dodatek) or annex of this original contract document. */
  amendsDocumentId: Schema.optionalKey(DocumentIdSchema),
  signature: Schema.optionalKey(SignatureRecordSchema),
  /** Newest last. Each version points to a stored file (FileUpload command → records read `fileId`). */
  versions: Schema.Array(DocumentVersionSchema),
});
export type DocumentRecord = typeof DocumentSchema.Type;

/** One earlier wording of an edited comment (S14.R3: history stays traceable). */
export const CommentEditSchema = Schema.Struct({
  body: TextSchema(4000),
  editedAt: Schema.DateTimeUtcFromString,
  editedBy: PrincipalRefSchema,
});

/** Comment or message in a thread attached to any record or channel (S14). */
export const CommentSchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  body: TextSchema(4000),
  id: CommentIdSchema,
  subject: SubjectRefSchema,
  /** Optional link to an allowed record or an already stored document (S14.R2). */
  attachment: Schema.optionalKey(SubjectRefSchema),
  /** Display names mentioned with @ (optional, informational). */
  mentions: Schema.optionalKey(Schema.Array(TextSchema(200)).check(Schema.isMaxLength(20))),
  /** Previous wordings, oldest first. */
  edits: Schema.Array(CommentEditSchema),
  retractedAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  retractedBy: Schema.optionalKey(PrincipalRefSchema),
});
export type CommentRecord = typeof CommentSchema.Type;

export const DocumentsStateSchema = Schema.Struct({
  comments: Schema.optionalKey(Schema.Array(CommentSchema)),
  documents: Schema.Array(DocumentSchema),
});
export type DocumentsState = typeof DocumentsStateSchema.Type;
export type DocumentsStateEncoded = typeof DocumentsStateSchema.Encoded;

/** State written by the seed when nothing else is known. Must decode with DocumentsStateSchema. */
export const emptyDocumentsState: DocumentsStateEncoded = { comments: [], documents: [] };

/** Same subject (kind + id). */
export const sameSubject = (left: SubjectRef, right: SubjectRef) => left.kind === right.kind && left.id === right.id;

/** All links of a document, including the scaffold-era `related` property link. */
export const documentLinks = (document: DocumentRecord): readonly SubjectRef[] => {
  const links = document.links ?? [];
  const { related } = document;
  if (related === undefined || links.some((link) => link.kind === related.kind && link.id === related.id)) {
    return links;
  }
  return [related, ...links];
};
