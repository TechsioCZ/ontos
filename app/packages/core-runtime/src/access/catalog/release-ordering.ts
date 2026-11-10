import { Option, Schema } from 'effect';

import type { CatalogSnapshot } from '../model.ts';
import { catalogReleaseLines } from './release.ts';

/**
 * Where one candidate release stands against what is already published (D3). A release is never un-published
 * and the newest release is the one every adoption and every new role pins, so a candidate only becomes the
 * newest release when it is new and not narrower than the newest one: an older deployment that starts again
 * while a newer one serves (a restart during an overlapping deploy) can never move the catalog back.
 *
 * - `Publish`: unpublished and not narrower than the newest release; it becomes the newest release.
 * - `Current`: it is the newest release already; nothing is published and the tenants still follow it.
 * - `Superseded`: an older catalog. `published_before`: it was a release once and something newer followed
 *   it. `narrower_than_newest`: every entry it declares is in the newest release, which declares more — the
 *   catalog of a deployment older than the newest release, or a release that would only remove
 *   capabilities. Nothing is published and no tenant changes; a removal is published with the next release
 *   that also adds or changes something, and until then the removed entries stay inert.
 */
export const CatalogReleaseOrderingSchema = Schema.Union([
  Schema.TaggedStruct('Publish', {}),
  Schema.TaggedStruct('Current', {}),
  Schema.TaggedStruct('Superseded', { reason: Schema.Literals(['narrower_than_newest', 'published_before']) }),
]);
export type CatalogReleaseOrdering = typeof CatalogReleaseOrderingSchema.Type;

export interface CatalogReleaseOrderingInput {
  readonly candidate: CatalogSnapshot;
  /** The newest published release, when any release exists. */
  readonly newest: Option.Option<CatalogSnapshot>;
  /** The digest of every release ever published. */
  readonly publishedDigests: ReadonlySet<string>;
}

/** Content decides, never "differs": the same content is the same release, and an older one never wins. */
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
      const newestLines = new Set(catalogReleaseLines(newest.entries));
      return catalogReleaseLines(candidate.entries).every((line) => newestLines.has(line))
        ? { _tag: 'Superseded', reason: 'narrower_than_newest' }
        : { _tag: 'Publish' };
    },
  });
