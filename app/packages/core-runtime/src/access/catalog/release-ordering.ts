import { Option, Schema } from 'effect';

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
 * - `Superseded/published_before`: it was a release once and another one followed it; nothing changes.
 * - `Superseded/not_a_successor`: it drops or narrows something the newest release declares without lineage —
 *   the catalog of an older deployment, or a deployment that removes capabilities. Nothing is published and no
 *   tenant changes. A plain removal therefore never reaches a release: the removed entry stays in the newest
 *   release and is inert, because the gate only ever decides a declaration the running code presents.
 *
 * The rule cannot tell an older deployment that only adds capabilities from a newer one; such a catalog may be
 * published, and then it only adds capabilities, which no running code can use unless it declares them.
 */
export const CatalogReleaseOrderingSchema = Schema.Union([
  Schema.TaggedStruct('Publish', {}),
  Schema.TaggedStruct('Current', {}),
  Schema.TaggedStruct('Superseded', { reason: Schema.Literals(['not_a_successor', 'published_before']) }),
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

/** Whether every capability the newest release declares survives, at least as wide, in the candidate. */
export const coversRelease = (candidate: CatalogSnapshot, newest: CatalogSnapshot): boolean => {
  const byKey = new Map(candidate.entries.map((entry) => [entry.key, entry] as const));
  const claimed = claimedByLineage(candidate.entries);
  return newest.entries.every((entry) => {
    const successor = byKey.get(entry.key);
    return successor === undefined
      ? claimed.has(entry.key)
      : includesAll(successor.modes, entry.modes) && includesAll(successor.selectors, entry.selectors);
  });
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
        return { _tag: 'Superseded', reason: 'published_before' };
      }
      return coversRelease(candidate, newest) ? { _tag: 'Publish' } : { _tag: 'Superseded', reason: 'not_a_successor' };
    },
  });
