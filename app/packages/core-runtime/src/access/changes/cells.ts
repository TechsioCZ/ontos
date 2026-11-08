import type { CapabilityKey } from '../ids.ts';
import type { AccessMode, AmountCeiling, Cell, CellSelector, RecordSelector } from '../model.ts';
import { cellSlotKey } from '../model.ts';
import { compareText } from './compare.ts';

const SELECTOR_ARMS = {
  all: { _tag: 'all' },
  assigned: { _tag: 'assigned' },
  entrusted: { _tag: 'entrusted' },
  team: { _tag: 'team' },
} as const satisfies Readonly<Record<RecordSelector, CellSelector>>;

/** The tagged selector arm for one record selector name; `targets` is not an adoption choice. */
export const selectorOf = (selector: RecordSelector): CellSelector => SELECTOR_ARMS[selector];

/** One exact cell: a capability, one mode, one record selector and an optional amount ceiling. */
export const cellOf = (
  capabilityKey: CapabilityKey,
  mode: AccessMode,
  selector: RecordSelector,
  amountCeiling: AmountCeiling | undefined,
): Cell => {
  const cell = { capabilityKey, mode, selector: selectorOf(selector) };
  return amountCeiling === undefined ? cell : { ...cell, amountCeiling };
};

export const compareCells = (left: Cell, right: Cell): number => compareText(cellSlotKey(left), cellSlotKey(right));

export const toSortedCells = (cells: readonly Cell[]): readonly Cell[] => cells.toSorted(compareCells);

/** The slots of a cell set, which is how every edit, diff and revocation is compared. */
export const cellSlots = (cells: readonly Cell[]): ReadonlySet<string> => new Set(cells.map(cellSlotKey));

export const cellsWithout = (cells: readonly Cell[], removed: readonly Cell[]): readonly Cell[] => {
  const slots = cellSlots(removed);
  return cells.filter((cell) => !slots.has(cellSlotKey(cell)));
};

/** Existing cells keep their order; new cells are appended in slot order so a diff stays stable. */
export const cellsWith = (cells: readonly Cell[], added: readonly Cell[]): readonly Cell[] => {
  const slots = cellSlots(cells);
  return [...cells, ...toSortedCells(added.filter((cell) => !slots.has(cellSlotKey(cell))))];
};
