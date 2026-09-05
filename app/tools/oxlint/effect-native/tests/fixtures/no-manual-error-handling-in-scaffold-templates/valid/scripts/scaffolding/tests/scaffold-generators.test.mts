/**
 * Scaffold golden-output tests legitimately quote the generated text they assert on. Test files are
 * excluded from this rule; the audit blesses deliberately literal fixtures in tests.
 */
export const expectedGeneratedProgram = `
const readProblem = (error: ReadCoreError) => {
  switch (error._tag) {
    case 'ReadInputValidationError': {
      return invalidProblem();
    }
  }
};
const classify = (error: unknown) => error instanceof ActionPrincipalMissingError;
const guarded = read().catch((error) => {
  if (error._tag === 'ReadUnavailable') {
    return null;
  }
  return null;
});
`;
