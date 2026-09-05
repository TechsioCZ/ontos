/**
 * Hand-written application code is out of scope: A4's own rules (`no-manual-tag-comparison`,
 * `no-raw-effect-adt-tag-check`) own these sites. This rule exists only for the generator multiplier.
 */
export const documentation = `
const readProblem = (error: ReadCoreError) => {
  switch (error._tag) {
    case 'ReadInputValidationError': {
      return invalidProblem();
    }
  }
};
const legacy = (error: unknown) => error instanceof ReadCoreError;
`;

export const compare = (error: { readonly _tag: string }): boolean => error._tag === "ReadUnavailable";
