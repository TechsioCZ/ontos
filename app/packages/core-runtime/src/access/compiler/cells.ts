import { Match, Result } from 'effect';

import type { CapabilityKey, CatalogSnapshotId, RoleTemplateKey } from '../ids.ts';
import type {
  AccessMode,
  AmountCeiling,
  CatalogSnapshot,
  CatalogSnapshotEntry,
  Cell,
  CellSelector,
  PlacementLevel,
  RecordSelector,
} from '../model.ts';
import { cellSlotKey } from '../model.ts';
import { AccessProjectionError } from './projection-error.ts';

/**
 * The Role editor (levels, switches, limits) and templates compile into exact cells pinned to the
 * catalog snapshot the editor was opened against. A level is a view over cells, never a second
 * permission system: a capability shipped in a later release never joins a saved level, it arrives
 * through Novinky and an explicit adoption (guarantee 2, D7).
 *
 * A row or a switch emits exactly the modes and the record selector it chose, defaulting to the
 * narrowest selector the capability declares. That is what makes "assigned clients only" expressible
 * for a capability that also supports `all`, and what lets an agent profile switch a sensitive
 * capability on at `propose` without losing the routine cells of the same profile (D7a, O48a).
 */
const LEVEL_ORDER = { basic: 0, extended: 1, manage: 2 } as const satisfies Readonly<Record<PlacementLevel, number>>;

/**
 * Record selectors from the narrowest grant to the widest (O10). A row or switch that names no
 * selector gets the narrowest one the capability declares, so a level never hands out the scope-wide
 * `all` merely because the capability supports it (D7a, §5 S4).
 */
export const RECORD_SELECTORS_NARROWEST_FIRST = [
  'assigned',
  'entrusted',
  'team',
  'all',
] as const satisfies readonly RecordSelector[];

/**
 * One editor row: a capability group at a level, and exactly the selectors and modes that row grants.
 * The row is a view over cells, so a capability that supports `all` is not silently granted scope-wide
 * when the operator chose "assigned clients only" (D7a).
 */
export interface RoleEditorRow {
  readonly group: string;
  readonly level: PlacementLevel;
  /** The modes this row grants where the capability declares them; omitted = every declared mode. */
  readonly modes?: readonly AccessMode[];
  /** The record selector this row grants; omitted = the narrowest one the capability declares. */
  readonly selector?: RecordSelector;
}

/**
 * A named switch: the only route to a sensitive or critical capability. It carries its own modes and
 * selector for the same reason a row does, and a switch may name fewer modes than the declaration: an
 * agent profile therefore names `['propose']` on a sensitive switch instead of losing its routine
 * cells too (O48a).
 */
export interface RoleEditorSwitch {
  readonly capabilityKey: CapabilityKey;
  /** Omitted = every declared mode. `['propose']` is how an agent profile switches a sensitive cell on. */
  readonly modes?: readonly AccessMode[];
  /** Omitted = the narrowest selector the capability declares. */
  readonly selector?: RecordSelector;
}

export interface RoleEditorLimit {
  readonly amountCeiling: AmountCeiling;
  readonly capabilityKey: CapabilityKey;
}

export interface RoleEditorIntent {
  /** The snapshot the editor is showing; its identity is pinned on the resulting revision. */
  readonly catalog: CatalogSnapshot;
  readonly limits: readonly RoleEditorLimit[];
  readonly rows: readonly RoleEditorRow[];
  /** Explicit switches: the only route for a sensitive or critical capability (D7a, P1). */
  readonly switches: readonly RoleEditorSwitch[];
}

export interface CompiledRoleCells {
  readonly catalogSnapshotId: CatalogSnapshotId;
  readonly cells: readonly Cell[];
}

export interface CompiledRoleTemplate extends CompiledRoleCells {
  readonly templateKey: RoleTemplateKey;
}

export interface RoleTemplateIntent {
  readonly limits: readonly RoleEditorLimit[];
  readonly rows: readonly RoleEditorRow[];
  readonly switches: readonly RoleEditorSwitch[];
  readonly templateKey: RoleTemplateKey;
}

export interface CompanyPresetRole extends RoleTemplateIntent {
  readonly name: string;
}

