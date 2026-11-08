import { Result } from 'effect';

import type { CapabilityKey } from '../ids.ts';
import type { AccessChangeKind, AccessRisk, CatalogSnapshot, CatalogSnapshotEntry, RecordSelector } from '../model.ts';
import { compareText, highestRisk } from './compare.ts';
import type { AccessChangesError } from './errors.ts';
import { accessChangesError } from './errors.ts';

/**
 * One change a release brought to the published catalog. `entry` is the operative descriptor:
 * the current one, or the previous one for a capability the release removed. Listing a draft
 * decides nothing and grants nothing; only an adoption decision does (guarantee 2).
 */
export interface CatalogChangeDraft {
  readonly capabilityKey: CapabilityKey;
  /**
   * Whether the release keeps the predecessor's cells usable across the rename without a decision
   * (§3 "renames keep access", D11). True only for a like-for-like rename: same risk and a surface
   * that is not wider. A carrying lane must read this flag and never carry on any other change.
   */
  readonly carriesCells: boolean;
  readonly entry: CatalogSnapshotEntry;
  readonly kind: AccessChangeKind;
  readonly lineageFrom: readonly CapabilityKey[];
  /** The risk the capability had before this release; null only for a first appearance. */
  readonly previousRisk: AccessRisk | null;
}

/** Every key a descriptor claims continuity from: a rename predecessor or a split parent (D11). */
export const lineageParents = (entry: CatalogSnapshotEntry): readonly CapabilityKey[] => {
  const renamedFrom = entry.lineage?.renamedFrom ?? [];
  const { splitFrom } = entry.lineage ?? {};
  return splitFrom === undefined ? renamedFrom : [...renamedFrom, splitFrom];
};

const snapshotIndex = (snapshot: CatalogSnapshot): ReadonlyMap<CapabilityKey, CatalogSnapshotEntry> =>
  new Map(snapshot.entries.map((entry) => [entry.key, entry]));

/**
 * Lineage is the only continuity evidence a release gives Core, so its shape is checked before
 * anything is listed: a predecessor is never still declared, a rename stays one-to-one (D11c),
 * and one predecessor is never both renamed and split.
 */
const lineageIssue = (current: readonly CatalogSnapshotEntry[]): string | undefined => {
  const declared = new Set(current.map(({ key }) => key));
  const renameSuccessors = new Map<CapabilityKey, number>();
  const splitParents = new Set<CapabilityKey>();
  for (const entry of current) {
    for (const parent of entry.lineage?.renamedFrom ?? []) {
      if (declared.has(parent)) {
        return `${entry.key} is renamed from ${parent}, but ${parent} is still declared`;
      }
      renameSuccessors.set(parent, (renameSuccessors.get(parent) ?? 0) + 1);
    }
    const { splitFrom } = entry.lineage ?? {};
    if (splitFrom === undefined) {
      continue;
    }
    if (declared.has(splitFrom)) {
      return `${entry.key} is split from ${splitFrom}, but ${splitFrom} is still declared`;
    }
    splitParents.add(splitFrom);
  }
  for (const [parent, count] of renameSuccessors) {
    if (count > 1) {
      return `${parent} is renamed into ${count} successors; a rename is one-to-one`;
    }
  }
  for (const parent of splitParents) {
    if (renameSuccessors.has(parent)) {
      return `${parent} is both renamed and split`;
    }
  }
  return undefined;
};

/** A capability the previous snapshot declared and this one does not, and no successor claims. */
const isClaimedBySuccessor = (successors: ReadonlySet<CapabilityKey>, key: CapabilityKey): boolean =>
  successors.has(key);

const renamedParentsInWindow = (
  entry: CatalogSnapshotEntry,
  previous: ReadonlyMap<CapabilityKey, CatalogSnapshotEntry>,
): readonly CapabilityKey[] =>
  (entry.lineage?.renamedFrom ?? []).filter((key) => previous.has(key)).toSorted(compareText);

/**
 * A lineage parent outside both snapshots is a wider window, not a conflict: the capability is
 * simply new to the compared releases, and the release that introduced it already told its story.
 */
const splitParentInWindow = (
  entry: CatalogSnapshotEntry,
  previous: ReadonlyMap<CapabilityKey, CatalogSnapshotEntry>,
): CapabilityKey | undefined => {
  const { splitFrom } = entry.lineage ?? {};
  return splitFrom !== undefined && previous.has(splitFrom) ? splitFrom : undefined;
};

const previousRiskOf = (previous: ReadonlyMap<CapabilityKey, CatalogSnapshotEntry>, key: CapabilityKey): AccessRisk =>
  previous.get(key)?.risk ?? 'routine';

/** Every predecessor the window can see, captured before the successors are looked at. */
const predecessorEntries = (
  renames: readonly CapabilityKey[],
  previous: ReadonlyMap<CapabilityKey, CatalogSnapshotEntry>,
): readonly CatalogSnapshotEntry[] =>
  renames.flatMap((key) => {
    const entry = previous.get(key);
    return entry === undefined ? [] : [entry];
  });

/**
 * The record reach a declaration offers: a capability that names no selector is not record-scoped,
 * so its only reach is every record, exactly as the `all` selector reaches it.
 */
