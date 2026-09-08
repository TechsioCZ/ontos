export const compareTableCatalog = (
  expectedTableNames: readonly string[],
  actualTableNames: readonly string[]
) => {
  const expected = new Set(expectedTableNames);
  const actual = new Set(actualTableNames);
  return {
    missing: [...expected.difference(actual)].toSorted(),
    unexpected: [...actual.difference(expected)].toSorted(),
  };
};
