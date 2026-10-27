import { expect, it } from '@rstest/core';
import { DateTime, Result, Schema } from 'effect';
import { DocumentSchema, DocumentVersionSchema } from '../../../../../shared/domain/documents.ts';
import { changedOn, documentSortKey, DocumentsSearchSchema, selectionForSearch } from './documents-route-state.ts';

const decodeSearch = Schema.decodeSync(DocumentsSearchSchema);

it('decodes remote-page query strings with first-value and literal-ID semantics', () => {
  expect(decodeSearch('?doc=doc%20%26%201&doc=ignored&taskId=123')).toEqual({
    doc: 'doc & 1',
    taskId: '123',
  });
  expect(decodeSearch('?doc=%22quoted%22&taskId=')).toEqual({ doc: '"quoted"', taskId: '' });
  expect(decodeSearch('?unrelated=1')).toEqual({});
  expect(decodeSearch('')).toEqual({});
});

it('round-trips query fields through the native codec and retains invalid-input failures', () => {
  const fields = { doc: 'one & two', taskId: '123' };
  expect(decodeSearch(Schema.encodeSync(DocumentsSearchSchema)(fields))).toEqual(fields);
  expect(Result.isFailure(Schema.decodeUnknownResult(DocumentsSearchSchema)(123))).toBe(true);
});

it('keeps a closed panel closed until navigation and reopens the URL document on a new search', () => {
  const initial = selectionForSearch(undefined, '?doc=one', 'one');
  expect(initial.openId).toBe('one');
  const closed = selectionForSearch(undefined, initial.searchKey);
  expect(selectionForSearch(closed, '?doc=one', 'one')).toBe(closed);
  expect(selectionForSearch(closed, '?doc=one&taskId=two', 'one').openId).toBe('one');
});

it('preserves local document selection when navigation omits or empties the document parameter', () => {
  const selected = { openId: 'local-document', searchKey: '?doc=one' };
  expect(selectionForSearch(selected, '?taskId=two').openId).toBe('local-document');
  expect(selectionForSearch(selected, '?doc=', '').openId).toBe('local-document');
});

it('formats native instants as Prague business dates across the autumn clock change', () => {
  expect(changedOn(DateTime.makeUnsafe('2026-10-24T22:30:00.000Z'))).toBe('2026-10-25');
  expect(changedOn(DateTime.makeUnsafe('2026-10-25T22:30:00.000Z'))).toBe('2026-10-25');
  expect(changedOn(DateTime.makeUnsafe('2026-10-25T23:30:00.000Z'))).toBe('2026-10-26');
});

it('sorts by the latest version when present, otherwise by the document update, with stable ties', () => {
  const actor = {
    principalId: '72000000-0000-4000-8000-000000000021',
    tenantId: '70000000-0000-4000-8000-000000000020',
  };
  const document = Schema.decodeUnknownSync(DocumentSchema)({
    category: 'other',
    createdAt: '2026-10-01T08:00:00.000Z',
    createdBy: actor,
    id: 'doc-one',
    title: 'One',
    updatedAt: '2026-10-27T08:00:00.000Z',
    updatedBy: actor,
    versions: [],
  });
  const version = Schema.decodeUnknownSync(DocumentVersionSchema)({
    file: { id: 'file-one', mime: 'application/pdf', name: 'one.pdf', size: 1 },
    uploadedAt: '2026-10-20T08:00:00.000Z',
    uploadedBy: actor,
    version: 1,
  });
  const withVersion = { ...document, versions: [version] };
  expect(documentSortKey(document)).toBe(DateTime.toEpochMillis(document.updatedAt).toString().padStart(16, '0'));
  expect(documentSortKey(withVersion)).toBe(DateTime.toEpochMillis(version.uploadedAt).toString().padStart(16, '0'));
  const equal = { ...withVersion, title: 'Two' };
  expect(
    [withVersion, document, equal]
      .toSorted((left, right) => documentSortKey(right).localeCompare(documentSortKey(left)))
      .map((entry) => entry.title),
  ).toEqual(['One', 'One', 'Two']);
});
