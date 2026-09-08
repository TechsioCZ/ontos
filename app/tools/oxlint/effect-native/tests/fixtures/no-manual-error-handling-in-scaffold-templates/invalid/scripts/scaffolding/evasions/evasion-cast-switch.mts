/** The discriminant is reached through an `as` cast, which breaks the `[\w$.]*` discriminant match. */
export const renderCastDispatch = (): string => `
const dispatch = (error: unknown) => {
  switch ((error as ReadCoreError)._tag) {
    case 'ReadPermissionDenied':
      return forbiddenProblem();
    default:
      return internalProblem();
  }
};
`;
