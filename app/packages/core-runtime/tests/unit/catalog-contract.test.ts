import { expect, it } from '@app/effect-rstest';
import { compareApplicationCatalog, expectedCoreTableCatalog } from '../../src/db/catalog.ts';
import type { CatalogEntry } from '../../src/db/catalog.ts';

const exactCatalog = expectedCoreTableCatalog.map<CatalogEntry>((qualifiedName) => {
  const [schemaName, tableName] = qualifiedName.split('.');
  expect((schemaName?.length ?? 0) > 0).toBe(true);
  expect((tableName?.length ?? 0) > 0).toBe(true);
  if (schemaName === undefined || tableName === undefined) {
    throw new TypeError('Core catalog entries must be schema-qualified');
  }

  return {
    kind: 'table',
    schemaName,
    tableName,
  };
});

it('reports one missing expected Core table', () => {
  const difference = compareApplicationCatalog(exactCatalog.slice(1));

  expect(difference.missing).toEqual([expectedCoreTableCatalog[0]]);
  expect(difference.unexpected).toEqual([]);
});

it('reports unexpected application tables and schemas', () => {
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

  expect(difference.missing).toEqual([]);
  expect(difference.unexpected).toEqual(['auth.*', 'public.unexpected_table']);
});
