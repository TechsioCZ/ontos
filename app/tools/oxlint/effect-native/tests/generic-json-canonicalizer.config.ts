export default {
  categories: { correctness: 'off' },
  jsPlugins: [
    { name: 'effect-native', specifier: '../index.ts' },
    { name: 'anti-slop', specifier: '../../anti-slop/index.ts' },
  ],
  rules: {
    'effect-native/no-native-json-stringify': 'error',
    'effect-native/no-structural-document-walking': 'error',
    'anti-slop/no-unknown-parameters': 'error',
    'anti-slop/no-unknown-returns': 'error',
    'anti-slop/no-runtime-typeof': 'error',
  },
};
