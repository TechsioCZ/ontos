import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isSourceRuleInScope } from '../shared/source-rule-scope.ts';

const defaults = {
  includePaths: ['apps/**', 'packages/**', 'verticals/**'],
  ignore: [],
  includeScripts: false,
  includeTests: false,
};

test('source rule scope applies include and ignore gates before opt-ins', () => {
  assert.equal(isSourceRuleInScope('apps/example/src/main.ts', defaults), true);
  assert.equal(isSourceRuleInScope('tools/example.ts', defaults), false);
  assert.equal(
    isSourceRuleInScope('apps/example/src/main.ts', {
      ...defaults,
      ignore: ['apps/**'],
    }),
    false
  );
  assert.equal(
    isSourceRuleInScope('scripts/main.ts', {
      ...defaults,
      includeScripts: true,
    }),
    false
  );
});

test('source rule scope independently gates scripts and tests', () => {
  const defaults = {
    includePaths: ['apps/**', 'scripts/**'],
    ignore: [],
    includeScripts: false,
    includeTests: false,
  };
  const script = 'scripts/main.ts';
  const testFile = 'apps/example/src/main.test.ts';
  const scriptTest = 'scripts/main.test.ts';
  assert.equal(isSourceRuleInScope(script, defaults), false);
  assert.equal(
    isSourceRuleInScope(script, { ...defaults, includeScripts: true }),
    true
  );
  assert.equal(isSourceRuleInScope(testFile, defaults), false);
  assert.equal(
    isSourceRuleInScope(testFile, { ...defaults, includeTests: true }),
    true
  );
  assert.equal(
    isSourceRuleInScope(scriptTest, { ...defaults, includeScripts: true }),
    false
  );
  assert.equal(
    isSourceRuleInScope(scriptTest, { ...defaults, includeTests: true }),
    false
  );
  assert.equal(
    isSourceRuleInScope(scriptTest, {
      ...defaults,
      includeScripts: true,
      includeTests: true,
    }),
    true
  );
});

test('source rule scope preserves fixture path normalization', () => {
  const prefix =
    'tools/oxlint/effect-native/tests/fixtures/no-dependency-parameters/invalid/';
  assert.equal(
    isSourceRuleInScope(`${prefix}apps/example/src/main.ts`, defaults),
    true
  );
  assert.equal(
    isSourceRuleInScope(`${prefix}apps/example/src/main.test.ts`, defaults),
    false
  );
});
