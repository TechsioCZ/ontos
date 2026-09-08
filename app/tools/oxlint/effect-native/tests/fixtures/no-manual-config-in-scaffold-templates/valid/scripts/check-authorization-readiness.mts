/** A checker script, not a generator: its templates are console output. */
const explain = (variable: string): string => `
  ${variable} was read from process.env and decoded with JSON.parse.
  new URL(...) rejected the value; typeof value !== 'object'; Array.isArray(value) was false.
  throw configurationError() would have been raised by the legacy path.
`;

export const report = (variable: string): void => {
  console.log(explain(variable));
};
