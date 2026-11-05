import { expect, it } from 'effect-rstest';

import { AccessScopeIdSchema, RoleIdSchema, RoleRevisionIdSchema, TenantIdSchema } from '../../src/access/ids.ts';
import type { CapabilitySlot } from '../../src/access/compiler/object-id.ts';
import { capabilitySlot } from '../../src/access/compiler/object-id.ts';
import { grantIncarnationId, planGrantIncarnationMove } from '../../src/access/intent/grant-incarnations.ts';
import type { GrantIncarnationRow } from '../../src/access/intent/grant-incarnations.ts';
import type { AccessMode, Cell } from '../../src/access/model.ts';
import { cell, fixedId } from './access-changes-fixtures.ts';

/*
 * The pure move a role edit makes to the grant incarnations a decision witnesses (O51(2), O52). The
 * database writers on both sides (bootstrap and Novinky) execute exactly this plan, so the keep,
 * add, remove and restore rules are proven here without a container.
 */

const tenantId = TenantIdSchema.make(fixedId(1));
const roleId = RoleIdSchema.make(fixedId(20));
const scopeA = AccessScopeIdSchema.make(fixedId(2));
const scopeB = AccessScopeIdSchema.make(fixedId(3));
const revisionTwo = RoleRevisionIdSchema.make(fixedId(40));
const revisionThree = RoleRevisionIdSchema.make(fixedId(41));

const readCell = cell('test.access.note.read');
const exportCell = cell('test.access.report.export');

const incarnationIdOf = (scopeId: typeof scopeA, value: Cell): string =>
  grantIncarnationId({ cell: value, roleId, scopeId, tenantId });

const activeRowOf = (scopeId: typeof scopeA, value: Cell): GrantIncarnationRow => ({
  capabilityKey: value.capabilityKey,
  grantIncarnationId: incarnationIdOf(scopeId, value),
  mode: value.mode,
  slot: capabilitySlot(value) satisfies CapabilitySlot,
  status: 'active',
});

const retiredRowOf = (scopeId: typeof scopeA, value: Cell): GrantIncarnationRow => ({
  ...activeRowOf(scopeId, value),
  status: 'retired',
});

const plan = (input: {
  readonly addedCells?: readonly Cell[];
  readonly existing?: readonly GrantIncarnationRow[];
  readonly removedCells?: readonly Cell[];
  readonly scopeId?: typeof scopeA;
  readonly targetRevisionId?: typeof revisionTwo;
}) =>
  planGrantIncarnationMove({
    addedCells: input.addedCells ?? [],
    existing: input.existing ?? [],
    removedCells: input.removedCells ?? [],
    roleId,
    scopeId: input.scopeId ?? scopeA,
    targetRevisionId: input.targetRevisionId ?? revisionTwo,
    tenantId,
  });

it('inserts one incarnation per added cell, with the revision-free cell identity (O51(2))', () => {
  const move = plan({ addedCells: [readCell, exportCell] });
  expect(move.retire).toEqual([]);
  expect(move.write.map(({ capabilityKey }) => capabilityKey)).toEqual([
    readCell.capabilityKey,
    exportCell.capabilityKey,
  ]);
  // The id is derived from the cell slot and the scope, never from the role revision.
  expect(move.write.map(({ grantIncarnationId: id }) => id)).toEqual([
    incarnationIdOf(scopeA, readCell),
    incarnationIdOf(scopeA, exportCell),
  ]);
  expect(move.write.every(({ roleId: writtenRole }) => writtenRole === roleId)).toBe(true);
  expect(move.write.map(({ cell: written }) => written)).toEqual([readCell, exportCell]);
});

it('keeps the incarnation of a cell the edit leaves untouched', () => {
  const existing = activeRowOf(scopeA, readCell);
  const move = plan({ addedCells: [readCell], existing: [existing] });
  expect(move.write).toEqual([]);
  expect(move.retire).toEqual([]);
});

it('retires the live incarnation of a removed cell and never the retired one', () => {
  const existing = activeRowOf(scopeA, readCell);
  const alreadyRetired = retiredRowOf(scopeA, exportCell);
  const move = plan({ existing: [existing, alreadyRetired], removedCells: [readCell, exportCell] });
  expect(move.write).toEqual([]);
  expect(move.retire).toEqual([incarnationIdOf(scopeA, readCell)]);
});

it('restores a previously removed cell with a fresh incarnation no old approval can reach', () => {
  const retired = retiredRowOf(scopeA, readCell);
  const move = plan({ addedCells: [readCell], existing: [retired], targetRevisionId: revisionThree });
  expect(move.retire).toEqual([]);
  expect(move.write).toHaveLength(1);
  const restored = move.write.at(0);
  expect(restored?.grantIncarnationId).not.toBe(retired.grantIncarnationId);
  expect(restored?.cell).toEqual(readCell);
});

it('derives a distinct incarnation per scope, so one role edit moves every binding', () => {
  const move = plan({ addedCells: [readCell], scopeId: scopeB });
  expect(move.write.at(0)?.grantIncarnationId).toBe(incarnationIdOf(scopeB, readCell));
  expect(move.write.at(0)?.grantIncarnationId).not.toBe(incarnationIdOf(scopeA, readCell));
  expect(incarnationIdOf(scopeA, readCell)).not.toBe(incarnationIdOf(scopeB, readCell));
});

it('does not mistake a cell of another capability or mode for the same incarnation', () => {
  const propose = cell('test.access.note.read', 'propose' satisfies AccessMode);
  const existing = activeRowOf(scopeA, propose);
  const move = plan({ addedCells: [readCell], existing: [existing] });
  expect(move.write.map(({ capabilityKey }) => capabilityKey)).toEqual([readCell.capabilityKey]);
  expect(move.write.at(0)?.grantIncarnationId).not.toBe(existing.grantIncarnationId);
});
