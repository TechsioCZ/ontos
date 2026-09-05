/** The discriminant identifier is interpolated, so the emitted `switch (error._tag)` is split
 *  across two template elements. The generated text is still A4's non-exhaustive tag dispatch. */
export const renderReadProblem = (errorIdent: string): string => `
const readProblem = (${errorIdent}: ReadCoreError) => {
  switch (${errorIdent}._tag) {
    case 'ReadInputValidationError':
      return invalidProblem();
    default:
      return internalProblem();
  }
};
`;
