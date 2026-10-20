import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { DocumentsCommandSchema, evolveDocuments } from '../../shared/commands/documents.ts';
import type { OpsCommandInput } from '../../shared/domain/common.ts';
import { DocumentsStateSchema, emptyDocumentsState } from '../../shared/domain/documents.ts';
import type { DocumentsState } from '../../shared/domain/documents.ts';
import { seedDocumentsState } from '../../scripts/seed/documents.mts';

const tenantId = '70000000-0000-4000-8000-000000000020';
const management = { principalId: '72000000-0000-4000-8000-000000000021', tenantId };
const operations = { principalId: '72000000-0000-4000-8000-000000000022', tenantId };

const input = (resourceId: string, actor = management, at = '2026-10-20T08:00:00Z'): OpsCommandInput => ({
  actor,
  now: DateTime.makeUnsafe(at),
  resourceId,
});

const decodeCommand = Schema.decodeUnknownEffect(DocumentsCommandSchema);
const step = (state: DocumentsState, command: unknown, commandInput: OpsCommandInput) =>
  Effect.gen(function* stepDocuments() {
    const decoded = yield* decodeCommand(command);
    return (yield* evolveDocuments(state, decoded, commandInput)).state;
  });

const empty = Schema.decodeUnknownEffect(DocumentsStateSchema)(emptyDocumentsState);
const pdf = (id: string) => ({ id, mime: 'application/pdf', name: `${id}.pdf`, size: 1024 });

it.effect('DocumentVersionAdd keeps every earlier version (S12-02)', () =>
  Effect.gen(function* versions() {
    const created = yield* step(
      yield* empty,
      { _tag: 'DocumentCreate', category: 'contract', file: pdf('file-1'), title: 'Nájemní smlouva R101' },
      input('doc-1'),
    );
    const next = yield* step(
      created,
      { _tag: 'DocumentVersionAdd', documentId: 'doc-1', file: pdf('file-2'), note: 'Opravená příloha' },
      input('cmd-2', operations, '2026-10-21T09:30:00Z'),
    );
    const document = next.documents[0];
    expect(document?.versions.map((version) => version.version)).toEqual([1, 2]);
    expect(document?.versions.map((version) => version.file.id)).toEqual(['file-1', 'file-2']);
    expect(document?.versions[1]?.uploadedBy.principalId).toBe(operations.principalId);
    expect(DateTime.formatIso(document?.versions[0]?.uploadedAt ?? DateTime.makeUnsafe(0))).toBe(
      '2026-10-20T08:00:00.000Z',
    );
    expect(document?.updatedBy.principalId).toBe(operations.principalId);
  }),
);

it.effect('DocumentVersionAdd refuses the same stored file twice', () =>
  Effect.gen(function* duplicate() {
    const created = yield* step(
      yield* empty,
      { _tag: 'DocumentCreate', category: 'protocol', file: pdf('file-1'), title: 'Předávací protokol' },
      input('doc-1'),
    );
    const decoded = yield* decodeCommand({ _tag: 'DocumentVersionAdd', documentId: 'doc-1', file: pdf('file-1') });
    const error = yield* Effect.flip(evolveDocuments(created, decoded, input('cmd-2')));
    expect(error._tag).toBe('SiamparkOpsLifecycleConflict');
  }),
);

it.effect('an amendment must point to an existing contract document', () =>
  Effect.gen(function* amendment() {
    const decoded = yield* decodeCommand({
      _tag: 'DocumentCreate',
      amendsDocumentId: 'missing',
      category: 'amendment',
      title: 'Dodatek č. 1',
    });
    const error = yield* Effect.flip(evolveDocuments(yield* empty, decoded, input('doc-2')));
    expect(error._tag).toBe('SiamparkOpsNotFound');
    const contract = yield* step(
      yield* empty,
      { _tag: 'DocumentCreate', category: 'contract', title: 'Nájemní smlouva' },
      input('doc-1'),
    );
    const amended = yield* step(
      contract,
      { _tag: 'DocumentCreate', amendsDocumentId: 'doc-1', category: 'amendment', title: 'Dodatek č. 1' },
      input('doc-2'),
    );
    expect(amended.documents[1]?.amendsDocumentId).toBe('doc-1');
  }),
);

