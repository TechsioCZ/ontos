// Siampark provoz — commands of agenda `documents` (S12 dokumenty a verze + S14 komentáře a vlákna).
// OWNED BY THE `documents` LANE. To add a command: append a Schema.TaggedStruct to `documentsCommandSchemas`
// (tag must be globally unique, prefix it like `Document…`), then handle it in `evolveDocuments`.
// The central dispatcher (shared/agendas.ts) picks the agenda by tag; nothing else needs editing.
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
import {
  CommentIdSchema,
  ContractTermsSchema,
  DocumentIdSchema,
  DocumentsStateSchema,
  emptyDocumentsState,
  StoredFileRefSchema,
  SubjectRefSchema,
} from '../domain/documents.ts';
import type { CommentRecord, DocumentRecord, DocumentsState } from '../domain/documents.ts';

const LinksSchema = Schema.Array(SubjectRefSchema).check(Schema.isMaxLength(20));

export const documentsCommandSchemas = [
  /** New document (smlouva, dodatek, protokol, revize, fotografie…), optionally with its first file version. */
  Schema.TaggedStruct('DocumentCreate', {
    title: TextSchema(300),
    category: TextSchema(120),
    related: Schema.optionalKey(PropertyRefSchema),
    links: Schema.optionalKey(LinksSchema),
    description: Schema.optionalKey(NoteSchema),
    contract: Schema.optionalKey(ContractTermsSchema),
    /** Dodatek / příloha k původní smlouvě (must be an existing document). */
    amendsDocumentId: Schema.optionalKey(DocumentIdSchema),
    /** Optional first version: the `file` returned by a prior FileUpload command. */
    file: Schema.optionalKey(StoredFileRefSchema),
    note: Schema.optionalKey(NoteSchema),
  }),
  /** Metadata change. Omitted fields stay as they are; files and versions are never touched. */
  Schema.TaggedStruct('DocumentUpdate', {
    documentId: DocumentIdSchema,
    title: Schema.optionalKey(TextSchema(300)),
    category: Schema.optionalKey(TextSchema(120)),
    links: Schema.optionalKey(LinksSchema),
    description: Schema.optionalKey(NoteSchema),
    contract: Schema.optionalKey(ContractTermsSchema),
  }),
  /** Adds a new file version; earlier versions stay downloadable (S12-02). */
  Schema.TaggedStruct('DocumentVersionAdd', {
    documentId: DocumentIdSchema,
    file: StoredFileRefSchema,
    note: Schema.optionalKey(NoteSchema),
  }),
  /** Manual signature evidence (S12.R5): who signed, when, and which stored version is the signed scan. */
  Schema.TaggedStruct('DocumentSignatureRecord', {
    documentId: DocumentIdSchema,
    signedBy: TextSchema(300),
    signedOn: IsoDateSchema,
    version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }),
  /** New comment or message on any record or channel (S14-01). */
  Schema.TaggedStruct('DocumentCommentPost', {
    subject: SubjectRefSchema,
    body: TextSchema(4000),
    attachment: Schema.optionalKey(SubjectRefSchema),
    mentions: Schema.optionalKey(Schema.Array(TextSchema(200)).check(Schema.isMaxLength(20))),
  }),
  /** Author rewrites a comment; the previous wording is kept in `edits`. */
  Schema.TaggedStruct('DocumentCommentEdit', {
    commentId: CommentIdSchema,
    body: TextSchema(4000),
  }),
  /** Author withdraws a comment; it stays in the history marked as withdrawn. */
  Schema.TaggedStruct('DocumentCommentRetract', {
    commentId: CommentIdSchema,
  }),
] as const;

export const DocumentsCommandSchema = Schema.Union(documentsCommandSchemas);
export type DocumentsCommand = typeof DocumentsCommandSchema.Type;
type CommandOf<Tag extends DocumentsCommand['_tag']> = Extract<DocumentsCommand, { readonly _tag: Tag }>;

