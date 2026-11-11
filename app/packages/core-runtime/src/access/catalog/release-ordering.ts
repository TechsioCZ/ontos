import { Option, Schema } from 'effect';

import { CapabilityKeySchema } from '../ids.ts';
import type { CapabilityKey } from '../ids.ts';
import type { CatalogSnapshot, CatalogSnapshotEntry } from '../model.ts';

/**
 * Where one candidate release stands against what is already published (D3). A deployment carries no ordering the
 * platform can trust (no build sequence reaches the running release, and a restarted older container activates
 * again), so the order is decided by content, conservatively: a candidate becomes the newest release only when it
 * is new and *covers* the newest release — every capability the newest release declares is still declared with at
 * least the same modes and record selectors, or is claimed by the candidate's own declared lineage (`renamedFrom`,
 * `splitFrom`). Published releases therefore only ever widen or move capabilities along declared lineage:
 *
 * - `Publish`: unpublished, and it covers the newest release; it becomes the newest release.
 * - `Current`: it is the newest release already; nothing is published and the tenants still follow it.
 * - `PublishedBefore`: it was a release once and another one followed it (an older deployment started again);
 *   nothing changes.
 * - `NotASuccessor`: it drops or narrows something the newest release declares without lineage — the catalog of a
 *   deployment that never published (a side branch, an older build) or one that removes capabilities. Nothing is
 *   published and no tenant changes, and it names what it lacks (`uncoveredKeys`): until an operator resolves it
 *   (`docs/architecture/AUTHORIZATION.md`), no later deployment that also lacks those capabilities publishes either.
 *   A removed entry stays in the newest release and is inert, because the gate only ever decides a declaration the
 *   running code presents.
 *
 * The rule cannot tell an older deployment that only adds capabilities from a newer one; such a catalog may be
 * published, and then it only adds capabilities, which no running code can use unless it declares them.
 */
export const CatalogReleaseOrderingSchema = Schema.Union([
  Schema.TaggedStruct('Publish', {}),
  Schema.TaggedStruct('Current', {}),
  Schema.TaggedStruct('PublishedBefore', {}),
  Schema.TaggedStruct('NotASuccessor', { uncoveredKeys: Schema.NonEmptyArray(CapabilityKeySchema) }),
]);
export type CatalogReleaseOrdering = typeof CatalogReleaseOrderingSchema.Type;

export interface CatalogReleaseOrderingInput {
  readonly candidate: CatalogSnapshot;
  /** The newest published release, when any release exists. */
  readonly newest: Option.Option<CatalogSnapshot>;
  /** The digest of every release ever published. */
  readonly publishedDigests: ReadonlySet<string>;
}

const includesAll = (wider: readonly string[], narrower: readonly string[]): boolean => {
  const offered = new Set(wider);
  return narrower.every((value) => offered.has(value));
};

/** The capability keys a candidate takes over through its own declared lineage. */
const claimedByLineage = (entries: readonly CatalogSnapshotEntry[]): ReadonlySet<string> => {
  const claimed = new Set<string>();
  for (const { lineage } of entries) {
    for (const key of lineage?.renamedFrom ?? []) {
      claimed.add(key);
    }
    if (lineage?.splitFrom !== undefined) {
      claimed.add(lineage.splitFrom);
    }
  }
  return claimed;
};

/** Every capability of the newest release the candidate drops or narrows without lineage, sorted. */
const uncoveredKeysOf = (candidate: CatalogSnapshot, newest: CatalogSnapshot): readonly CapabilityKey[] => {
  const byKey = new Map(candidate.entries.map((entry) => [entry.key, entry] as const));
  const claimed = claimedByLineage(candidate.entries);
  const uncovered: CapabilityKey[] = [];
  for (const entry of newest.entries) {
    const successor = byKey.get(entry.key);
    const covered =
      successor === undefined
        ? claimed.has(entry.key)
        : includesAll(successor.modes, entry.modes) && includesAll(successor.selectors, entry.selectors);
    if (!covered) {
      uncovered.push(entry.key);
    }
  }
  return uncovered.toSorted();
};

/** Content decides, never "differs": the same content is the same release, and a narrower one never wins. */
export const orderCatalogRelease = (input: CatalogReleaseOrderingInput): CatalogReleaseOrdering =>
  Option.match(input.newest, {
    onNone: (): CatalogReleaseOrdering => ({ _tag: 'Publish' }),
    onSome: (newest): CatalogReleaseOrdering => {
      const { candidate } = input;
      if (candidate.digest === newest.digest) {
        return { _tag: 'Current' };
      }
      if (input.publishedDigests.has(candidate.digest)) {
        return { _tag: 'PublishedBefore' };
      }
      const [first, ...rest] = uncoveredKeysOf(candidate, newest);
      return first === undefined ? { _tag: 'Publish' } : { _tag: 'NotASuccessor', uncoveredKeys: [first, ...rest] };
    },
  });
