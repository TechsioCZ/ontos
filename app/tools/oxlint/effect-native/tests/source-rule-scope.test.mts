import { expect, it } from 'effect-rstest';

import { isSourceRuleInScope } from '../shared/source-rule-scope.ts';

const defaults = {
  ignore: [],
  includePaths: ['apps/**', 'packages/**', 'verticals/**'],
  includeScripts: false,
  includeTests: false,
};

it('source rule scope applies include and ignore gates before opt-ins', () => {
  expect(isSourceRuleInScope('apps/example/src/main.ts', defaults)).toBe(true);
  expect(isSourceRuleInScope('tools/example.ts', defaults)).toBe(false);
  expect(
    isSourceRuleInScope('apps/example/src/main.ts', {
      ...defaults,
      ignore: ['apps/**'],
    }),
  ).toBe(false);
  expect(
    isSourceRuleInScope('scripts/main.ts', {
      ...defaults,
      includeScripts: true,
    }),
  ).toBe(false);
});

it('source rule scope independently gates scripts and tests', () => {
  const scriptDefaults = {
    ignore: [],
    includePaths: ['apps/**', 'scripts/**'],
    includeScripts: false,
    includeTests: false,
  };
  const script = 'scripts/main.ts';
  const testFile = 'apps/example/src/main.test.ts';
  const scriptTest = 'scripts/main.test.ts';
  expect(isSourceRuleInScope(script, scriptDefaults)).toBe(false);
  expect(isSourceRuleInScope(script, { ...scriptDefaults, includeScripts: true })).toBe(true);
  expect(isSourceRuleInScope(testFile, scriptDefaults)).toBe(false);
  expect(isSourceRuleInScope(testFile, { ...scriptDefaults, includeTests: true })).toBe(true);
  expect(isSourceRuleInScope(scriptTest, { ...scriptDefaults, includeScripts: true })).toBe(false);
  expect(isSourceRuleInScope(scriptTest, { ...scriptDefaults, includeTests: true })).toBe(false);
  expect(
    isSourceRuleInScope(scriptTest, {
      ...scriptDefaults,
      includeScripts: true,
      includeTests: true,
    }),
  ).toBe(true);
});

it('source rule scope preserves fixture path normalization', () => {
  const prefix = 'tools/oxlint/effect-native/tests/fixtures/no-dependency-parameters/invalid/';
  expect(isSourceRuleInScope(`${prefix}apps/example/src/main.ts`, defaults)).toBe(true);
  expect(isSourceRuleInScope(`${prefix}apps/example/src/main.test.ts`, defaults)).toBe(false);
});