const findDocument = (state: DocumentsState, documentId: string) =>
  Effect.fromNullishOr(state.documents.find((document) => document.id === documentId)).pipe(
    Effect.mapError(() => opsNotFound(`Document ${documentId} does not exist`)),
  );

const findComment = (state: DocumentsState, commentId: string) =>
  Effect.fromNullishOr((state.comments ?? []).find((comment) => comment.id === commentId)).pipe(
    Effect.mapError(() => opsNotFound(`Comment ${commentId} does not exist`)),
  );

const replaceDocument = (state: DocumentsState, next: DocumentRecord): DocumentsState => ({
  ...state,
  documents: state.documents.map((document) => (document.id === next.id ? next : document)),
});

const replaceComment = (state: DocumentsState, next: CommentRecord): DocumentsState => ({
  ...state,
  comments: (state.comments ?? []).map((comment) => (comment.id === next.id ? next : comment)),
});

const createDocument = Effect.fn('SiamparkOps.Documents.create')(function* createDocument(
  state: DocumentsState,
  value: CommandOf<'DocumentCreate'>,
  input: OpsCommandInput,
) {
  if (value.amendsDocumentId !== undefined) {
    yield* findDocument(state, value.amendsDocumentId);
  }
  const id = yield* mintId(DocumentIdSchema, input.resourceId);
  const { _tag, file, note, ...fields } = value;
  void _tag;
  const record: DocumentRecord = {
    ...fields,
    ...auditCreated(input),
    id,
    versions:
      file === undefined
        ? []
        : [{ file, ...(note === undefined ? {} : { note }), uploadedAt: input.now, uploadedBy: input.actor, version: 1 }],
  };
  const entity = yield* entityIdOf(id);
  return { entityIds: [entity], state: { ...state, documents: [...state.documents, record] } };
});

const updateDocument = Effect.fn('SiamparkOps.Documents.update')(function* updateDocument(
  state: DocumentsState,
  value: CommandOf<'DocumentUpdate'>,
  input: OpsCommandInput,
) {
  const current = yield* findDocument(state, value.documentId);
  const { _tag, documentId, ...patch } = value;
  void _tag;
  void documentId;
  const next = auditUpdated({ ...current, ...patch }, input);
  const entity = yield* entityIdOf(current.id);
  return { entityIds: [entity], state: replaceDocument(state, next) };
});

const addVersion = Effect.fn('SiamparkOps.Documents.addVersion')(function* addVersion(
  state: DocumentsState,
  value: CommandOf<'DocumentVersionAdd'>,
  input: OpsCommandInput,
) {
  const current = yield* findDocument(state, value.documentId);
  if (current.versions.some((version) => version.file.id === value.file.id)) {
    return yield* opsConflict('This file is already a version of the document');
  }
  const version = current.versions.reduce((highest, entry) => Math.max(highest, entry.version), 0) + 1;
  const next = auditUpdated(
    {
      ...current,
      versions: [
        ...current.versions,
        {
          file: value.file,
          ...(value.note === undefined ? {} : { note: value.note }),
          uploadedAt: input.now,
          uploadedBy: input.actor,
          version,
        },
      ],
    },
    input,
  );
  const entity = yield* entityIdOf(current.id);
  return { entityIds: [entity], state: replaceDocument(state, next) };
});

const recordSignature = Effect.fn('SiamparkOps.Documents.recordSignature')(function* recordSignature(
  state: DocumentsState,
  value: CommandOf<'DocumentSignatureRecord'>,
  input: OpsCommandInput,
) {
  const current = yield* findDocument(state, value.documentId);
  if (!current.versions.some((version) => version.version === value.version)) {
    return yield* opsConflict(`Version ${value.version} does not exist; upload the signed scan first`);
  }
  const contract = current.contract;
  const next = auditUpdated(
    {
      ...current,
      ...(contract !== undefined && contract.status === 'draft'
        ? { contract: { ...contract, status: 'active' as const } }
        : {}),
      signature: {
        recordedAt: input.now,
        recordedBy: input.actor,
        signedBy: value.signedBy,
        signedOn: value.signedOn,
        version: value.version,
      },
    },
    input,
  );
  const entity = yield* entityIdOf(current.id);
  return { entityIds: [entity], state: replaceDocument(state, next) };
});