export interface RoleCellChange {
  readonly after: Cell;
  readonly before: Cell;
  readonly widens: boolean;
}

interface EditorLimits {
  readonly limits: ReadonlyMap<string, AmountCeiling>;
  readonly violations: readonly AccessProjectionError[];
}

interface SwitchedEntries {
  readonly entries: readonly CatalogSnapshotEntry[];
  readonly violations: readonly AccessProjectionError[];
}

export interface RoleCellDiff {
  readonly added: readonly Cell[];
  readonly changed: readonly RoleCellChange[];
  readonly removed: readonly Cell[];
  /** A change that widens access needs individual review, never a batch adoption (D7c). */
  readonly widens: boolean;
}

const violation = (code: AccessProjectionError['code'], reason: string): AccessProjectionError =>
  new AccessProjectionError({ code, reason });

const selectorOf = (selector: RecordSelector): CellSelector =>
  Match.value(selector).pipe(
    Match.when('all', (): CellSelector => ({ _tag: 'all' })),
    Match.when('assigned', (): CellSelector => ({ _tag: 'assigned' })),
    Match.when('entrusted', (): CellSelector => ({ _tag: 'entrusted' })),
    Match.when('team', (): CellSelector => ({ _tag: 'team' })),
    Match.exhaustive,
  );

/** Explicit target sets are a caveat on the `all` slot; cells only ever carry record selectors. */
const targetKeysOf = (cell: Cell): readonly string[] | undefined =>
  Match.value(cell.selector).pipe(
    Match.tag('targets', (targets): readonly string[] | undefined => targets.recordKeys),
    Match.orElse((): readonly string[] | undefined => undefined),
  );

/** The modes a row or switch grants: its own choice, narrowed to what the capability declares. */
const modesOf = (entry: CatalogSnapshotEntry, choice: readonly AccessMode[] | undefined): readonly AccessMode[] => {
  if (choice === undefined) {
    return entry.modes;
  }
  const chosen = new Set<AccessMode>(choice);
  return entry.modes.filter((mode) => chosen.has(mode));
};

/**
 * The selector a row or switch grants. A capability that is not record-scoped has exactly one cell, the
 * scope-wide one; a record-scoped capability gets the chosen selector, or the narrowest declared one,
 * and never a selector its declaration does not have.
 */
const selectorOfEntry = (
  entry: CatalogSnapshotEntry,
  choice: RecordSelector | undefined,
): RecordSelector | undefined => {
  if (entry.selectors.length === 0) {
    return 'all';
  }
  const selector = choice ?? RECORD_SELECTORS_NARROWEST_FIRST.find((candidate) => entry.selectors.includes(candidate));
  return selector !== undefined && entry.selectors.includes(selector) ? selector : undefined;
};

/** The cells one entry contributes at exactly the selector and modes the editor chose. */
const cellsOf = (
  entry: CatalogSnapshotEntry,
  amountCeiling: AmountCeiling | undefined,
  choice: { readonly modes?: readonly AccessMode[]; readonly selector?: RecordSelector },
): readonly Cell[] => {
  const selector = selectorOfEntry(entry, choice.selector);
  if (selector === undefined) {
    return [];
  }
  return modesOf(entry, choice.modes).map((mode): Cell => {
    const selectorCell: Cell = { capabilityKey: entry.key, mode, selector: selectorOf(selector) };
    return amountCeiling === undefined ? selectorCell : { ...selectorCell, amountCeiling };
  });
};

/**
 * The row that includes an entry: a routine capability of that group at or below the row's level. When
 * two rows name one group, the higher level wins, so the row the operator raised is the one that grants.
 */
const rowFor = (entry: CatalogSnapshotEntry, rows: readonly RoleEditorRow[]): RoleEditorRow | undefined =>
  rows
    .filter(
      (row) => row.group === entry.placement.group && LEVEL_ORDER[entry.placement.level] <= LEVEL_ORDER[row.level],
    )
    .toSorted((left, right) => LEVEL_ORDER[right.level] - LEVEL_ORDER[left.level])[0];

/**
 * A level includes only routine capabilities at or below it. Anything sensitive or critical has to be
 * switched on by name, so a level can never quietly hand out a dangerous permission (D7a).
 */
