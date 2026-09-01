import assert from 'node:assert/strict';
import test from 'node:test';
import { compareApplicationCatalog, expectedCoreTableCatalog } from '../../src/db/catalog.ts';
import type { CatalogEntry } from '../../src/db/catalog.ts';

const exactCatalog = expectedCoreTableCatalog.map<CatalogEntry>((qualifiedName) => {
  const [schemaName, tableName] = qualifiedName.split('.');
  assert.ok(schemaName);
  assert.ok(tableName);

  return {
    kind: 'table',
    schemaName,
    tableName,
  };
});

test('reports one missing expected Core table', () => {
  const difference = compareApplicationCatalog(exactCatalog.slice(1));

  assert.deepEqual(difference.missing, [expectedCoreTableCatalog[0]]);
  assert.deepEqual(difference.unexpected, []);
});

test('reports unexpected application tables and schemas', () => {
  const difference = compareApplicationCatalog([
    ...exactCatalog,
    {
      kind: 'table',
      schemaName: 'public',
      tableName: 'unexpected_table',
    },
    {
      kind: 'schema',
      schemaName: 'auth',
      tableName: null,
    },
  ]);

  assert.deepEqual(difference.missing, []);
  assert.deepEqual(difference.unexpected, ['auth.*', 'public.unexpected_table']);
});
