import assert from 'node:assert/strict';
import { test } from 'node:test';

import { jsonExpressionSnippet } from '../shared/json-globals.ts';
import { inJsonRuleScope } from '../shared/json-rule-scope.ts';

const includePaths = ['apps/**', 'scripts/**'];

test('JSON rule scope preserves defaults, overrides, and exclusions', () => {
  assert.equal(
    inJsonRuleScope('/workspace/apps/example/main.ts', undefined, includePaths),
    true
  );
  assert.equal(
    inJsonRuleScope('packages/example/main.ts', undefined, includePaths),
    false
  );
  assert.equal(
    inJsonRuleScope('apps/example/main.test.ts', undefined, includePaths),
    false
  );
  assert.equal(
    inJsonRuleScope(
      'apps/example/main.test.ts',
      { ignoreTestFiles: false },
      includePaths
    ),
    true
  );
  assert.equal(
    inJsonRuleScope(
      'apps/example/main.ts',
      { allowPaths: ['apps/**'] },
      includePaths
    ),
    false
  );
  assert.equal(
    inJsonRuleScope('apps/example/main.ts', { includePaths: [] }, includePaths),
    true
  );
  assert.equal(
    inJsonRuleScope(
      'apps/example/main.ts',
      { includePaths: [1] },
      includePaths
    ),
    true
  );
  assert.equal(
    inJsonRuleScope(
      'packages/example/main.ts',
      { includePaths: ['packages/**'] },
      includePaths
    ),
    true
  );
  assert.equal(
    inJsonRuleScope(
      'apps/example/main.test.ts',
      { ignoreTestFiles: 'false' },
      includePaths
    ),
    false
  );
});

test('JSON snippets retain whitespace normalization, boundary, and ASCII truncation', () => {
  assert.equal(
    jsonExpressionSnippet('  JSON.stringify(\n  value  )  '),
    'JSON.stringify( value )'
  );
  assert.equal(jsonExpressionSnippet('x'.repeat(72)), 'x'.repeat(72));
  assert.equal(jsonExpressionSnippet('x'.repeat(73)), `${'x'.repeat(69)}...`);
});
