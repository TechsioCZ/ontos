import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SyntaxKind } from '@typescript/native/unstable/ast';

import {
  DelimiterDepth,
  matchingDelimiter,
  separatedSource,
  toCamelCase,
  topLevelSeparators,
} from '../boundary-source-structure.mts';
import {
  hasGeneratedModuleApiContract,
  hasGeneratedProviderApiContract,
  tokenizeGovernedClient,
} from '../generated-module-api-boundary.mts';
import { maskNonCode } from '../scaffolding/shared.mts';

const endpointApi = (endpointPath: string, extra = '') =>
  `export const StockApi = HttpApi.make('StockApi').add(HttpApiGroup.make('stock').add(HttpApiEndpoint.post('execute', '${endpointPath}'), ${extra}));`;

const stockReadPath = '/reads/stock';

void test('balanced traversal ignores nested separators but preserves source offsets', () => {
  const source =
    "call({ nested: [1, 2], literal: ',);' }, /[,)]/, () => [3, 4]); next();";
  const structure = maskNonCode(source);
  const close = matchingDelimiter(structure, source.indexOf('('), '(', ')');
  assert.equal(close, source.indexOf('; next') - 1);
  // The semicolon in the string must not terminate the statement.
  assert.deepEqual(topLevelSeparators(structure, ';'), [
    source.indexOf('; next'),
    source.length - 1,
  ]);
  assert.deepEqual(
    separatedSource(
      source,
      topLevelSeparators(structure, ',', 5, close),
      5,
      close
    ),
    ["{ nested: [1, 2], literal: ',);' }", '/[,)]/', '() => [3, 4]']
  );
});

void test('generic parameter commas and arrow returns remain separate lexical concerns', () => {
  const source = 'value: Map<string, () => number>, next: number';
  assert.deepEqual(topLevelSeparators(source, ',', 0, source.length, true), [
    source.indexOf(', next'),
  ]);
  assert.deepEqual(
    topLevelSeparators('value < maximum; next > minimum;', ';'),
    [15, 31]
  );
  const depth = new DelimiterDepth();
  depth.update(']');
  assert.equal(depth.hasUnmatchedClose(), true);
  assert.equal(depth.isTopLevel(), false);
  assert.equal(toCamelCase('Stock-list'), 'stockList');
});

void test('token rescan retains nested template expressions and excludes regex punctuation', () => {
  const source = `const result = \`outer \${ { nested: \`inner \${value}\` } }\`; const pattern = /[},;]/;`;
  const kinds = tokenizeGovernedClient(source).map(({ kind }) => kind);
  assert.equal(
    kinds.filter((kind) => kind === SyntaxKind.TemplateTail).length,
    2
  );
  assert.equal(
    kinds.filter((kind) => kind === SyntaxKind.RegularExpressionLiteral).length,
    1
  );
  assert.equal(
    kinds.filter((kind) => kind === SyntaxKind.SemicolonToken).length,
    2
  );
});

void test('endpoint grammar shares only topology, preserving owner path and endpoint identity', () => {
  assert.equal(
    hasGeneratedModuleApiContract(
      endpointApi(stockReadPath),
      'StockApi',
      'stock',
      'stock'
    ),
    true
  );
  assert.equal(
    hasGeneratedProviderApiContract(
      endpointApi('/inventory.stock/reports/stock'),
      'StockApi',
      'inventory.stock',
      'stock',
      'report'
    ),
    true
  );
  assert.equal(
    hasGeneratedProviderApiContract(
      endpointApi(stockReadPath),
      'StockApi',
      'inventory.stock',
      'stock',
      'report'
    ),
    false
  );
  assert.equal(
    hasGeneratedModuleApiContract(
      endpointApi(stockReadPath, 'UnrelatedEndpoint'),
      'StockApi',
      'stock',
      'stock'
    ),
    false
  );
  assert.equal(
    hasGeneratedModuleApiContract(
      endpointApi(stockReadPath).replace("'execute'", "'bypass'"),
      'StockApi',
      'stock',
      'stock'
    ),
    false
  );
});
