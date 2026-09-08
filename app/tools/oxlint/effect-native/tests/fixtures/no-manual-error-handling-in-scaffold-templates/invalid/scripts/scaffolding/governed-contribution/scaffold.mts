// expect-count: 3
// One switch and two tag checks; Effect.catch itself is not a Promise catch.
/** A8 evidence shape: the governed-contribution generator emits a hand-rolled `_tag` dispatch. */
export const renderGovernedContribution = (problemStem: string): string => `
const readProblem = (error: ReadCoreError) => {
  switch (error._tag) {
    case '${problemStem}InputValidationError': {
      return invalidProblem();
    }
    default: {
      return internalProblem();
    }
  }
};

const program = verifyOperationPrincipal(request.headers.authorization).pipe(
  Effect.catch((error) => {
    if (
      error._tag === 'ActionPrincipalConfigurationError' ||
      error._tag !== 'ActionPrincipalUnavailableError'
    ) {
      return Effect.fail(unavailableProblem());
    }
    return Effect.fail(authenticationProblem());
  }),
);
`;
