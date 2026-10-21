import { expect, it } from 'effect-rstest';
import { changeEntries, diffRecords, findRecord, touchedSince } from '../../shared/domain/change-log.ts';

const by = { principalId: '72000000-0000-4000-8000-000000000021', tenantId: '70000000-0000-4000-8000-000000000020' };
const state = (validTo: string, updatedAt: string) => ({
  documents: [
    {
      contract: { contractType: 'Nájemní smlouva', owner: 'Vedení', parties: ['A', 'B'], status: 'active', validTo },
      id: 'doc-1',
      title: 'Smlouva',
      updatedAt,
      versions: [{ version: 1 }],
    },
    { id: 'doc-2', title: 'Jiná', updatedAt: '2026-10-21T05:00:00.000Z' },
  ],
});

it('diffs nested contract fields with before and after values', () => {
  const before = findRecord(state('2026-10-25', '2026-10-20T08:00:00.000Z'), 'doc-1');
  const after = findRecord(state('2026-10-29', '2026-10-21T06:00:00.000Z'), 'doc-1');
  expect(diffRecords(before, after)).toEqual([{ after: '2026-10-29', before: '2026-10-25', field: 'contract.validTo' }]);
});

it('records created and changed entries but skips no-op changes', () => {
  const base = state('2026-10-25', '2026-10-20T08:00:00.000Z');
  const entries = changeEntries({
    after: state('2026-10-29', '2026-10-21T06:00:00.000Z'),
    agenda: 'documents',
    at: '2026-10-21T06:00:00.000Z',
    before: base,
    by,
    command: 'DocumentUpdate',
    entityIds: ['doc-1', 'doc-2'],
  });
  expect(entries.map((entry) => [entry.entityId, entry.kind])).toEqual([['doc-1', 'changed']]);
  const created = changeEntries({
    after: base,
    agenda: 'documents',
    at: '2026-10-21T06:00:00.000Z',
    before: { documents: [] },
    by,
    command: 'DocumentCreate',
    entityIds: ['doc-1'],
  });
  expect(created[0]?.kind).toBe('created');
});

it('conflicts only when a touched record changed after the client loaded', () => {
  const current = state('2026-10-25', '2026-10-21T06:00:00.000Z');
  expect(touchedSince(current, ['doc-1'], '2026-10-21T05:30:00.000Z')).toBe(true);
  expect(touchedSince(current, ['doc-2'], '2026-10-21T05:30:00.000Z')).toBe(false);
  expect(touchedSince(current, ['new-record'], '2026-10-21T05:30:00.000Z')).toBe(false);
});
