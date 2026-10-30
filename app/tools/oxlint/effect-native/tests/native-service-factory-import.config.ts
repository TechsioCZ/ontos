export default {
  categories: { correctness: 'off' },
  jsPlugins: [{ name: 'anti-slop-effect', specifier: '../../anti-slop/effect/index.ts' }],
  rules: { 'anti-slop-effect/no-service-constructor-imports': 'error' },
};
