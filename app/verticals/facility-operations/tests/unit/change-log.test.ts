import type { Schema } from 'effect';
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
  ] satisfies readonly [Schema.Json, Schema.Json],
});

it('diffs nested contract fields with before and after values', () => {
  const before = findRecord(state('2026-10-25', '2026-10-20T08:00:00.000Z'), 'doc-1');
  const after = findRecord(state('2026-10-29', '2026-10-21T06:00:00.000Z'), 'doc-1');
  expect(diffRecords(before, after)).toEqual([
    { after: '2026-10-29', before: '2026-10-25', field: 'contract.validTo' },
  ]);
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

it('records same-length sales quote line price and quantity edits with their author and time', () => {
  const line = { description: 'Detektor', quantity: 2, unitPriceMinor: 10_000 };
  const quote = { id: 'quote-1', lines: [line], updatedAt: '2026-10-20T08:00:00.000Z' };
  const at = '2026-10-21T06:00:00.000Z';
  for (const changedLine of [
    { ...line, unitPriceMinor: 12_000 },
    { ...line, quantity: 3 },
  ]) {
    expect(
      changeEntries({
        after: { quotes: [{ ...quote, lines: [changedLine], updatedAt: at }] },
        agenda: 'purchasing',
        at,
        before: { quotes: [quote] },
        by,
        command: 'SalesQuoteUpdate',
        entityIds: ['quote-1'],
      }),
    ).toEqual([
      {
        agenda: 'purchasing',
        at,
        by,
        changes: [{ after: '#1', before: '#1', field: 'lines' }],
        command: 'SalesQuoteUpdate',
        entityId: 'quote-1',
        kind: 'changed',
      },
    ]);
  }
});

it('compares array values before joining or truncating their display summaries', () => {
  expect(diffRecords({ tags: ['A, B', 'C'] }, { tags: ['A', 'B, C'] })).toEqual([
    { after: 'A, B, C', before: 'A, B, C', field: 'tags' },
  ]);
  const prefix = 'a'.repeat(300);
  expect(diffRecords({ tags: [`${prefix}x`] }, { tags: [`${prefix}y`] })).toEqual([
    { after: prefix, before: prefix, field: 'tags' },
  ]);
  expect(diffRecords({ tags: ['A', 'B'] }, { tags: ['B', 'A'] })).toEqual([
    { after: 'B, A', before: 'A, B', field: 'tags' },
  ]);
});

it('does not audit equal arrays recreated with different object key order or updated bookkeeping', () => {
  const reorderedLine = Object.fromEntries([
    ['unitPriceMinor', 10_000],
    ['quantity', 2],
  ]);
  expect(
    diffRecords(
      { lines: [{ quantity: 2, unitPriceMinor: 10_000 }], updatedAt: 'before' },
      { lines: [reorderedLine], updatedAt: 'after' },
    ),
  ).toEqual([]);
  expect(diffRecords({ optional: null }, { optional: '' })).toEqual([]);
});

it('retains bounded nested array summaries and the field-count limit', () => {
  expect(
    diffRecords(
      { details: { lines: [{ description: 'a'.repeat(500), quantity: 1 }] } },
      { details: { lines: [{ description: 'b'.repeat(500), quantity: 1 }] } },
    ),
  ).toEqual([{ after: '#1', before: '#1', field: 'details.lines' }]);
  const before = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`lines${i}`, [{ quantity: 1 }]]));
  const after = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`lines${i}`, [{ quantity: 2 }]]));
  expect(diffRecords(before, after)).toHaveLength(40);
});

it('conflicts only when a touched record changed after the client loaded', () => {
  const current = state('2026-10-25', '2026-10-21T06:00:00.000Z');
  expect(touchedSince(current, ['doc-1'], '2026-10-21T05:30:00.000Z')).toBe(true);
  expect(touchedSince(current, ['doc-2'], '2026-10-21T05:30:00.000Z')).toBe(false);
  expect(touchedSince(current, ['new-record'], '2026-10-21T05:30:00.000Z')).toBe(false);
});

it('finds the record itself, not a nested link that carries the same id', () => {
  const tree = {
    comments: [{ id: 'c1', subject: { id: 'doc-1', kind: 'document', label: 'Smlouva' }, updatedAt: 'x' }],
    documents: [
      { id: 'doc-2', links: [{ id: 'doc-1', kind: 'document', label: 'Smlouva' }], updatedAt: 'x' },
      { id: 'doc-1', title: 'Smlouva', updatedAt: '2026-10-21T05:00:00.000Z' },
    ] satisfies readonly [Schema.Json, Schema.Json],
  };
  const { title } = findRecord(tree, 'doc-1') ?? {};
  expect(title).toBe('Smlouva');
});
