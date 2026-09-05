// `packages/**` is not a route module: shared UI kits keep their own classification helpers.
type Failure = { readonly _tag: 'ForbiddenProblem' | 'NotFoundProblem' };

export const classifyKitFailure = (error: Failure) =>
  error._tag === 'ForbiddenProblem' ? 'forbidden' : 'not_found';