it.effect('a manual signature needs an uploaded version and activates a draft contract', () =>
  Effect.gen(function* signature() {
    const contract = {
      contractType: 'Nájemní smlouva',
      owner: 'Jana Správcová',
      parties: ['Siampark s.r.o.', 'Kavárna U Parku s.r.o.'],
      status: 'draft',
      validTo: '2028-10-31',
    };
    const created = yield* step(
      yield* empty,
      { _tag: 'DocumentCreate', category: 'contract', contract, title: 'Nájemní smlouva R101' },
      input('doc-1'),
    );
    const missing = yield* decodeCommand({
      _tag: 'DocumentSignatureRecord',
      documentId: 'doc-1',
      signedBy: 'Petra Malá',
      signedOn: '2025-10-15',
      version: 1,
    });
    expect((yield* Effect.flip(evolveDocuments(created, missing, input('cmd-1'))))._tag).toBe(
      'SiamparkOpsLifecycleConflict',
    );
    const withScan = yield* step(
      created,
      { _tag: 'DocumentVersionAdd', documentId: 'doc-1', file: pdf('scan') },
      input('cmd-2'),
    );
    const signed = yield* step(
      withScan,
      { _tag: 'DocumentSignatureRecord', documentId: 'doc-1', signedBy: 'Petra Malá', signedOn: '2025-10-15', version: 1 },
      input('cmd-3'),
    );
    expect(signed.documents[0]?.signature?.signedBy).toBe('Petra Malá');
    expect(signed.documents[0]?.contract?.status).toBe('active');
  }),
);

it.effect('comments keep author, edit history and withdrawal; only the author may change them (S14-01)', () =>
  Effect.gen(function* comments() {
    const subject = { id: 'task-7', kind: 'task', label: 'Výměna filtrů VZT' };
    const posted = yield* step(
      yield* empty,
      { _tag: 'DocumentCommentPost', body: 'Filtry objednány, dorazí ve čtvrtek.', subject },
      input('comment-1', operations),
    );
    expect(posted.comments?.[0]?.createdBy.principalId).toBe(operations.principalId);

    const foreignEdit = yield* decodeCommand({ _tag: 'DocumentCommentEdit', body: 'Jiný text', commentId: 'comment-1' });
    expect((yield* Effect.flip(evolveDocuments(posted, foreignEdit, input('cmd-x', management))))._tag).toBe(
      'SiamparkOpsLifecycleConflict',
    );

    const edited = yield* step(
      posted,
      { _tag: 'DocumentCommentEdit', body: 'Filtry objednány, dorazí v pátek.', commentId: 'comment-1' },
      input('cmd-2', operations, '2026-10-20T09:00:00Z'),
    );
    const comment = edited.comments?.[0];
    expect(comment?.body).toBe('Filtry objednány, dorazí v pátek.');
    expect(comment?.edits.map((entry) => entry.body)).toEqual(['Filtry objednány, dorazí ve čtvrtek.']);

    const retracted = yield* step(
      edited,
      { _tag: 'DocumentCommentRetract', commentId: 'comment-1' },
      input('cmd-3', operations),
    );
    expect(retracted.comments?.[0]?.retractedAt).toBeDefined();
    const again = yield* decodeCommand({ _tag: 'DocumentCommentEdit', body: 'Znovu', commentId: 'comment-1' });
    expect((yield* Effect.flip(evolveDocuments(retracted, again, input('cmd-4', operations))))._tag).toBe(
      'SiamparkOpsLifecycleConflict',
    );
  }),
);

it.effect('blank comments are refused by the command schema', () =>
  Effect.gen(function* blank() {
    const result = yield* Effect.result(
      decodeCommand({ _tag: 'DocumentCommentPost', body: '   ', subject: { id: 'x', kind: 'task', label: 'Úkol' } }),
    );
    expect(result._tag).toBe('Failure');
  }),
);

it.effect('the seed state decodes with the documents schema', () =>
  Effect.gen(function* seed() {
    const state = yield* Schema.decodeUnknownEffect(DocumentsStateSchema)(seedDocumentsState());
    expect(state.documents.length).toBeGreaterThan(0);
    const ids = new Set(state.documents.map((document) => document.id));
    for (const document of state.documents) {
      if (document.amendsDocumentId !== undefined) {
        expect(ids.has(document.amendsDocumentId)).toBe(true);
      }
    }
  }),
);
