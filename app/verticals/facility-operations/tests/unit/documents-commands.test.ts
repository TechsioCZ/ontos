import { DateTime, Effect, Result, Schema } from 'effect';
import { FacilityOperationsLifecycleConflict } from '../../shared/errors/facility-operations-lifecycle-conflict.ts';
import { FacilityOperationsNotFound } from '../../shared/errors/facility-operations-not-found.ts';
import { expect, it } from 'effect-rstest';
import { DocumentsCommandSchema, evolveDocuments } from '../../shared/commands/documents.ts';
import type { OpsCommandInput } from '../../shared/domain/common.ts';
import { DocumentsStateSchema, emptyDocumentsState } from '../../shared/domain/documents.ts';
import type { DocumentsState } from '../../shared/domain/documents.ts';
import { seedDocumentsState } from '../../scripts/seed/documents.mts';
import { contractRegister, daysUntil, upcomingDeadlines } from '../../shared/domain/documents-deadlines.ts';

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

it.effect('a task attachment persists without replacing existing links or historical file versions (S12)', () =>
  Effect.gen(function* taskAttachment() {
    const property = { id: 'riverside', kind: 'property', label: 'Riverside Office Park' };
    const task = { id: 'vzt-r101', kind: 'task', label: 'Revize vzduchotechniky – kavárna R101' };
    const created = yield* step(
      yield* empty,
      { _tag: 'DocumentCreate', category: 'protocol', file: pdf('file-1'), links: [property], title: 'Podklady VZT' },
      input('doc-1'),
    );
    const attached = yield* step(
      created,
      { _tag: 'DocumentUpdate', documentId: 'doc-1', links: [property, task] },
      input('cmd-2', operations),
    );
    const persisted = yield* Schema.decodeUnknownEffect(DocumentsStateSchema)(
      yield* Schema.encodeEffect(DocumentsStateSchema)(attached),
    );
    expect(persisted.documents[0]?.links).toEqual([property, task]);
    expect(persisted.documents[0]?.versions).toEqual(created.documents[0]?.versions);
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
    expect(Schema.is(FacilityOperationsLifecycleConflict)(error)).toBe(true);
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
    expect(Schema.is(FacilityOperationsNotFound)(error)).toBe(true);
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
    expect(
      Schema.is(FacilityOperationsLifecycleConflict)(
        yield* Effect.flip(evolveDocuments(created, missing, input('cmd-1'))),
      ),
    ).toBe(true);
    const withScan = yield* step(
      created,
      { _tag: 'DocumentVersionAdd', documentId: 'doc-1', file: pdf('scan') },
      input('cmd-2'),
    );
    const signed = yield* step(
      withScan,
      {
        _tag: 'DocumentSignatureRecord',
        documentId: 'doc-1',
        signedBy: 'Petra Malá',
        signedOn: '2025-10-15',
        version: 1,
      },
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

    const foreignEdit = yield* decodeCommand({
      _tag: 'DocumentCommentEdit',
      body: 'Jiný text',
      commentId: 'comment-1',
    });
    expect(
      Schema.is(FacilityOperationsLifecycleConflict)(
        yield* Effect.flip(evolveDocuments(posted, foreignEdit, input('cmd-x', management))),
      ),
    ).toBe(true);

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
    expect(
      Schema.is(FacilityOperationsLifecycleConflict)(
        yield* Effect.flip(evolveDocuments(retracted, again, input('cmd-4', operations))),
      ),
    ).toBe(true);
  }),
);

it.effect('blank comments are refused by the command schema', () =>
  Effect.gen(function* blank() {
    const result = yield* Effect.result(
      decodeCommand({ _tag: 'DocumentCommentPost', body: '   ', subject: { id: 'x', kind: 'task', label: 'Úkol' } }),
    );
    expect(Result.isFailure(result)).toBe(true);
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

it.effect('S12-01: a contract ending in 5 days is in the upcoming deadlines; terminated ones are not', () =>
  Effect.gen(function* deadlines() {
    const state = yield* Schema.decodeUnknownEffect(DocumentsStateSchema)(seedDocumentsState());
    const upcoming = upcomingDeadlines(state.documents, '2026-10-20');
    const cleaning = upcoming.find((entry) => entry.document.id === 'seed-doc-uklid' && entry.kind === 'end');
    expect(cleaning?.days).toBe(5);
    expect(upcoming[0]?.document.id).toBe('seed-doc-uklid');
    const terminated = state.documents.map((document) =>
      document.contract === undefined
        ? document
        : { ...document, contract: { ...document.contract, status: 'terminated' as const } },
    );
    expect(upcomingDeadlines(terminated, '2026-10-20')).toEqual([]);
    expect(daysUntil('2026-10-19', '2026-10-20')).toBe(-1);
  }),
);

it.effect('the contract register lists each amendment right after its contract', () =>
  Effect.gen(function* register() {
    const state = yield* Schema.decodeUnknownEffect(DocumentsStateSchema)(seedDocumentsState());
    const rows = contractRegister(state.documents);
    const index = rows.findIndex((row) => row.document.id === 'seed-doc-r101');
    expect(rows[index + 1]?.document.id).toBe('seed-doc-r101-d1');
    expect(rows[index + 1]?.depth).toBe(1);
  }),
);
