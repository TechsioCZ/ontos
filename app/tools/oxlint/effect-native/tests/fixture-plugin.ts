import { eslintCompatPlugin } from '@oxlint/plugins';

import { discoverRules } from '../shared/discover-rules.ts';

const selectedRule = process.env.EFFECT_NATIVE_FIXTURE_RULE ?? process.env.RULE;

/** Production registration is checked separately; one broken rule must not hide other fixture failures. */
export default eslintCompatPlugin({
  meta: { name: 'effect-native' },
  rules: await discoverRules(selectedRule ? [selectedRule] : undefined),
});