const predecessorSelectors = (entry: CatalogSnapshotEntry): readonly RecordSelector[] =>
  entry.selectors.length === 0 ? ['all'] : entry.selectors;

/** A successor that offers modes or record reaches no predecessor offered is not like-for-like. */
const widensSurface = (entry: CatalogSnapshotEntry, predecessors: readonly CatalogSnapshotEntry[]): boolean => {
  const modes = new Set(predecessors.flatMap((before) => before.modes));
  const selectors = new Set(predecessors.flatMap((before) => predecessorSelectors(before)));
  return entry.modes.some((mode) => !modes.has(mode)) || entry.selectors.some((selector) => !selectors.has(selector));
};

/**
 * A rename keeps its predecessor's access only when it is like-for-like (R2-M9, §3, D11): the same
 * risk and no wider surface. A successor that raises the risk or widens the surface is a change a
 * person has to decide on its own terms, so it is reported as `risk_changed` — the catalog entry
 * keeps the lineage evidence, while the item can never be mistaken for a rename that carries cells.
 * Anything that cannot carry reports the predecessor's own risk as `previousRisk`, so a raise or a
 * drop is visible instead of reading as a first appearance.
 */
const renameDraft = (
  entry: CatalogSnapshotEntry,
  renames: readonly CapabilityKey[],
  previous: ReadonlyMap<CapabilityKey, CatalogSnapshotEntry>,
): CatalogChangeDraft => {
  const predecessors = predecessorEntries(renames, previous);
  const previousRisk = highestRisk(predecessors.map((before) => before.risk)) ?? entry.risk;
  const carriesCells = previousRisk === entry.risk && !widensSurface(entry, predecessors);
  return carriesCells
    ? {
        capabilityKey: entry.key,
        carriesCells: true,
        entry,
        kind: 'renamed',
        lineageFrom: renames,
        previousRisk,
      }
    : {
        capabilityKey: entry.key,
        carriesCells: false,
        entry,
        kind: 'risk_changed',
        lineageFrom: [],
        previousRisk,
      };
};

const currentDraft = (
  entry: CatalogSnapshotEntry,
  previous: ReadonlyMap<CapabilityKey, CatalogSnapshotEntry>,
): CatalogChangeDraft | undefined => {
  const before = previous.get(entry.key);
  if (before !== undefined) {
    return before.risk === entry.risk
      ? undefined
      : {
          capabilityKey: entry.key,
          carriesCells: false,
          entry,
          kind: 'risk_changed',
          lineageFrom: [],
          previousRisk: before.risk,
        };
  }
  const renames = renamedParentsInWindow(entry, previous);
  if (renames.length > 0) {
    return renameDraft(entry, renames, previous);
  }
  const splitFrom = splitParentInWindow(entry, previous);
  return {
    capabilityKey: entry.key,
    carriesCells: false,
    entry,
    kind: splitFrom === undefined ? 'new' : 'split',
    lineageFrom: splitFrom === undefined ? [] : [splitFrom],
    previousRisk: splitFrom === undefined ? null : previousRiskOf(previous, splitFrom),
  };
};

const removedDraft = (
  entry: CatalogSnapshotEntry,
  successors: ReadonlySet<CapabilityKey>,
): CatalogChangeDraft | undefined =>
  isClaimedBySuccessor(successors, entry.key)
    ? undefined
    : {
        capabilityKey: entry.key,
        carriesCells: false,
        entry,
        kind: 'removed',
        lineageFrom: [],
        previousRisk: entry.risk,
      };

const draftOrder = (left: CatalogChangeDraft, right: CatalogChangeDraft): number =>
  compareText(left.capabilityKey, right.capabilityKey) || compareText(left.kind, right.kind);

/**
 * The Novinky source: what a published release brought, as new, renamed, split, removed and
 * risk-changed capabilities. Both snapshots are published by definition (O1), so a descriptor a
 * module has not published can never become an item here.
 */
export const diffCatalogSnapshots = (
  previous: CatalogSnapshot,
  current: CatalogSnapshot,
): Result.Result<readonly CatalogChangeDraft[], AccessChangesError> => {
  const conflict = lineageIssue(current.entries);
  if (conflict !== undefined) {
    return Result.fail(accessChangesError('access_changes_lineage_conflict', conflict));
  }
  const previousIndex = snapshotIndex(previous);
  const currentIndex = snapshotIndex(current);
  const successors = new Set(current.entries.flatMap((entry) => lineageParents(entry)));
  const drafts = [
    ...current.entries
      .toSorted((left, right) => compareText(left.key, right.key))
      .flatMap((entry) => {
        const draft = currentDraft(entry, previousIndex);
        return draft === undefined ? [] : [draft];
      }),
    ...previous.entries
      .toSorted((left, right) => compareText(left.key, right.key))
      .flatMap((entry) => {
        const draft = currentIndex.has(entry.key) ? undefined : removedDraft(entry, successors);
        return draft === undefined ? [] : [draft];
      }),
  ];
  return Result.succeed(Object.freeze(drafts.toSorted(draftOrder)));
};
