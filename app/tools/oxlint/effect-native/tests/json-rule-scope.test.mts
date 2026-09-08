import { expect, it } from 'effect-rstest';

import { jsonExpressionSnippet } from '../shared/json-globals.ts';
import { inJsonRuleScope } from '../shared/json-rule-scope.ts';

const sourceFile = 'apps/example/main.ts';
const testFile = 'apps/example/main.test.ts';

const includePaths = ['apps/**', 'scripts/**'];

it('JSON rule scope preserves defaults, overrides, and exclusions', () => {
  expect(inJsonRuleScope('/workspace/apps/example/main.ts', undefined, includePaths)).toBe(true);
  expect(inJsonRuleScope('packages/example/main.ts', undefined, includePaths)).toBe(false);
  expect(inJsonRuleScope(testFile, undefined, includePaths)).toBe(false);
  expect(inJsonRuleScope(testFile, { ignoreTestFiles: false }, includePaths)).toBe(true);
  expect(inJsonRuleScope(sourceFile, { allowPaths: ['apps/**'] }, includePaths)).toBe(false);
  expect(inJsonRuleScope(sourceFile, { includePaths: [] }, includePaths)).toBe(true);
  expect(inJsonRuleScope(sourceFile, { includePaths: [1] }, includePaths)).toBe(true);
  expect(
    inJsonRuleScope('packages/example/main.ts', { includePaths: ['packages/**'] }, includePaths),
  ).toBe(true);
  expect(inJsonRuleScope(testFile, { ignoreTestFiles: 'false' }, includePaths)).toBe(false);
});

it('JSON snippets retain whitespace normalization, boundary, and ASCII truncation', () => {
  expect(jsonExpressionSnippet('  JSON.stringify(\n  value  )  ')).toBe('JSON.stringify( value )');
  expect(jsonExpressionSnippet('x'.repeat(72))).toBe('x'.repeat(72));
  expect(jsonExpressionSnippet('x'.repeat(73))).toBe(`${'x'.repeat(69)}...`);
});
