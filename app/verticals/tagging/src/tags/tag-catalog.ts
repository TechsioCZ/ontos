// The shared tag catalog: one page dataset per document, read by the tagging page and by every picker on a page.
import { definePageData, pageDataPending } from '@app/shared-contracts/page-data';
import { Effect } from 'effect';
import { useEffect, useSyncExternalStore } from 'react';
import type { SubjectKind, Tag } from '../../shared/apis/records.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { tagsFailureStatus, tagsReadable } from './tag-access.ts';
import type { TagsStatus } from './tag-access.ts';
import { listTags } from './tag-records.ts';

/** One catalog entry per document: a legal-entity or tenant switch reloads the document. */
const catalogScope = 'all';
type CatalogScope = typeof catalogScope;

/**
 * Every tag of the selected legal entity with its tag-wide counts. The tagging page and every picker read this one
 * dataset, so a page that preloaded it shows its options at once and a second picker issues no read of its own.
 */
export const tagCatalogData = definePageData({
  changesFrom: ['tagging'],
  key: (scope: CatalogScope) => scope,
  load: () => listTags.pipe(Effect.map((tags) => [...tags])),
  runtime: browserRuntime,
});

/** Fills the shared tag catalog; a page adds `() => preloadTagCatalog` to its `modulePagePreload`. Never fails. */
export const preloadTagCatalog = tagCatalogData.preload(catalogScope);

/** Re-reads the catalog while the current tags stay on screen. Use after a tag write and for a retry. */
export const refreshTagCatalog = () => {
  browserRuntime.runFork(tagCatalogData.refresh(catalogScope));
};

type TagCatalogSnapshot = ReturnType<typeof tagCatalogData.snapshot>;
const catalogServerSnapshot = (): TagCatalogSnapshot => pageDataPending;
const readCatalog = () => tagCatalogData.snapshot(catalogScope);

/** The shared catalog, read synchronously. While `enabled`, a mount starts the read if nothing preloaded it. */
export const useTagCatalogSnapshot = (enabled: boolean): TagCatalogSnapshot => {
  const snapshot = useSyncExternalStore(tagCatalogData.subscribe, readCatalog, catalogServerSnapshot);
  useEffect(() => {
    if (enabled) {
      tagCatalogData.ensure(catalogScope);
    }
  }, [enabled]);
  return snapshot;
};

/** A failed read that is being retried shows as loading; the error comes back only if the retry fails too. */
export const tagCatalogStatusOf = (snapshot: TagCatalogSnapshot): TagsStatus => {
  if (snapshot.state === 'ready') {
    return 'ready';
  }
  return snapshot.state === 'failed' && !snapshot.refreshing ? tagsFailureStatus(snapshot.error) : 'loading';
};

/** Tags a picker offers, loaded by the picker itself or handed in by a page that already read them. */
export interface TagCatalog {
  readonly refetch: () => void;
  readonly status: TagsStatus;
  readonly tags: readonly Tag[];
}

/** The shared catalog narrowed to the tags that apply to `kind`. Not read at all when tags are not readable here. */
export const useTagCatalog = (kind: SubjectKind, enabled: boolean): TagCatalog => {
  const readable = tagsReadable();
  const snapshot = useTagCatalogSnapshot(enabled && readable);
  const tags = snapshot.state === 'ready' ? snapshot.value.filter((tag) => tag.subjectKinds.includes(kind)) : [];
  return { refetch: refreshTagCatalog, status: readable ? tagCatalogStatusOf(snapshot) : 'forbidden', tags };
};
