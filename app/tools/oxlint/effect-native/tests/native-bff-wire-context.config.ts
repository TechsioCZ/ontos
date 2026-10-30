// The cases live in a temporary workspace below the application root, so scope the rule to that workspace's packages.
export default {
  categories: { correctness: 'off' },
  jsPlugins: [{ name: 'effect-native', specifier: './fixture-plugin.ts' }],
  rules: { 'effect-native/no-threaded-correlation-parameter': ['error', { includePaths: ['**/packages/**'] }] },
};
