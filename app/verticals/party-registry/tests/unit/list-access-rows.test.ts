import { ListAccessConditionSchema } from '@app/core-runtime/access/decision/list-access';
import type { ListAccessCondition, ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { rowsVisibleToListAccess } from '../../src/access/list-access-rows.ts';

/** One gate condition exactly as Core encodes it on the wire; decoding brands every access id. */
type EncodedCondition = (typeof ListAccessConditionSchema)['Encoded'];

const conditionOf = (encoded: EncodedCondition): ListAccessCondition =>
  Schema.decodeUnknownSync(ListAccessConditionSchema)(encoded);
const filterOf = (...conditions: [ListAccessCondition, ...ListAccessCondition[]]): ListAccessPredicate => ({
  groups: [{ clauses: [{ conditions }] }],
});
/** One clause group whose clauses may each match (OR); every group must match (AND). */
const eitherOf = (
  first: [ListAccessCondition, ...ListAccessCondition[]],
  second: [ListAccessCondition, ...ListAccessCondition[]],
): ListAccessPredicate => ({ groups: [{ clauses: [{ conditions: first }, { conditions: second }] }] });

const rows = [
  { id: '30000000-0000-4000-8000-000000000001', owner: '20000000-0000-4000-8000-000000000001' },
  { id: '30000000-0000-4000-8000-000000000002', owner: '20000000-0000-4000-8000-000000000002' },
  { id: '30000000-0000-4000-8000-000000000003', owner: undefined },
] as const;
const rowView = (row: (typeof rows)[number]) =>
  row.owner === undefined ? { recordKey: row.id } : { assignedPrincipalId: row.owner, recordKey: row.id };
const visible = (filter?: ListAccessPredicate) =>
  rowsVisibleToListAccess({ filter, row: rowView, rows }).map(({ id }) => id);

it('keeps every row of the scope for a scope-wide grant and for a read the gate does not row-scope', () => {
  expect(visible(filterOf(conditionOf({ _tag: 'AllInScope' })))).toEqual(rows.map(({ id }) => id));
  expect(visible()).toEqual(rows.map(({ id }) => id));
  expect(visible({ groups: [] })).toEqual(rows.map(({ id }) => id));
});

it('shows an assigned record only to the person assigned to it, never to anyone else', () => {
  const assignedToOwner = conditionOf({
    _tag: 'AssignedTo',
    holder: { _tag: 'Principal', principalId: rows[0].owner },
  });
  expect(visible(filterOf(assignedToOwner))).toEqual([rows[0].id]);
  // A person without the assignment sees no row at all, including the unassigned record.
  const assignedToSomeoneElse = conditionOf({
    _tag: 'AssignedTo',
    holder: { _tag: 'Principal', principalId: '20000000-0000-4000-8000-000000000099' },
  });
  expect(visible(filterOf(assignedToSomeoneElse))).toEqual([]);
  // A record nobody is assigned to never satisfies an `assigned` clause (O10, O24).
  expect(visible(filterOf(assignedToOwner))).not.toContain(rows[2].id);
});

it('never widens an explicit target set into an unfiltered scan of the scope', () => {
  expect(visible(filterOf(conditionOf({ _tag: 'RecordKeyIn', recordKeys: [rows[1].id] })))).toEqual([rows[1].id]);
  expect(
    visible(filterOf(conditionOf({ _tag: 'RecordKeyIn', recordKeys: ['30000000-0000-4000-8000-0000000000ff'] }))),
  ).toEqual([]);
});

it('matches nothing when the row cannot answer the condition the gate named', () => {
  const unanswerable = [
    filterOf(conditionOf({ _tag: 'TeamMemberOf', teamIds: ['40000000-0000-4000-8000-000000000001'] })),
    filterOf(conditionOf({ _tag: 'EntrustedTo', holder: { _tag: 'Principal', principalId: rows[0].owner } })),
    filterOf(conditionOf({ _tag: 'AmountWithinCeiling', ceiling: { currency: 'CZK', limitMinor: 100_000 } })),
  ];
  for (const filter of unanswerable) {
    expect(visible(filter)).toEqual([]);
  }
});

it('requires every group to match and any clause within a group', () => {
  const bothEnds: ListAccessPredicate = {
    groups: [
      { clauses: [{ conditions: [conditionOf({ _tag: 'AllInScope' })] }] },
      { clauses: [{ conditions: [conditionOf({ _tag: 'RecordKeyIn', recordKeys: [rows[2].id] })] }] },
    ],
  };
  expect(visible(bothEnds)).toEqual([rows[2].id]);
  expect(
    visible(
      eitherOf(
        [conditionOf({ _tag: 'RecordKeyIn', recordKeys: [rows[0].id] })],
        [conditionOf({ _tag: 'RecordKeyIn', recordKeys: [rows[1].id] })],
      ),
    ),
  ).toEqual([rows[0].id, rows[1].id]);
});
