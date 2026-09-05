/** Failure classes in the generated Problem Details vocabulary end in `Problem`/`Failure`, not
 *  `Error`, so prototype narrowing over them escapes the `…Error` suffix requirement. */
export const renderVerification = (): string => `
const classifyVerificationFailure = (error: unknown) => {
  if (error instanceof ReadUnavailableProblem) {
    return unavailableProblem();
  }
  return internalProblem();
};
`;
