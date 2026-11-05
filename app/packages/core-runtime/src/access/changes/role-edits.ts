import { Match, Schema } from 'effect';

import { RoleIdSchema, RoleRevisionIdSchema } from '../ids.ts';
import type { CapabilityKey, RoleId, RoleRevisionId } from '../ids.ts';
import type { Cell } from '../model.ts';
import { CellSchema, RoleRevisionSchema, RoleSchema, cellSlotKey } from '../model.ts';
import { cellsWithout, cellsWith, toSortedCells } from './cells.ts';

/** A role with the revision that currently expresses its intent. */
export const RoleWithRevisionSchema = Schema.Struct({ revision: RoleRevisionSchema, role: RoleSchema });
export type RoleWithRevision = typeof RoleWithRevisionSchema.Type;

/** The complete new cell set one decision writes, with exactly what changed and from where. */
export const RoleCellEditSchema = Schema.Struct({
  addedCells: Schema.Array(CellSchema),
  cells: Schema.Array(CellSchema),
  removedCells: Schema.Array(CellSchema),
  roleId: RoleIdSchema,
  sourceRevisionId: RoleRevisionIdSchema,
  targetRevisionId: RoleRevisionIdSchema,
});
export type RoleCellEdit = typeof RoleCellEditSchema.Type;

/** The same edit before decoding: the successor revision id is minted by the caller. */
export interface RoleCellEditDraft {
  readonly addedCells: readonly Cell[];
  readonly cells: readonly Cell[];
  readonly removedCells: readonly Cell[];
  readonly roleId: RoleId;
  readonly sourceRevisionId: RoleRevisionId;
  readonly targetRevisionId: string;
}

export const findRole = (roles: readonly RoleWithRevision[], roleId: string): RoleWithRevision | undefined =>
  roles.find((role) => role.role.id === roleId);

/** Every cell a role holds for one capability, whatever its mode or selector (a removed descriptor). */
export const cellsOfCapability = (role: RoleWithRevision, capabilityKey: CapabilityKey): readonly Cell[] =>
  role.revision.cells.filter((cell) => cell.capabilityKey === capabilityKey);

/**
 * A cell's exact content, which is what a revision holds: its slot plus the policy value the cell
 * carries. The slot names the capability, the mode and the selector kind, so two cells of one slot
 * differ only in their amount ceiling or their exact target records — and either is a *changed* cell,
 * never a cell the role already covers (R5a-6). Diffing by slot alone would read a ceiling edit as "already present" and
 * write a revision that drops the cell.
 */
export const cellContentKey = (cell: Cell): string =>
  `${cellSlotKey(cell)} ${
    cell.amountCeiling === undefined ? '-' : `${cell.amountCeiling.currency}:${cell.amountCeiling.limitMinor}`
  }${Match.value(cell.selector).pipe(
    Match.tag('targets', ({ recordKeys }) => ` ${[...recordKeys].toSorted().join(',')}`),
    Match.orElse(() => ''),
  )}`;

/** One cell set by slot: the last cell of a slot wins, so a request naming a slot twice names it once. */
const cellsBySlot = (cells: readonly Cell[]): ReadonlyMap<string, Cell> =>
  new Map(cells.map((cell) => [cellSlotKey(cell), cell] as const));

/** What one request does to a revision's cells: the cells that end, and the cells that begin. */
interface CellContentDifference {
  readonly addedCells: readonly Cell[];
  readonly removedCells: readonly Cell[];
}

/**
 * The exact content difference one request makes to a revision's cells (R5a-6). The cell set the
 * request leaves behind is the revision's cells less the removed slots plus the requested cells, and
 * comparing that set with the revision decides both sides: a slot whose content changed *replaces* its
 * cell (the held one ends and the requested one begins, so the grant incarnation of the slot moves),
 * while a requested cell the role already holds exactly changes nothing and keeps its incarnation
 * (O51(2), O52). A removal and a re-add of the identical cell in one request is the same no-op, because
 * the requested content is what the revision keeps.
 */
const cellContentDifference = (
  currentCells: readonly Cell[],
  additions: readonly Cell[],
  removals: readonly Cell[],
): CellContentDifference => {
  const current = cellsBySlot(currentCells);
  const removedSlots = new Set(removals.map(cellSlotKey));
  // The cells the request leaves in place: the revision's own, less the removed slots, plus what it asks for.
  const remaining = new Map<string, Cell>();
  for (const [slot, cell] of current) {
    if (!removedSlots.has(slot)) {
      remaining.set(slot, cell);
    }
  }
  for (const [slot, cell] of cellsBySlot(additions)) {
    remaining.set(slot, cell);
  }
  const removedCells = currentCells.filter((cell) => {
    const kept = remaining.get(cellSlotKey(cell));
    return kept === undefined || cellContentKey(kept) !== cellContentKey(cell);
  });
  const addedCells = [...remaining.values()].filter((cell) => {
    const heldCell = current.get(cellSlotKey(cell));
    return heldCell === undefined || cellContentKey(heldCell) !== cellContentKey(cell);
  });
  return { addedCells, removedCells };
};

/**
 * Whether a request changes any cell's exact content, so a caller can skip minting a revision id for a
 * request that writes nothing (an adoption a role already covers, M1).
 */
export const roleCellEditChanges = (
  role: RoleWithRevision,
  additions: readonly Cell[],
  removals: readonly Cell[],
): boolean => {
  const difference = cellContentDifference(role.revision.cells, additions, removals);
  return difference.addedCells.length > 0 || difference.removedCells.length > 0;
};

/**
 * A role edit exists only where a cell's exact content actually changes: an adoption that a role
 * already covers writes no revision, so a repeated release never churns a role (M1), while a slot whose
 * policy value changed is written as a replacement — the held cell ends and the requested one begins in
 * one edit, so the incarnation writer retires the old cell and mints a fresh incarnation for the new one
 * (R5a-6, O52).
 */
export const planRoleCellEdit = (
  role: RoleWithRevision,
  additions: readonly Cell[],
  removals: readonly Cell[],
  targetRevisionId: string,
): RoleCellEditDraft | undefined => {
  const { addedCells, removedCells } = cellContentDifference(role.revision.cells, additions, removals);
  if (addedCells.length === 0 && removedCells.length === 0) {
    return undefined;
  }
  return {
    addedCells: toSortedCells(addedCells),
    cells: cellsWith(cellsWithout(role.revision.cells, removedCells), addedCells),
    removedCells: toSortedCells(removedCells),
    roleId: role.role.id,
    sourceRevisionId: role.revision.id,
    targetRevisionId,
  };
};
