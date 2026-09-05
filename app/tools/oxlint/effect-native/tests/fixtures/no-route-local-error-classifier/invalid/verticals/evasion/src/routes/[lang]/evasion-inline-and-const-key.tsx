// expect-count: 4
// A binding name is not required for A4 reclassification, and the discriminant key can hide behind
// a `const`. All four definitions below re-derive UI state from `_tag` inside a route module.
type ContactsFailure = { readonly _tag: 'ContactsForbiddenProblem' | 'ContactsNotFoundProblem' };

const TAG = '_tag' as const;

// Curried factory: the classifier is the inner, unnamed arrow.
export const failureStateFactory = (fallback: string) => (error: ContactsFailure) =>
  error._tag === 'ContactsForbiddenProblem' ? 'forbidden' : fallback;

// Default export: no binding name at all.
export default (failure: ContactsFailure) =>
  failure._tag === 'ContactsNotFoundProblem' ? 'not_found' : 'unexpected';

// The discriminant key behind a `const`-bound computed member.
export const bannerState = (problem: ContactsFailure) =>
  problem[TAG] === 'ContactsForbiddenProblem' ? 'forbidden' : 'not_found';

// An anonymous callback handed to an unrelated helper still classifies route-locally; the outer
// `error: string` parameter is shadowed and must not be blamed for the inner read.
declare const rows: readonly ContactsFailure[];
export const labels = (error: string) =>
  rows.map((error: ContactsFailure) => `${error._tag}-${String(error)}`);