const includedByLevel = (entry: CatalogSnapshotEntry, rows: readonly RoleEditorRow[]): boolean =>
  entry.risk === 'routine' && rowFor(entry, rows) !== undefined;

const limitsFrom = (
  intent: RoleEditorIntent,
  entriesByKey: ReadonlyMap<string, CatalogSnapshotEntry>,
): EditorLimits => {
  const limits = new Map<string, AmountCeiling>();
  const violations = intent.limits.flatMap((limit): readonly AccessProjectionError[] => {
    const entry = entriesByKey.get(limit.capabilityKey);
    if (entry === undefined) {
      return [
        violation(
          'access_projection_unknown_capability',
          `A limit names ${limit.capabilityKey}, which the pinned catalog does not declare`,
        ),
      ];
    }
    if (entry.amountInput === undefined) {
      return [
        violation(
          'access_projection_limit_without_amount_input',
          `${limit.capabilityKey} declares no amount input, so a money limit cannot apply to it`,
        ),
      ];
    }
    if (limits.has(limit.capabilityKey)) {
      return [violation('access_projection_duplicate_intent', `${limit.capabilityKey} carries two limits`)];
    }
    limits.set(limit.capabilityKey, limit.amountCeiling);
    return [];
  });
  return { limits, violations };
};

/** The catalog entries the named switches reach, and every switch that names something it cannot grant. */
const switchedEntries = (
  switches: readonly RoleEditorSwitch[],
  entriesByKey: ReadonlyMap<string, CatalogSnapshotEntry>,
): SwitchedEntries => {
  const violations: AccessProjectionError[] = [];
  const entries: CatalogSnapshotEntry[] = [];
  const seen = new Set<string>();
  for (const controlled of switches) {
    const entry = entriesByKey.get(controlled.capabilityKey);
    if (entry === undefined) {
      violations.push(
        violation(
          'access_projection_unknown_capability',
          `A switch names ${controlled.capabilityKey}, which the pinned catalog does not declare`,
        ),
      );
      continue;
    }
    if (modesOf(entry, controlled.modes).length === 0) {
      violations.push(
        violation(
          'access_projection_cell_outside_declaration',
          `A switch names a mode ${controlled.capabilityKey} does not declare`,
        ),
      );
    }
    // A capability that is not record-scoped has one cell, and a switch that names another selector is
    // asking for a grant the declaration cannot express.
    const namesUnreachableSelector =
      selectorOfEntry(entry, controlled.selector) === undefined ||
      (entry.selectors.length === 0 && controlled.selector !== undefined && controlled.selector !== 'all');
    if (namesUnreachableSelector) {
      violations.push(
        violation(
          'access_projection_cell_outside_declaration',
          `A switch names a selector ${controlled.capabilityKey} does not declare`,
        ),
      );
    }
    if (!seen.has(entry.key)) {
      seen.add(entry.key);
      entries.push(entry);
    }
  }
  return { entries, violations };
};

const compileFrom = (intent: RoleEditorIntent): Result.Result<CompiledRoleCells, readonly AccessProjectionError[]> => {
  const entriesByKey = new Map(
    intent.catalog.entries.map((entry): [string, CatalogSnapshotEntry] => [entry.key, entry]),
  );
  const { limits, violations: limitViolations } = limitsFrom(intent, entriesByKey);
  const { entries: switched, violations: switchViolations } = switchedEntries(intent.switches, entriesByKey);
  const included = intent.catalog.entries.filter((entry) => includedByLevel(entry, intent.rows));
  const entries = [...new Map([...included, ...switched].map((entry) => [entry.key, entry])).values()];
  const includedKeys = new Set<string>(entries.map((entry) => entry.key));
  const switchByKey = new Map<string, RoleEditorSwitch>(
    intent.switches.map((controlled): [string, RoleEditorSwitch] => [controlled.capabilityKey, controlled]),
  );
  const orphanLimits: AccessProjectionError[] = [];
  for (const capabilityKey of limits.keys()) {
    if (!includedKeys.has(capabilityKey)) {
      orphanLimits.push(
        violation('access_projection_unknown_capability', `A limit names ${capabilityKey}, which this role omits`),
      );
    }
  }
  const cellsBySlot = new Map<string, Cell>();
  for (const entry of entries) {
    // A switch grants exactly what the switch named; a level row grants exactly what its row named.
    const choice = switchByKey.get(entry.key) ?? rowFor(entry, intent.rows) ?? {};
    for (const cell of cellsOf(entry, limits.get(entry.key), choice)) {
      cellsBySlot.set(cellSlotKey(cell), cell);
    }
  }
  const cells = [...cellsBySlot.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([, cell]) => cell);
  const violations = [...limitViolations, ...switchViolations, ...orphanLimits];
  return violations.length > 0
    ? Result.fail(violations)
    : Result.succeed({ catalogSnapshotId: intent.catalog.id, cells });
};

