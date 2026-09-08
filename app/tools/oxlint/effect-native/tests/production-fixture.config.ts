const { default: config } = await import(
  new URL('../../../../oxlint.config.ts', import.meta.url).href
);
const name = process.env.EFFECT_NATIVE_FIXTURE_RULE;
if (!name) throw new Error('Production fixture config requires an explicit rule name');
const key = `effect-native/${name}`;
if (!(key in config.rules)) throw new Error(`Rule is not enabled in production: ${name}`);

export default {
  categories: { correctness: 'off' },
  jsPlugins: [{ name: 'effect-native', specifier: './fixture-plugin.ts' }],
  rules: { [key]: config.rules[key] },
};
