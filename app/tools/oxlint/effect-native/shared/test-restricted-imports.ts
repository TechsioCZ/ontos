/** Test APIs must use the Effect-native runner in both lint entrypoints. */
export const testRestrictedImports = [
  { message: 'Import test APIs from @app/effect-rstest instead.', name: 'node:test' },
  {
    message: 'Import assertions from @app/effect-rstest instead.',
    name: 'node:assert',
  },
  {
    message: 'Import assertions from @app/effect-rstest instead.',
    name: 'node:assert/strict',
  },
  {
    message: 'Import test APIs from @app/effect-rstest instead.',
    name: '@rstest/core',
  },
];
