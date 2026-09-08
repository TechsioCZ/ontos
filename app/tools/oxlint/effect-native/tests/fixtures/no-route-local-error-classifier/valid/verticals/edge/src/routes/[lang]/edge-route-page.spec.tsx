// A `.spec.tsx` beside the route it covers: tests of the closed vocabulary stay healthy.
type Failure = { readonly _tag: 'ForbiddenProblem' | 'NotFoundProblem' };

export const classifySpecFailure = (error: Failure) =>
  error._tag === 'ForbiddenProblem' ? 'forbidden' : 'not_found';

export const Fixture = () => <p>{classifySpecFailure({ _tag: 'ForbiddenProblem' })}</p>;
