// expect-count: 4
import type { ErrorClassificationInput } from '../../../error-classification.ts';

type CustomerListError = { readonly _tag: 'CustomerListForbiddenProblem' };
type ListState = { readonly state: 'forbidden' | 'unavailable' };

// Axis 1 + axis 2: named `classify*` over the erased-union projection type.
export const classifyCustomerListError = (
  error: ErrorClassificationInput<CustomerListError>,
): ListState => {
  switch (error._tag) {
    case 'CustomerListForbiddenProblem': {
      return { state: 'forbidden' };
    }
    default: {
      return { state: 'unavailable' };
    }
  }
};

// Axis 1: `classify*` without any annotation at all.
export function classifyLifecycleError(error) {
  return error._tag === 'ContactsConflictProblem' ? 'conflict' : 'unexpected';
}

// Axis 1: verbatim copy of the shared helper, third occurrence in the codebase.
const classifyHttpClientFailure = (error: {
  readonly reason: { readonly _tag: string };
}): 'decode' | 'transport' =>
  error.reason._tag === 'TransportError' ? 'transport' : 'decode';

// Axis 3: same anti-pattern, different name.
const lifecycleFailureState = (failure: CustomerListError, fallback: ListState): ListState =>
  failure._tag === 'CustomerListForbiddenProblem' ? { state: 'forbidden' } : fallback;

export const Page = () => (
  <p>
    {classifyHttpClientFailure({ reason: { _tag: 'TransportError' } })}
    {lifecycleFailureState({ _tag: 'CustomerListForbiddenProblem' }, { state: 'unavailable' }).state}
  </p>
);
