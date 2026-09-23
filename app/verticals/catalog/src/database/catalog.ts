import { Array as EffectArray, Order } from 'effect';

import { CATALOG_SCHEMA_NAME, CATALOG_TABLE_INVENTORY } from './schema.ts';

const expectedCatalogTables = CATALOG_TABLE_INVENTORY.map((tableName) => `${CATALOG_SCHEMA_NAME}.${tableName}`);

export const compareCatalogTables = (qualifiedTableNames: readonly string[]) => {
  const expected = new Set(expectedCatalogTables);
  const actual = new Set(qualifiedTableNames);
  return {
    missing: EffectArray.sort(
      [...expected].filter((tableName) => !actual.has(tableName)),
      Order.String,
    ),
    unexpected: EffectArray.sort(
      [...actual].filter((tableName) => !expected.has(tableName)),
      Order.String,
    ),
  };
};
