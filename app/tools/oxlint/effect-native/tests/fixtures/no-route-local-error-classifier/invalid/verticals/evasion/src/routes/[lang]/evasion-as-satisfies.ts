// expect-count: 2
// A type assertion around the arrow moves it out of `VariableDeclarator.init`, so the
// `classify*` name is never seen even though the definition is named exactly like the audit's.
type CustomerListError = {
  readonly _tag: 'CustomerListForbiddenProblem' | 'CustomerListUnavailableProblem';
};
type ListState = 'forbidden' | 'unavailable';

export const classifyCustomerListError = ((error: CustomerListError): ListState =>
  error._tag === 'CustomerListForbiddenProblem' ? 'forbidden' : 'unavailable') satisfies (
  error: CustomerListError,
) => ListState;

export const classifyCustomerLifecycleError = ((error: CustomerListError): ListState =>
  error._tag === 'CustomerListForbiddenProblem' ? 'forbidden' : 'unavailable') as (
  error: CustomerListError,
) => ListState;
