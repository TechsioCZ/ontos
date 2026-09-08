// expect-count: 2
// The React idiom for a route-local classifier: the arrow is an argument, so the `classify*`
// binding name is invisible to the rule.
import { useCallback, useMemo } from 'react';

type ContactsFailure = { readonly _tag: 'ContactsForbiddenProblem' | 'ContactsNotFoundProblem' };

export const useCustomerList = () => {
  const classifyCustomerListError = useCallback(
    (error: ContactsFailure) =>
      error._tag === 'ContactsForbiddenProblem' ? 'forbidden' : 'not_found',
    [],
  );
  return classifyCustomerListError;
};

export const classifyContactLifecycleError = useMemo(
  () => (error: ContactsFailure) =>
    error._tag === 'ContactsForbiddenProblem' ? 'forbidden' : 'not_found',
  [],
);
