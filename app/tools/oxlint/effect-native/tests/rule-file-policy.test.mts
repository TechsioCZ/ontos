import { expect, it } from 'effect-rstest';

import {
  acceptsRuleFile,
  ruleFilePolicyProperties,
} from '../shared/rule-file-policy.ts';

const sourceFile = 'packages/core/src/schema.ts';

const policy = { ignore: [], ignoreTests: false, include: ['packages/**'] };

it('rule file policy keeps source and test files in scope by default', () => {
  expect(acceptsRuleFile(sourceFile, policy)).toBe(true);
  expect(acceptsRuleFile('packages/core/tests/schema.test.ts', policy)).toBe(
    true
  );
  expect(acceptsRuleFile('apps/shell/src/schema.ts', policy)).toBe(false);
  expect(acceptsRuleFile(sourceFile, { ...policy, include: [] })).toBe(false);
});

it('rule file policy applies ignore and optional test exclusion', () => {
  expect(
    acceptsRuleFile(sourceFile, {
      ...policy,
      ignore: ['packages/core/**'],
    })
  ).toBe(false);
  expect(
    acceptsRuleFile('packages/core/tests/schema.test.ts', {
      ...policy,
      ignoreTests: true,
    })
  ).toBe(false);
  expect(
    acceptsRuleFile(sourceFile, {
      ...policy,
      ignoreTests: true,
    })
  ).toBe(true);
});

it('rule file policy normalizes absolute and fixture paths before filtering', () => {
  for (const filename of [
    '/workspace/app/packages/core/src/schema.ts',
    String.raw`C:\workspace\app\packages\core\src\schema.ts`,
    'tools/oxlint/effect-native/tests/fixtures/no-nullable-schema-field/invalid/packages/core/src/schema.ts',
  ]) {
    expect(acceptsRuleFile(filename, policy), filename).toBe(true);
  }
});

it('rule file policy exposes the existing JSON option schemas', () => {
  expect(ruleFilePolicyProperties).toStrictEqual({
    ignore: { items: { type: 'string' }, type: 'array' },
    ignoreTests: { type: 'boolean' },
    include: { items: { type: 'string' }, type: 'array' },
  });
});
