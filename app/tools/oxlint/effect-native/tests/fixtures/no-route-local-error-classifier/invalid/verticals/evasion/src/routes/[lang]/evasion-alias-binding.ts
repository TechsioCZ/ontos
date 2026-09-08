// expect-count: 1
// One local binding between the parameter and the `_tag` read defeats the discriminator axis.
type ContactsFailure = { readonly _tag: 'ContactsForbiddenProblem' | 'ContactsNotFoundProblem' };

export const detailFailureState = (error: ContactsFailure) => {
  const failure = error;
  return failure._tag === 'ContactsForbiddenProblem' ? 'forbidden' : 'not_found';
};
