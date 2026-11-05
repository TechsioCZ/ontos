/**
 * R5a-7: `list` and a record-scoped decision must answer the same question from the same owner facts.
 *
 * The list path decides rows by evaluating its `ListAccessPredicate` against the owner's projected row.
 * v2 writes no `access_record` relation, so the graph could never be that authority; a record-scoped
 * decision that asked the graph instead could refuse a row the list had just shown. These cases pin the
 * record-scoped form to the list evaluator and to the fail-closed rule for a missing projection.
 */
import { expect, it } from 'effect-rstest';

import { AccessTeamIdSchema } from '../../src/access/decision/authority.ts';
import {
  cellReachesProjection,
  evaluateListAccessPredicate,
  sideReachesProjection,
} from '../../src/access/decision/list-access.ts';
import type { ListAccessPredicate, ListRowProjection } from '../../src/access/decision/list-access.ts';
import { PrincipalIdSchema, RecordKeySchema } from '../../src/access/ids.ts';
import type { Holder } from '../../src/access/model.ts';

const HOLDER: Holder = {
  _tag: 'Principal',
  principalId: PrincipalIdSchema.make('11111111-1111-4111-8111-111111111111'),
};
const OTHER: Holder = {
  _tag: 'Principal',
  principalId: PrincipalIdSchema.make('22222222-2222-4222-8222-222222222222'),
};
const RECORD = RecordKeySchema.make('33333333-3333-4333-8333-333333333333');
const OTHER_RECORD = RecordKeySchema.make('44444444-4444-4444-8444-444444444444');
const TEAM = AccessTeamIdSchema.make('55555555-5555-4555-8555-555555555555');
const OTHER_TEAM = AccessTeamIdSchema.make('66666666-6666-4666-8666-666666666666');

/** A record the owner has not projected at all: the fail-closed case. */
const absentProjection = (projection?: ListRowProjection): ListRowProjection | undefined => projection;
const NO_PROJECTION = absentProjection();

const projection = (overrides: Partial<ListRowProjection> = {}): ListRowProjection => ({
  recordKey: RECORD,
  teamIds: [],
  ...overrides,
});

const cell = (
  selector: Parameters<typeof cellReachesProjection>[0]['cell']['selector'],
  teamIds:
    | readonly [ReturnType<typeof AccessTeamIdSchema.make>, ...ReturnType<typeof AccessTeamIdSchema.make>[]]
    | readonly [] = [],
) => ({
  cell: { selector },
  holder: HOLDER,
  teamIds,
});

it('reaches only the record the owner assigns to the asking holder', () => {
  expect(cellReachesProjection(cell({ _tag: 'assigned' }), projection({ assigned: HOLDER }))).toBe(true);
  // The owner's projection names somebody else: this cell does not reach the record.
  expect(cellReachesProjection(cell({ _tag: 'assigned' }), projection({ assigned: OTHER }))).toBe(false);
  expect(cellReachesProjection(cell({ _tag: 'assigned' }), projection())).toBe(false);
});

it('denies a selector-bearing cell when the owner projected no record at all', () => {
  // Fail closed: a missing owner fact is never an implicit match (O48).
  expect(cellReachesProjection(cell({ _tag: 'assigned' }), NO_PROJECTION)).toBe(false);
  expect(cellReachesProjection(cell({ _tag: 'entrusted' }), NO_PROJECTION)).toBe(false);
  expect(cellReachesProjection(cell({ _tag: 'targets', recordKeys: [RECORD] }), NO_PROJECTION)).toBe(false);
  // ... while a scope-wide cell needs no record fact and keeps reaching everything, exactly as in a list.
  expect(cellReachesProjection(cell({ _tag: 'all' }), NO_PROJECTION)).toBe(true);
});

it('reaches an entrusted record, a team record and an explicitly targeted record', () => {
  expect(cellReachesProjection(cell({ _tag: 'entrusted' }), projection({ entrusted: HOLDER }))).toBe(true);
  expect(cellReachesProjection(cell({ _tag: 'entrusted' }), projection({ entrusted: OTHER }))).toBe(false);

  expect(cellReachesProjection(cell({ _tag: 'team' }, [TEAM]), projection({ teamIds: [TEAM] }))).toBe(true);
  expect(cellReachesProjection(cell({ _tag: 'team' }, [TEAM]), projection({ teamIds: [OTHER_TEAM] }))).toBe(false);

  expect(cellReachesProjection(cell({ _tag: 'targets', recordKeys: [RECORD] }), projection())).toBe(true);
  expect(cellReachesProjection(cell({ _tag: 'targets', recordKeys: [OTHER_RECORD] }), projection())).toBe(false);
});

it('gives the same answer as the list predicate the owner SQL implements', () => {
  const assignedPredicate: ListAccessPredicate = {
    groups: [{ clauses: [{ conditions: [{ _tag: 'AssignedTo', holder: HOLDER }] }] }],
  };
  for (const row of [
    projection({ assigned: HOLDER }),
    projection({ assigned: OTHER }),
    projection(),
    projection({ assigned: HOLDER, recordKey: OTHER_RECORD }),
  ]) {
    expect(cellReachesProjection(cell({ _tag: 'assigned' }), row)).toBe(
      evaluateListAccessPredicate(assignedPredicate, row),
    );
  }

  const teamPredicate: ListAccessPredicate = {
    groups: [{ clauses: [{ conditions: [{ _tag: 'TeamMemberOf', teamIds: [TEAM] }] }] }],
  };
  for (const row of [projection({ teamIds: [TEAM] }), projection({ teamIds: [OTHER_TEAM] }), projection()]) {
    expect(cellReachesProjection(cell({ _tag: 'team' }, [TEAM]), row)).toBe(
      evaluateListAccessPredicate(teamPredicate, row),
    );
  }
});

const side = (holder: Holder) => ({
  cells: [cell({ _tag: 'assigned' }), cell({ _tag: 'entrusted' })].map((source) => ({ ...source, holder })),
});

it('reaches the record when any cell of the side does, and never when none does', () => {
  expect(sideReachesProjection(side(HOLDER), projection({ assigned: HOLDER }))).toBe(true);
  expect(sideReachesProjection(side(HOLDER), projection({ entrusted: HOLDER }))).toBe(true);
  expect(sideReachesProjection(side(HOLDER), projection({ assigned: OTHER }))).toBe(false);
  expect(sideReachesProjection(side(HOLDER), NO_PROJECTION)).toBe(false);
});
