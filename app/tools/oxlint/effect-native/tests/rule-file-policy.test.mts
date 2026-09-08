import assert from 'node:assert/strict';
import { test } from 'node:test';

import { acceptsRuleFile, ruleFilePolicyProperties } from '../shared/rule-file-policy.ts';

const policy = { include: ['packages/**'], ignore: [], ignoreTests: false };

test('rule file policy keeps source and test files in scope by default', () => {
  assert.equal(acceptsRuleFile('packages/core/src/schema.ts', policy), true);
  assert.equal(acceptsRuleFile('packages/core/tests/schema.test.ts', policy), true);
  assert.equal(acceptsRuleFile('apps/shell/src/schema.ts', policy), false);
  assert.equal(acceptsRuleFile('packages/core/src/schema.ts', { ...policy, include: [] }), false);
});

test('rule file policy applies ignore and optional test exclusion', () => {
  assert.equal(
    acceptsRuleFile('packages/core/src/schema.ts', { ...policy, ignore: ['packages/core/**'] }),
    false,
  );
  assert.equal(
    acceptsRuleFile('packages/core/tests/schema.test.ts', { ...policy, ignoreTests: true }),
    false,
  );
  assert.equal(
    acceptsRuleFile('packages/core/src/schema.ts', { ...policy, ignoreTests: true }),
    true,
  );
});

test('rule file policy normalizes absolute and fixture paths before filtering', () => {
  for (const filename of [
    '/workspace/app/packages/core/src/schema.ts',
    'C:\\workspace\\app\\packages\\core\\src\\schema.ts',
    'tools/oxlint/effect-native/tests/fixtures/no-nullable-schema-field/invalid/packages/core/src/schema.ts',
  ]) {
    assert.equal(acceptsRuleFile(filename, policy), true, filename);
  }
});

test('rule file policy exposes the existing JSON option schemas', () => {
  assert.deepEqual(ruleFilePolicyProperties, {
    ignore: { items: { type: 'string' }, type: 'array' },
    ignoreTests: { type: 'boolean' },
    include: { items: { type: 'string' }, type: 'array' },
  });
});
