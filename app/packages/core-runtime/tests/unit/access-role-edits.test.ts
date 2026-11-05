import { expect, it } from 'effect-rstest';

import { grantIncarnationId, planGrantIncarnationMove } from '../../src/access/intent/grant-incarnations.ts';
import type { GrantIncarnationRow } from '../../src/access/intent/grant-incarnations.ts';
import { capabilitySlot } from '../../src/access/compiler/object-id.ts';
import { AccessScopeIdSchema, RoleIdSchema, RoleRevisionIdSchema, TenantIdSchema } from '../../src/access/ids.ts';
import { CellSchema, cellSlotKey } from '../../src/access/model.ts';
import type { Cell } from '../../src/access/model.ts';
import { cellContentKey, planRoleCellEdit, roleCellEditChanges } from '../../src/access/changes/role-edits.ts';
import { cell, decodeWith, fixedId, roleState } from './access-changes-fixtures.ts';

/*
 * The exact cell-content diff one role edit makes (R5a-6). A slot names the capability, the mode and the
 * selector, so a policy value that is not part of the slot — the amount ceiling — only ever changes by
 * *replacing* the cell of that slot. An edit planned by slots alone reads such a change as "already
 * present" on the addition and as "present" on the removal, writes the removal, and drops the cell.
 *
 * The incarnation writer both role-revision writers call then does the rest: a removed slot retires its
 * incarnation and the added content of that slot is a fresh one, while an unchanged cell keeps its own
 * (O51(2), O52). These cases prove the diff and the move it produces, without a container.
 */

const tenantId = TenantIdSchema.make(fixedId(1));
const roleId = RoleIdSchema.make(fixedId(20));
const scopeId = AccessScopeIdSchema.make(fixedId(2));
const targetRevisionId = fixedId(41);

/** One cell of the fixtures' shape, with the ceiling that is not part of its slot. */
const capped = (capabilityKey: string, limitMinor: number): Cell =>
  decodeWith('cell', CellSchema, {
    amountCeiling: { currency: 'CZK', limitMinor },
    capabilityKey,
    mode: 'run',
    selector: { _tag: 'all' },
  });

const payRun = 'test.access.pay.run';
const noteRead = 'test.access.note.read';

const heldCeiling = capped(payRun, 1000);
const narrowedCeiling = capped(payRun, 500);

/** The incarnation a decision witnesses for one cell of one role in one scope (revision-free identity). */
const incarnationOf = (value: Cell): string => grantIncarnationId({ cell: value, roleId, scopeId, tenantId });

const activeRowOf = (value: Cell): GrantIncarnationRow => ({
  capabilityKey: value.capabilityKey,
  grantIncarnationId: incarnationOf(value),
  mode: value.mode,
  slot: capabilitySlot(value),
  status: 'active',
});

/** The move the revision writer makes over one planned edit's added and removed cells. */
const incarnationMove = (input: {
  readonly addedCells: readonly Cell[];
  readonly existing: readonly GrantIncarnationRow[];
  readonly removedCells: readonly Cell[];
}) =>
  planGrantIncarnationMove({
    addedCells: input.addedCells,
    existing: input.existing,
    removedCells: input.removedCells,
    roleId,
    scopeId,
    targetRevisionId: RoleRevisionIdSchema.make(targetRevisionId),
    tenantId,
  });

