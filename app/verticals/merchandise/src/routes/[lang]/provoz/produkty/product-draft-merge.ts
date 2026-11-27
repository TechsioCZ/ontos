// A product draft that a save over someone else's change left unsaved, put over the version they saved: what the
// operator changed since the version the draft was based on goes over the fresh version, everything else is theirs.
import { Equal, Struct } from 'effect';

/** A draft rebased on a newer server version. */
export interface DraftMerge<V> {
  /** The fresh version with the operator's own changes on top. */
  readonly merged: V;
  /**
   * The operator and someone else changed the same field to different values. `merged` keeps the operator's value
   * there, so the operator has to check it before saving.
   */
  readonly overlap: boolean;
}

/** A plain record of fields (a form draft or part of one); class instances such as an Option are single values. */
const isFields = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * Three-way merge of a draft: `base` is the version the draft was based on, `mine` the operator's draft and `theirs`
 * the newer server version. A field only the operator changed takes the operator's value, any other field the fresh
 * one. Records merge field by field; a list (or any other value) is one value, so changes to the same list on both
 * sides overlap (`mergeKeyedDrafts` merges a list of identified entries entry by entry).
 */
export const mergeDraft = <V>(base: V, mine: V, theirs: V): DraftMerge<V> => {
  if (Equal.equals(mine, base)) {
    return { merged: theirs, overlap: false };
  }
  if (Equal.equals(theirs, base) || Equal.equals(mine, theirs)) {
    return { merged: mine, overlap: false };
  }
  if (!(isFields(base) && isFields(mine) && isFields(theirs))) {
    return { merged: mine, overlap: true };
  }
  // The fresh version names the fields: a field it no longer has is no longer part of the form.
  const merged = { ...theirs };
  let overlap = false;
  for (const key of Struct.keys(theirs)) {
    const field = mergeDraft(base[key], mine[key], theirs[key]);
    merged[key] = field.merged;
    overlap ||= field.overlap;
  }
  return { merged, overlap };
};

/**
 * `mergeDraft` of a list whose entries carry their own identity as `key` (a variant id, or a new entry's own key):
 * entries merge one by one. An entry someone else added stays, one the operator added is appended. An entry removed
 * on one side stays removed unless the other side changed it; then it stays, as an overlap.
 */
export const mergeKeyedDrafts = <I extends { readonly key: string }>(
  base: readonly I[],
  mine: readonly I[],
  theirs: readonly I[],
): DraftMerge<readonly I[]> => {
  if (Equal.equals(mine, base)) {
    return { merged: theirs, overlap: false };
  }
  if (Equal.equals(theirs, base) || Equal.equals(mine, theirs)) {
    return { merged: mine, overlap: false };
  }
  const byKey = (entries: readonly I[]) => new Map(entries.map((entry) => [entry.key, entry] as const));
  const before = byKey(base);
  const own = byKey(mine);
  const fresh = byKey(theirs);
  const merged: I[] = [];
  let overlap = false;
  for (const entry of theirs) {
    const original = before.get(entry.key);
    const ours = own.get(entry.key);
    if (ours === undefined) {
      // Added by someone else, or removed by the operator: a removal holds unless someone else changed the entry.
      if (original === undefined || !Equal.equals(entry, original)) {
        overlap ||= original !== undefined;
        merged.push(entry);
      }
    } else if (original === undefined) {
      // Both sides added an entry with the same key.
      overlap ||= !Equal.equals(ours, entry);
      merged.push(ours);
    } else {
      const field = mergeDraft(original, ours, entry);
      overlap ||= field.overlap;
      merged.push(field.merged);
    }
  }
  for (const ours of mine) {
    const original = before.get(ours.key);
    // Added by the operator; or removed by someone else, which holds unless the operator changed the entry.
    if (!fresh.has(ours.key) && (original === undefined || !Equal.equals(ours, original))) {
      overlap ||= original !== undefined;
      merged.push(ours);
    }
  }
  return { merged, overlap };
};
