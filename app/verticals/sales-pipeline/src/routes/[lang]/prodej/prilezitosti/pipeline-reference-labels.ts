// How a customer or owner reference on an opportunity reads in the table and detail. Names come from Party Registry
// and Workforce. A person who may not read those modules (or whose read failed) gets a settled "unavailable" label
// instead of a placeholder that looks like it is still loading; the opportunity read itself is never widened.
import { Schema } from 'effect';
import type { LoadState } from './pipeline-references.ts';

/** `loading` until the reference read settles; `unavailable` when it failed or was refused for this person. */
export const ReferenceStatusSchema = Schema.Literals(['loading', 'ready', 'unavailable']);
export type ReferenceStatus = typeof ReferenceStatusSchema.Type;

const statusByLoadState = { error: 'unavailable', loading: 'loading', ready: 'ready' } as const;

export const referenceStatusOf = (state: LoadState<unknown>): ReferenceStatus => statusByLoadState[state.status];

/** What one reference cell shows: the record, or why there is no name. */
export type ReferenceLabel<Item> =
  | { readonly item: Item; readonly kind: 'found' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unknown' };

/** `unknown` only when the list loaded and the id is not in it; a refused read never claims the record is unknown. */
export const resolveReference = <Item>(
  byId: ReadonlyMap<string, Item>,
  status: ReferenceStatus,
  id: string,
): ReferenceLabel<Item> => {
  const item = byId.get(id);
  if (item !== undefined) {
    return { item, kind: 'found' };
  }
  return status === 'ready' ? { kind: 'unknown' } : { kind: status };
};

/** Text for a reference without a name of its own: still loading, refused or failed, or not in the loaded list. */
export interface ReferenceTexts {
  readonly loading: string;
  readonly unavailable: string;
  readonly unknown: string;
}

export const referenceText = <Item>(
  reference: ReferenceLabel<Item>,
  name: (item: Item) => string,
  texts: ReferenceTexts,
): string => (reference.kind === 'found' ? name(reference.item) : texts[reference.kind]);