it('replaces a cell whose slot changed only by its amount ceiling instead of dropping it', () => {
  const role = roleState({ cells: [heldCeiling] });
  const edit = planRoleCellEdit(role, [narrowedCeiling], [heldCeiling], targetRevisionId);

  // Both sides of the replacement are in one edit, so the successor revision still holds the slot.
  expect(edit?.removedCells).toEqual([heldCeiling]);
  expect(edit?.addedCells).toEqual([narrowedCeiling]);
  expect(edit?.cells).toEqual([narrowedCeiling]);
  expect(edit?.cells.map(cellSlotKey)).toEqual([cellSlotKey(heldCeiling)]);

  // A narrowing replacement mints a fresh incarnation: the old one retires, and the slot's added content
  // never reuses the id the retired row held (a re-add is a new grant, O52).
  const move = incarnationMove({
    addedCells: edit?.addedCells ?? [],
    existing: [activeRowOf(heldCeiling)],
    removedCells: edit?.removedCells ?? [],
  });
  expect(move.retire).toEqual([incarnationOf(heldCeiling)]);
  // The added content never revives the slot's deterministic id either: the retired row's id is known, so
  // the writer mints a fresh one and no approval that witnessed the old cell can reach the new one.
  expect(move.write.map(({ grantIncarnationId: written }) => written)).not.toEqual([incarnationOf(narrowedCeiling)]);
  expect(move.write.map(({ grantIncarnationId: written }) => written)).not.toEqual([incarnationOf(heldCeiling)]);
  expect(move.write.map(({ cell: written }) => written)).toEqual([narrowedCeiling]);
});

it('replaces a cell of an occupied slot that the request only adds, because content is what a slot holds', () => {
  const role = roleState({ cells: [heldCeiling] });
  // A caller that names the new content without naming the old one still replaces it: the diff decides
  // what the revision ends, not the caller's spelling of it (the adoption path plans exactly like this).
  expect(roleCellEditChanges(role, [narrowedCeiling], [])).toBe(true);
  const edit = planRoleCellEdit(role, [narrowedCeiling], [], targetRevisionId);
  expect(edit?.removedCells).toEqual([heldCeiling]);
  expect(edit?.addedCells).toEqual([narrowedCeiling]);
  expect(edit?.cells).toEqual([narrowedCeiling]);
});

it('keeps the cell and its incarnation when a request removes and re-adds the identical cell', () => {
  const role = roleState({ cells: [heldCeiling] });
  // Removing and re-adding the same content leaves the revision exactly as it was: no revision is written,
  // so the grant incarnation a mandate witness names survives the edit (O51(2), O52).
  expect(planRoleCellEdit(role, [heldCeiling], [heldCeiling], targetRevisionId)).toBeUndefined();
  expect(roleCellEditChanges(role, [heldCeiling], [heldCeiling])).toBe(false);
  const move = incarnationMove({ addedCells: [], existing: [activeRowOf(heldCeiling)], removedCells: [] });
  expect(move.retire).toEqual([]);
  expect(move.write).toEqual([]);
});

it('writes no revision for an unchanged cell, so its incarnation is untouched', () => {
  const role = roleState({ cells: [heldCeiling, cell(noteRead)] });
  expect(planRoleCellEdit(role, [heldCeiling], [], targetRevisionId)).toBeUndefined();
  expect(roleCellEditChanges(role, [heldCeiling], [])).toBe(false);
  // The same request over a cell the role does not hold is a real addition of that slot.
  const added = planRoleCellEdit(role, [cell(noteRead, 'propose')], [], targetRevisionId);
  expect(added?.removedCells).toEqual([]);
  expect(added?.addedCells).toEqual([cell(noteRead, 'propose')]);
  expect(added?.cells.map(cellSlotKey)).toEqual([
    cellSlotKey(heldCeiling),
    cellSlotKey(cell(noteRead)),
    cellSlotKey(cell(noteRead, 'propose')),
  ]);
});

it('keeps a slot that other slots of the same edit do not touch, and ends exactly the removed one', () => {
  const role = roleState({ cells: [heldCeiling, cell(noteRead)] });
  const edit = planRoleCellEdit(role, [], [heldCeiling], targetRevisionId);
  expect(edit?.removedCells).toEqual([heldCeiling]);
  expect(edit?.addedCells).toEqual([]);
  expect(edit?.cells).toEqual([cell(noteRead)]);
});

it('names a cell by its ceiling as well as its slot, which is what the revision writer compares', () => {
  expect(cellContentKey(heldCeiling)).not.toBe(cellContentKey(narrowedCeiling));
  expect(cellContentKey(heldCeiling)).toBe(cellContentKey(capped(payRun, 1000)));
  expect(cellContentKey(cell(noteRead))).toBe(`${cellSlotKey(cell(noteRead))} -`);
});
