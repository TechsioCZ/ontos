import assert from 'node:assert/strict';
import test from 'node:test';
import { compareApplicationCatalog, expectedCoreTableCatalog } from '../../src/db/catalog.ts';
import type { CatalogEntry } from '../../src/db/catalog.ts';

const exactCatalog = expectedCoreTableCatalog.map<CatalogEntry>((qualifiedName) => {
  const [schemaName, tableName] = qualifiedName.split('.');
  assert.equal((schemaName?.length ?? 0) > 0, true);
  assert.equal((tableName?.length ?? 0) > 0, true);
  if (schemaName === undefined || tableName === undefined) {
    throw new TypeError('Core catalog entries must be schema-qualified');
  }

  return {
    kind: 'table',
    schemaName,
    tableName,
  };
});

void test('reports one missing expected Core table', () => {
  const difference = compareApplicationCatalog(exactCatalog.slice(1));

  assert.deepEqual(difference.missing, [expectedCoreTableCatalog[0]]);
  assert.deepEqual(difference.unexpected, []);
});

void test('reports unexpected application tables and schemas', () => {
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
