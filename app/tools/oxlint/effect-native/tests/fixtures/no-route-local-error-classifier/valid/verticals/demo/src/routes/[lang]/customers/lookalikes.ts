// Sorting/paging helpers in a route module: error-adjacent names, no `_tag` discrimination.
type Row = { readonly id: string; readonly rank: number };

export const compareByRank = (left: Row, right: Row) => left.rank - right.rank;

// Parameter is error-shaped but the function never discriminates it.
export const logFailure = (error: { readonly message: string }) => error.message;

// `_tag` read on a nested captured value, not on the parameter binding.
const registry = { failure: { _tag: 'ContactsNotFoundProblem' } } as const;
export const registryState = (fallback: string) =>
  registry.failure._tag === 'ContactsNotFoundProblem' ? 'not_found' : fallback;

// A computed member behind a `const` that is *not* the discriminant key.
const KEY = 'reason' as const;
export const reasonOf = (error: { readonly reason: string }) => error[KEY];

// Shadowing: the `_tag` read belongs to the inner binding, so the outer `error: string` parameter
// (which is a label, not a failure) must not be reported.
declare const rows: readonly { readonly _tag: string }[];
export const labelFor = (error: string) => rows.map((row) => `${error}-${row._tag}`);
