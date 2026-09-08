// expect-count: 2
// `({ _tag }) => …` is detected, but pulling the discriminant out one line later is not.
type ContactsFailure = { readonly _tag: 'ContactsForbiddenProblem' | 'ContactsNotFoundProblem' };

export const listFailureState = (error: ContactsFailure) => {
  const { _tag } = error;
  return _tag === 'ContactsForbiddenProblem' ? 'forbidden' : 'not_found';
};

export function lifecycleFailureState(failure: ContactsFailure) {
  const { _tag: tag } = failure;
  switch (tag) {
    case 'ContactsForbiddenProblem': {
      return 'forbidden';
    }
    default: {
      return 'not_found';
    }
  }
}