const postComment = Effect.fn('SiamparkOps.Documents.postComment')(function* postComment(
  state: DocumentsState,
  value: CommandOf<'DocumentCommentPost'>,
  input: OpsCommandInput,
) {
  const id = yield* mintId(CommentIdSchema, input.resourceId);
  const { _tag, ...fields } = value;
  void _tag;
  const record: CommentRecord = { ...fields, ...auditCreated(input), edits: [], id };
  const entity = yield* entityIdOf(id);
  return { entityIds: [entity], state: { ...state, comments: [...(state.comments ?? []), record] } };
});

const isAuthor = (comment: CommentRecord, input: OpsCommandInput) =>
  comment.createdBy.principalId === input.actor.principalId && comment.createdBy.tenantId === input.actor.tenantId;

const editComment = Effect.fn('SiamparkOps.Documents.editComment')(function* editComment(
  state: DocumentsState,
  value: CommandOf<'DocumentCommentEdit'>,
  input: OpsCommandInput,
) {
  const current = yield* findComment(state, value.commentId);
  if (!isAuthor(current, input)) {
    return yield* opsConflict('Only the author can edit a comment');
  }
  if (current.retractedAt !== undefined) {
    return yield* opsConflict('A withdrawn comment cannot be edited');
  }
  if (current.body === value.body) {
    return yield* opsConflict('The comment text did not change');
  }
  const next = auditUpdated(
    {
      ...current,
      body: value.body,
      edits: [...current.edits, { body: current.body, editedAt: input.now, editedBy: input.actor }],
    },
    input,
  );
  const entity = yield* entityIdOf(current.id);
  return { entityIds: [entity], state: replaceComment(state, next) };
});

const retractComment = Effect.fn('SiamparkOps.Documents.retractComment')(function* retractComment(
  state: DocumentsState,
  value: CommandOf<'DocumentCommentRetract'>,
  input: OpsCommandInput,
) {
  const current = yield* findComment(state, value.commentId);
  if (!isAuthor(current, input)) {
    return yield* opsConflict('Only the author can withdraw a comment');
  }
  if (current.retractedAt !== undefined) {
    return yield* opsConflict('The comment is already withdrawn');
  }
  const next = auditUpdated({ ...current, retractedAt: input.now, retractedBy: input.actor }, input);
  const entity = yield* entityIdOf(current.id);
  return { entityIds: [entity], state: replaceComment(state, next) };
});

/** Pure reducer: applies one command to the `documents` state. Persistence decides when it is saved. */
export const evolveDocuments = (state: DocumentsState, command: DocumentsCommand, input: OpsCommandInput) =>
  Match.value(command).pipe(
    Match.tag('DocumentCreate', (value) => createDocument(state, value, input)),
    Match.tag('DocumentUpdate', (value) => updateDocument(state, value, input)),
    Match.tag('DocumentVersionAdd', (value) => addVersion(state, value, input)),
    Match.tag('DocumentSignatureRecord', (value) => recordSignature(state, value, input)),
    Match.tag('DocumentCommentPost', (value) => postComment(state, value, input)),
    Match.tag('DocumentCommentEdit', (value) => editComment(state, value, input)),
    Match.tag('DocumentCommentRetract', (value) => retractComment(state, value, input)),
    Match.exhaustive,
  );

export const documentsAgenda = defineAgenda({
  commandSchema: DocumentsCommandSchema,
  empty: emptyDocumentsState,
  evolve: evolveDocuments,
  id: 'documents',
  sensitivity: 'restricted',
  stateSchema: DocumentsStateSchema,
});
