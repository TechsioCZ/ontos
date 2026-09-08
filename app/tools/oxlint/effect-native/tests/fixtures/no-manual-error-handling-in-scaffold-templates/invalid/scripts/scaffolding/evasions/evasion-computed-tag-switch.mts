/** Computed member access as the switch discriminant. */
export const renderComputedDispatch = (): string => `
const dispatch = (error: ReadCoreError) => {
  switch (error['_tag']) {
    case 'ReadUnavailable':
      return unavailableProblem();
    default:
      return internalProblem();
  }
};
`;
