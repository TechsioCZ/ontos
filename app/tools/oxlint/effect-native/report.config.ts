const { default: rootConfig } = await import(
  new URL('../../../oxlint.config.ts', import.meta.url).href
);

// Diagnostic-only view of exactly the production Effect rule settings, without unrelated rules.
export default {
  categories: { correctness: 'off' },
  ignorePatterns: rootConfig.ignorePatterns,
  jsPlugins: [{ name: 'effect-native', specifier: './index.ts' }],
  rules: Object.fromEntries(
    Object.entries(rootConfig.rules).filter(([name]) => name.startsWith('effect-native/')),
  ),
};
