/** Optional chaining on the discriminant: still a hand-rolled, non-exhaustive `_tag` dispatch. */
export const renderDispatch = (): string => `
const dispatch = (error: unknown) => {
  switch (error?._tag) {
    case 'ReadUnavailable':
      return unavailableProblem();
    default:
      return internalProblem();
  }
};
`;
