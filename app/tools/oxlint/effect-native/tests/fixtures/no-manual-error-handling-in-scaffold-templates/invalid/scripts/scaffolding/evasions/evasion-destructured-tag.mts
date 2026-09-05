/** The tag is destructured first, so no `._tag ===` ever appears — the comparison is unchanged. */
export const renderDestructured = (): string => `
const classify = (error: ReadCoreError) => {
  const { _tag } = error;
  if (_tag === 'ReadUnavailable') {
    return unavailableProblem();
  }
  return internalProblem();
};
`;
