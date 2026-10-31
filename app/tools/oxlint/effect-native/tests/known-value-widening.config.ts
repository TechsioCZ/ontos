export default {
  categories: { correctness: 'off' },
  jsPlugins: [{ name: 'anti-slop', specifier: '../../anti-slop/index.ts' }],
  rules: { 'anti-slop/no-known-value-widening': 'error' },
};
