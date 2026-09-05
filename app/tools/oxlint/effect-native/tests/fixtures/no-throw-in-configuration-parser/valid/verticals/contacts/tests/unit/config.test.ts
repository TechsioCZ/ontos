// Tests are excluded by default (`ignoreTestFiles`): the D tier blesses fail-fast throws in tests.
export const setupEnvironment = (environment: Readonly<Record<string, string | undefined>>): string => {
  const url = environment['DATABASE_URL'];
  if (url === undefined) {
    throw new Error('DATABASE_URL is required for this test');
  }
  return url;
};