export const compileRoleCells = (
  intent: RoleEditorIntent,
): Result.Result<CompiledRoleCells, readonly AccessProjectionError[]> => compileFrom(intent);

export const compileRoleTemplateCells = (
  template: RoleTemplateIntent,
  catalog: CatalogSnapshot,
): Result.Result<CompiledRoleTemplate, readonly AccessProjectionError[]> =>
  Result.map(compileFrom({ ...template, catalog }), (compiled) => ({
    ...compiled,
    templateKey: template.templateKey,
  }));

/** A company preset is a role set; every role is compiled against the same pinned snapshot. */
export const compileCompanyPreset = (
  preset: readonly CompanyPresetRole[],
  catalog: CatalogSnapshot,
): Result.Result<readonly (CompiledRoleTemplate & { readonly name: string })[], readonly AccessProjectionError[]> => {
  const compiled: (CompiledRoleTemplate & { readonly name: string })[] = [];
  const violations: AccessProjectionError[] = [];
  for (const role of preset) {
    const result = compileRoleTemplateCells(role, catalog);
    if (Result.isFailure(result)) {
      violations.push(...result.failure);
    } else {
      compiled.push({ ...result.success, name: role.name });
    }
  }
  return violations.length > 0 ? Result.fail(violations) : Result.succeed(compiled);
};

const ceilingWidens = (before: AmountCeiling | undefined, after: AmountCeiling | undefined): boolean => {
  if (after === undefined) {
    return before !== undefined;
  }
  return before === undefined ? false : before.currency !== after.currency || after.limitMinor > before.limitMinor;
};

const targetsWiden = (beforeKeys: readonly string[] | undefined, afterKeys: readonly string[] | undefined): boolean => {
  if (afterKeys === undefined) {
    return beforeKeys !== undefined;
  }
  const existing = beforeKeys === undefined ? new Set<string>() : new Set(beforeKeys);
  return afterKeys.some((key) => !existing.has(key));
};

const targetKeyText = (cell: Cell): string => targetKeysOf(cell)?.join(',') ?? '';

const cellsDiffer = (before: Cell, after: Cell): boolean =>
  before.amountCeiling?.currency !== after.amountCeiling?.currency ||
  before.amountCeiling?.limitMinor !== after.amountCeiling?.limitMinor ||
  targetKeyText(before) !== targetKeyText(after);

/** Compares two pinned role cell sets slot by slot, so an adoption preview cannot go stale. */
export const diffRoleCells = (before: readonly Cell[], after: readonly Cell[]): RoleCellDiff => {
  const beforeBySlot = new Map(before.map((cell) => [cellSlotKey(cell), cell]));
  const afterBySlot = new Map(after.map((cell) => [cellSlotKey(cell), cell]));
  const changed = [...afterBySlot].flatMap(([slot, afterCell]): readonly RoleCellChange[] => {
    const beforeCell = beforeBySlot.get(slot);
    if (beforeCell === undefined) {
      return [];
    }
    const widens =
      ceilingWidens(beforeCell.amountCeiling, afterCell.amountCeiling) ||
      targetsWiden(targetKeysOf(beforeCell), targetKeysOf(afterCell));
    return widens || cellsDiffer(beforeCell, afterCell) ? [{ after: afterCell, before: beforeCell, widens }] : [];
  });
  const added = after.filter((cell) => !beforeBySlot.has(cellSlotKey(cell)));
  const removed = before.filter((cell) => !afterBySlot.has(cellSlotKey(cell)));
  return { added, changed, removed, widens: added.length > 0 || changed.some((entry) => entry.widens) };
};
