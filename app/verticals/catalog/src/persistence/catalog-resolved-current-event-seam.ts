import type { CatalogCurrentResolution } from '../domain/catalog-source-resolution.ts';

/**
 * A resolved-Current change needs proof on both sides. `UNPROVEN` is the typed no-emit: the
 * committed operation may have moved base evidence, but #479 has not established the resolved
 * Current fact, so no #480 change may be claimed.
 */
export type CatalogResolvedCurrentChangeDecision<Value> =
  | {
      readonly kind: 'CHANGED';
      readonly next: CatalogCurrentResolution<Value>;
      readonly previous: CatalogCurrentResolution<Value>;
    }
  | { readonly kind: 'UNCHANGED'; readonly reason: string }
  | { readonly kind: 'UNPROVEN'; readonly reason: string };

const isUnresolved = <Value>(resolution: CatalogCurrentResolution<Value>): boolean =>
  resolution.status !== 'CURRENT' && resolution.status !== 'ABSENT';

/**
 * Emit only when the resolved Current value actually moved. A base update that leaves the active
 * override value in place is `UNCHANGED`; a conflict, absence of a previous basis, or an
 * indeterminate next state is `UNPROVEN` and must not emit.
 */
export const decideCatalogResolvedCurrentChange = <Value>(input: {
  readonly next: CatalogCurrentResolution<Value>;
  readonly previous: CatalogCurrentResolution<Value> | null;
  readonly valuesEqual: (left: Value, right: Value) => boolean;
}): CatalogResolvedCurrentChangeDecision<Value> => {
  const { next, previous } = input;
  if (isUnresolved(next)) {
    return { kind: 'UNPROVEN', reason: 'The next resolved Current fact is not established' };
  }
  if (previous === null || isUnresolved(previous)) {
    return { kind: 'UNPROVEN', reason: 'The previous resolved Current fact is not established' };
  }
  if (next.status === 'ABSENT' && previous.status === 'ABSENT') {
    return { kind: 'UNCHANGED', reason: 'No resolved Current value exists before or after' };
  }
  if (next.status === 'CURRENT' && previous.status === 'CURRENT' && input.valuesEqual(previous.value, next.value)) {
    return { kind: 'UNCHANGED', reason: 'The resolved Current value is unchanged' };
  }
  return { kind: 'CHANGED', next, previous };
};
