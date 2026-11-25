/** Restrictions shared by both lint entrypoints; native Node APIs have a structural-registration rule. */
export const testRestrictedImports = [
  {
    message: 'Import assertions from effect-rstest instead.',
    name: 'node:assert',
  },
  {
    message: 'Import test APIs from effect-rstest instead.',
    name: '@rstest/core',
  },
];
