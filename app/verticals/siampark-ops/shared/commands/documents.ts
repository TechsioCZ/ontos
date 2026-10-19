// Siampark provoz — commands of agenda `documents` (S12 dokumenty a verze + S14 komentáře a vlákna).
// OWNED BY THE `documents` LANE. To add a command: append a Schema.TaggedStruct to `documentsCommandSchemas`
// (tag must be globally unique, prefix it like `Document…`), then handle it in `evolveDocuments`.
// The central dispatcher (shared/agendas.ts) picks the agenda by tag; nothing else needs editing.
import { Effect, Match, Schema } from 'effect';
import { auditCreated, defineAgenda, entityIdOf, mintId, PropertyRefSchema, TextSchema } from '../domain/common.ts';
import type { OpsCommandInput } from '../domain/common.ts';
import { DocumentsStateSchema, DocumentIdSchema, emptyDocumentsState, StoredFileRefSchema } from '../domain/documents.ts';
import type { DocumentRecord, DocumentsState } from '../domain/documents.ts';

export const documentsCommandSchemas = [
  Schema.TaggedStruct('DocumentCreate', {
    title: TextSchema(300),
    category: TextSchema(120),
    related: Schema.optionalKey(PropertyRefSchema),
    /** Optional first version: the `file` returned by a prior FileUpload command. */
    file: Schema.optionalKey(StoredFileRefSchema),
  }),
] as const;

export const DocumentsCommandSchema = Schema.Union(documentsCommandSchemas);
export type DocumentsCommand = typeof DocumentsCommandSchema.Type;
type CommandOf<Tag extends DocumentsCommand['_tag']> = Extract<DocumentsCommand, { readonly _tag: Tag }>;

const createDocument = Effect.fn('SiamparkOps.Documents.create')(function* createDocument(
  state: DocumentsState,
  value: CommandOf<'DocumentCreate'>,
  input: OpsCommandInput,
) {
  const id = yield* mintId(DocumentIdSchema, input.resourceId);
  const { _tag, file, ...fields } = value;
  void _tag;
  const record: DocumentRecord = {
    ...fields,
    ...auditCreated(input),
    id,
    versions: file === undefined ? [] : [{ file, uploadedAt: input.now, uploadedBy: input.actor, version: 1 }],
  };
  const entity = yield* entityIdOf(id);
  return { entityIds: [entity], state: { ...state, documents: [...state.documents, record] } };
});

/** Pure reducer: applies one command to the `documents` state. Persistence decides when it is saved. */
export const evolveDocuments = (state: DocumentsState, command: DocumentsCommand, input: OpsCommandInput) =>
  Match.value(command).pipe(
    Match.tag('DocumentCreate', (value) => createDocument(state, value, input)),
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
