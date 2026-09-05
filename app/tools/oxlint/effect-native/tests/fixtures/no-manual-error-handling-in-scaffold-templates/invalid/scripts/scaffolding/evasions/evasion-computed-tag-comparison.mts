/** Computed member access instead of `._tag`: the same A4 manual tag comparison. */
export const renderClassifier = (): string => `
const classify = (error: ReadCoreError) => {
  if (error["_tag"] === 'ReadUnavailable') {
    return unavailableProblem();
  }
  return internalProblem();
};
`;
